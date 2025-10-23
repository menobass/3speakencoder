import { VideoJob } from '../types/index';
import { DirectJob } from '../types/DirectApi';
import { VideoProcessor } from './VideoProcessor';
import { GatewayClient } from './GatewayClient';
import { WebhookService } from './WebhookService';
import { JobQueue, QueuedJob } from './JobQueue';
import { JobStatus } from '../types/index';
import { logger } from './Logger';
import { cleanErrorForLogging } from '../common/errorUtils.js';

export class JobProcessor {
  private videoProcessor: VideoProcessor;
  private gatewayClient: GatewayClient;
  private webhookService: WebhookService;
  private jobQueue: JobQueue;

  constructor(
    videoProcessor: VideoProcessor,
    gatewayClient: GatewayClient,
    jobQueue: JobQueue
  ) {
    this.videoProcessor = videoProcessor;
    this.gatewayClient = gatewayClient;
    this.webhookService = new WebhookService();
    this.jobQueue = jobQueue;
  }

  async processJob(job: QueuedJob): Promise<void> {
    if (job.type === 'direct') {
      await this.processDirectJob(job as DirectJob);
    } else {
      await this.processGatewayJob(job as VideoJob);
    }
  }

  /**
   * 🚨 MEMORY SAFE: Fire-and-forget ping job to prevent promise accumulation
   */
  private safePingJob(jobId: string, status: any): void {
    // Use setImmediate to ensure this runs asynchronously without creating
    // a promise that could accumulate in memory during network issues
    setImmediate(async () => {
      try {
        await this.gatewayClient.pingJob(jobId, status);
      } catch (error: any) {
        // Log but don't propagate errors to prevent memory leaks
        const errorMsg = error?.message || error?.code || error?.toString() || 'Unknown error';
        logger.warn(`Failed to update gateway progress for ${jobId}: ${errorMsg}`);
      }
    });
  }

  private async processGatewayJob(job: VideoJob): Promise<void> {
    const jobId = job.id;
    
    try {
      logger.info(`🚀 Processing gateway job: ${jobId}`);

      // Accept the job with gateway
      await this.gatewayClient.acceptJob(jobId);
      
      // Update status to running
      await this.gatewayClient.pingJob(jobId, { status: JobStatus.RUNNING });

      // Process the video with progress callback
      const result = await this.videoProcessor.processVideo(job, (progress) => {
        this.jobQueue.updateProgress(jobId, progress.percent);
        
        // Update gateway with progress (fire-and-forget to prevent memory leaks)
        this.safePingJob(jobId, { 
          status: JobStatus.RUNNING,
          progress: progress.percent 
        });
      });

      // Upload results and complete job
      await this.gatewayClient.finishJob(jobId, result);
      this.jobQueue.completeJob(jobId, result);
      
      logger.info(`✅ Gateway job completed: ${jobId}`);
      logger.info(`🛡️ TANK MODE: Content uploaded, pinned, and announced to DHT`);

    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      logger.error(`❌ Gateway job ${jobId} failed:`, cleanErrorForLogging(error));
      
      try {
        await this.gatewayClient.failJob(jobId, {
          error: errorMessage,
          timestamp: new Date().toISOString()
        });
      } catch (reportError) {
        logger.error(`Failed to report gateway job failure for ${jobId}:`, reportError);
      }
      
      this.jobQueue.failJob(jobId, errorMessage);
    }
  }

  private async processDirectJob(job: DirectJob): Promise<void> {
    const jobId = job.id;
    const request = job.request;
    
    try {
      logger.info(`🚀 Processing direct job: ${jobId} (video: ${request.video_id})`);

      // Convert DirectJob to VideoJob format for processing
      const videoJob: VideoJob = {
        id: jobId,
        type: 'gateway', // Reuse existing processing logic
        status: JobStatus.RUNNING,
        created_at: job.created_at,
        input: {
          uri: request.input_uri,
          size: 0 // Unknown for direct jobs
        },
        metadata: {
          video_owner: 'direct-api',
          video_permlink: request.video_id
        },
        storageMetadata: {
          app: 'direct-api',
          key: request.video_id,
          type: 'direct'
        },
        profiles: this.generateProfilesFromRequest(request),
        output: [],
        progress: 0
      };

      // Process the video with progress callback
      const result = await this.videoProcessor.processVideo(videoJob, (progress) => {
        this.jobQueue.updateProgress(jobId, progress.percent);
      });

      // Complete the job
      this.jobQueue.completeJob(jobId, result);
      
      // Send webhook if URL provided
      if (request.webhook_url) {
        try {
          await this.webhookService.sendWebhook(request.webhook_url, {
            video_id: request.video_id,
            job_id: jobId,
            status: JobStatus.COMPLETE,
            result: result,
            timestamp: new Date().toISOString()
          });
        } catch (webhookError) {
          logger.warn(`⚠️ Webhook delivery failed for job ${jobId}:`, webhookError);
          // Don't fail the job for webhook failures
        }
      }
      
      logger.info(`✅ Direct job completed: ${jobId} (video: ${request.video_id})`);
      logger.info(`🛡️ TANK MODE: Content uploaded, pinned, and announced to DHT`);

    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      logger.error(`❌ Direct job ${jobId} failed:`, cleanErrorForLogging(error));
      
      this.jobQueue.failJob(jobId, errorMessage);
      
      // Send failure webhook if URL provided
      if (request.webhook_url) {
        try {
          await this.webhookService.sendWebhook(request.webhook_url, {
            video_id: request.video_id,
            job_id: jobId,
            status: JobStatus.FAILED,
            error: errorMessage,
            timestamp: new Date().toISOString()
          });
        } catch (webhookError) {
          logger.warn(`⚠️ Failure webhook delivery failed for job ${jobId}:`, webhookError);
        }
      }
    }
  }

  private generateProfilesFromRequest(request: DirectJob['request']) {
    const defaultProfiles = [
      { name: '1080p', size: '?x1080', width: 1920, height: 1080 },
      { name: '720p', size: '?x720', width: 1280, height: 720 },
      { name: '480p', size: '?x480', width: 854, height: 480 }
    ];

    if (request.profiles && request.profiles.length > 0) {
      return defaultProfiles.filter(profile => 
        request.profiles!.includes(profile.name)
      );
    }

    return defaultProfiles;
  }
}