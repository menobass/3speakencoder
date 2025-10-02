import { EncoderConfig } from '../config/ConfigLoader';
import { VideoJob, JobStatus, EncodingProgress, VideoProfile } from '../types';
import { logger } from './Logger';
import { GatewayClient } from './GatewayClient';
import { VideoProcessor } from './VideoProcessor';
import { IPFSService } from './IPFSService';
import { IdentityService } from './IdentityService';
import { DashboardService } from './DashboardService';
import { DirectApiService } from './DirectApiService';
import { JobQueue } from './JobQueue';
import { JobProcessor } from './JobProcessor.js';
import cron from 'node-cron';
import { randomUUID } from 'crypto';
import { cleanErrorForLogging } from '../common/errorUtils.js';

export class ThreeSpeakEncoder {
  private config: EncoderConfig;
  private gateway: GatewayClient;
  private processor: VideoProcessor;
  private ipfs: IPFSService;
  private identity: IdentityService;
  private dashboard?: DashboardService;
  private directApi?: DirectApiService;
  private jobQueue: JobQueue;
  private isRunning = false;
  private activeJobs = new Map<string, VideoJob>();
  private startTime = new Date();

  constructor(config: EncoderConfig, dashboard?: DashboardService) {
    this.config = config;
    if (dashboard) {
      this.dashboard = dashboard;
    }
    this.identity = new IdentityService(config);
    this.ipfs = new IPFSService(config);
    this.processor = new VideoProcessor(config, this.ipfs);
    this.gateway = new GatewayClient(config);
    this.jobQueue = new JobQueue(
      config.encoder?.max_concurrent_jobs || 1,
      5, // maxRetries (increased for gateway server issues)
      3 * 60 * 1000 // 3 minutes (reduced for faster recovery)
    );
    
    // Initialize DirectApiService if enabled
    if (config.direct_api?.enabled) {
      this.directApi = new DirectApiService(
        config.direct_api.port || 3002,
        config,
        this.jobQueue
      );
    }
  }

  async start(): Promise<void> {
    try {
      logger.info('🔧 Initializing services...');
      
      // Initialize all services
      await this.identity.initialize();
      logger.info('✅ Identity service ready');
      
      await this.ipfs.initialize();
      logger.info('✅ IPFS service ready');
      
      await this.processor.initialize();
      logger.info('✅ Video processor ready');
      
      // Set identity service for gateway client
      this.gateway.setIdentityService(this.identity);
      
      await this.gateway.initialize();
      logger.info('✅ Gateway client ready');
      
      // Start DirectApiService if enabled
      if (this.directApi) {
        await this.directApi.start();
        logger.info(`✅ Direct API service started on port ${this.config.direct_api?.port || 3002}`);
      }
      
      // Handle gateway mode based on configuration
      if (this.config.remote_gateway?.enabled !== false) {
        // Gateway mode enabled - try to register and start polling
        try {
          await this.registerNode();
          logger.info('✅ Node registered with gateway');
        } catch (error) {
          const errorMessage = error instanceof Error ? error.message : String(error);
          logger.warn('⚠️ Node registration failed, continuing without registration:', errorMessage);
          logger.info('🎯 Encoder will attempt to poll for jobs without registration');
        }
        
        // Start job polling for gateway jobs
        this.startJobPolling();
        logger.info('✅ Gateway job polling started');
      } else {
        // Gateway mode disabled - direct API only
        logger.info('🔌 Gateway mode disabled - running in Direct API only mode');
        logger.info('💡 This encoder will only process direct API requests');
        logger.info('📡 No connection to 3Speak gateway will be attempted');
      }
      
      this.isRunning = true;
      await this.updateDashboard();
      logger.info('🎯 3Speak Encoder is fully operational!');
      
    } catch (error) {
      logger.error('❌ Failed to start encoder:', error);
      throw error;
    }
  }

  private async updateDashboard(): Promise<void> {
    if (this.dashboard) {
      // Get IPFS peer ID asynchronously
      let peerId = 'Not connected';
      try {
        peerId = await this.ipfs.getPeerId();
      } catch (error) {
        logger.debug('Failed to get IPFS peer ID for dashboard:', error);
      }

      this.dashboard.updateNodeStatus({
        online: this.isRunning,
        registered: this.isRunning,
        didKey: this.identity?.getDIDKey() || 'Not initialized',
        ipfsPeerId: peerId,
        activeJobs: this.activeJobs.size,
        totalJobs: this.jobQueue.getTotalCount(),
        lastJobCheck: new Date().toISOString(),
        nodeName: this.config.node?.name || 'Unknown'
      });
    }
  }

  async stop(): Promise<void> {
    logger.info('🛑 Stopping encoder...');
    this.isRunning = false;
    await this.updateDashboard();
    
    // Stop DirectApiService if running
    if (this.directApi) {
      await this.directApi.stop();
      logger.info('✅ Direct API service stopped');
    }
    
    // Cancel all active jobs
    for (const [jobId, job] of this.activeJobs) {
      try {
        await this.gateway.rejectJob(jobId);
        logger.info(`📤 Rejected active job: ${jobId}`);
      } catch (error) {
        logger.warn(`Failed to reject job ${jobId}:`, error);
      }
    }
    
    this.activeJobs.clear();
    logger.info('✅ Encoder stopped');
  }



  private async registerNode(): Promise<void> {
    try {
      const peerId = await this.ipfs.getPeerId();
      const nodeInfo = {
        name: this.config.node.name,
        cryptoAccounts: this.config.node.cryptoAccounts || { hive: 'unknown' },
        peer_id: peerId,
        commit_hash: process.env.GIT_COMMIT || 'dev-build'
      };

      await this.gateway.updateNode(nodeInfo);
      logger.info('🆔 Node registered:', nodeInfo.name);
    } catch (error) {
      logger.error('❌ Failed to register node:', error);
      throw error;
    }
  }

  private startJobPolling(): void {
    // Poll for jobs every minute at random second to distribute load
    const randomSecond = Math.floor(Math.random() * 60);
    const cronPattern = `${randomSecond} * * * * *`;
    
    logger.info(`⏰ Scheduling job polling at second ${randomSecond} of every minute`);
    
    cron.schedule(cronPattern, async () => {
      if (!this.isRunning) return;
      
      try {
        await this.checkForNewJobs();
      } catch (error) {
        logger.warn('⚠️ Job polling failed:', error);
      }
    });

    // Start unified job processor for both queue and gateway jobs
    this.startJobProcessor();
    
    // Start dashboard heartbeat to keep status fresh
    this.startDashboardHeartbeat();
  }

  private startJobProcessor(): void {
    // Process jobs from JobQueue every 5 seconds
    cron.schedule('*/5 * * * * *', async () => {
      if (!this.isRunning) return;
      
      try {
        // Process retries first
        this.jobQueue.processRetries();
        // Then process new jobs
        await this.processQueuedJobs();
      } catch (error) {
        logger.warn('⚠️ Job processing failed:', error);
      }
    });

    // Check for stuck jobs every 10 minutes
    cron.schedule('*/10 * * * * *', async () => {
      if (!this.isRunning) return;
      
      try {
        await this.detectAndHandleStuckJobs();
      } catch (error) {
        logger.warn('⚠️ Stuck job detection failed:', error);
      }
    });
  }

  private startDashboardHeartbeat(): void {
    // Update dashboard status every 30 seconds to keep it fresh
    cron.schedule('*/30 * * * * *', async () => {
      if (!this.isRunning) return;
      
      try {
        await this.updateDashboard();
        logger.debug('📊 Dashboard heartbeat sent');
      } catch (error) {
        logger.debug('⚠️ Dashboard heartbeat failed:', error);
      }
    });
  }

  private async detectAndHandleStuckJobs(): Promise<void> {
    const stuckJobs = this.jobQueue.detectStuckJobs(3600000); // 1 hour
    
    for (const jobId of stuckJobs) {
      const job = this.jobQueue.getJob(jobId);
      if (!job) continue;

      logger.warn(`🚨 Detected stuck job: ${jobId} (active for over 1 hour)`);
      
      // For gateway jobs, try to reject them to release them back to the queue
      if (job.type !== 'direct') {
        try {
          await this.gateway.rejectJob(jobId);
          logger.info(`✅ Released stuck gateway job back to queue: ${jobId}`);
        } catch (error) {
          logger.warn(`⚠️ Failed to reject stuck job ${jobId}:`, error);
        }
      }
      
      // Abandon the job locally
      this.jobQueue.abandonJob(jobId, 'Job stuck for over 1 hour');
      
      // Update dashboard
      if (this.dashboard) {
        this.dashboard.failJob(jobId, 'Job abandoned due to timeout');
      }
    }
  }

  private isRetryableError(error: any): boolean {
    const errorMessage = error instanceof Error ? error.message : String(error);
    const statusCode = error?.status || error?.response?.status;
    
    // Network/communication errors are usually retryable
    if (errorMessage.includes('ENOTFOUND') || errorMessage.includes('ECONNREFUSED') || 
        errorMessage.includes('timeout') || errorMessage.includes('network')) {
      return true;
    }
    
    // HTTP 500 series errors are usually retryable (server issues)
    if (statusCode >= 500 && statusCode < 600) {
      return true;
    }
    
    // HTTP 429 (rate limiting) is retryable
    if (statusCode === 429) {
      return true;
    }
    
    // HTTP 4xx errors (except 408 timeout) are usually not retryable (client errors)
    if (statusCode >= 400 && statusCode < 500 && statusCode !== 408) {
      return false;
    }
    
    // IPFS/FFmpeg processing errors are usually not retryable
    if (errorMessage.includes('ffmpeg') || errorMessage.includes('No such file')) {
      return false;
    }
    
    // Default to retryable for unknown errors
    return true;
  }

  private async processQueuedJobs(): Promise<void> {
    // Check if we can process more jobs
    if (this.activeJobs.size >= (this.config.encoder?.max_concurrent_jobs || 1)) {
      return;
    }

    // Get next job from unified queue
    const job = this.jobQueue.getNextJob();
    if (!job) {
      return; // No jobs available
    }

    logger.info(`🚀 Starting job: ${job.id} (${job.type || 'gateway'})`);
    
    try {
      if (job.type === 'direct') {
        // Process direct API job
        await this.processDirectJob(job);
      } else {
        // Process gateway job
        await this.processGatewayJob(job);
      }
    } catch (error) {
      logger.error(`❌ Job ${job.id} failed:`, error);
      
      // Determine if this error is retryable
      const isRetryable = this.isRetryableError(error);
      const errorMessage = error instanceof Error ? error.message : String(error);
      
      // Fail job with retry logic
      this.jobQueue.failJob(job.id, errorMessage, isRetryable);
      
      // Update dashboard with job failure
      if (this.dashboard) {
        const retryInfo = this.jobQueue.getRetryInfo(job.id);
        if (retryInfo && retryInfo.attempts < retryInfo.maxAttempts) {
          // Job will be retried
          this.dashboard.updateJobProgress(job.id, 0, 'retry-pending', {
            error: errorMessage,
            retryAttempt: retryInfo.attempts,
            maxAttempts: retryInfo.maxAttempts,
            nextRetry: retryInfo.nextRetry
          });
        } else {
          // Job permanently failed
          this.dashboard.failJob(job.id, errorMessage);
        }
      }
    }
  }

  private async processDirectJob(job: any): Promise<void> {
    this.activeJobs.set(job.id, job);
    
    // Start job tracking in dashboard
    if (this.dashboard) {
      this.dashboard.startJob(job.id, {
        type: 'direct-api',
        video_id: job.request.video_id,
        input_uri: job.request.input_uri,
        profiles: job.request.profiles || ['1080p', '720p', '480p'],
        webhook_url: job.request.webhook_url
      });
    }
    
    await this.updateDashboard();

    try {
      // Convert DirectJob to VideoJob format for processing
      const videoJob: VideoJob = {
        id: job.id,
        type: 'gateway', // Use existing type
        status: JobStatus.QUEUED,
        created_at: new Date().toISOString(),
        input: {
          uri: job.request.input_uri,
          size: 0 // Will be determined during download
        },
        metadata: {
          video_owner: 'direct-api',
          video_permlink: job.request.video_id
        },
        storageMetadata: {
          app: 'direct-api',
          key: job.request.video_id,
          type: 'direct'
        },
        profiles: this.getProfilesForJob(job.request.profiles || ['1080p', '720p', '480p']),
        output: []
      };

      // Process video using existing VideoProcessor
      const result = await this.processor.processVideo(videoJob);
      
      // Complete the job
      this.jobQueue.completeJob(job.id, result);
      
      // Complete job tracking in dashboard
      if (this.dashboard) {
        this.dashboard.completeJob(job.id, result);
      }
      
      logger.info(`✅ Direct job completed: ${job.id}`);
      
      // TODO: Send webhook notification if webhook_url provided
      if (job.request.webhook_url) {
        // WebhookService integration would go here
        logger.info(`🔔 Webhook notification needed for ${job.request.webhook_url}`);
      }
      
    } finally {
      this.activeJobs.delete(job.id);
      await this.updateDashboard();
    }
  }

  private async processGatewayJob(job: any): Promise<void> {
    const jobId = job.id;
    this.activeJobs.set(jobId, job);
    
    // Check if this job has cached results from previous attempt
    const cachedResult = this.jobQueue.getCachedResult(jobId);
    
    // Start job tracking in dashboard
    if (this.dashboard) {
      this.dashboard.startJob(job.id, {
        type: 'gateway',
        video_id: job.metadata?.video_permlink || job.id,
        input_uri: job.input?.uri || 'unknown',
        profiles: job.profiles?.map((p: any) => p.name) || ['1080p', '720p', '480p']
      });
    }
    
    await this.updateDashboard();
    
    try {
      // Accept the job with gateway
      await this.gateway.acceptJob(jobId);
      logger.info(`✅ Accepted gateway job: ${jobId}`);

      // Update status to running
      job.status = JobStatus.RUNNING;
      await this.gateway.pingJob(jobId, { status: JobStatus.RUNNING });

      let result: any;
      
      if (cachedResult) {
        logger.info(`🚀 SMART RETRY: Using cached result from previous attempt for ${jobId}`);
        logger.info(`💾 Skipping download/encode/upload - content already pinned and announced!`);
        result = cachedResult;
        
        // Update progress to show we're at completion phase
        if (this.dashboard) {
          this.dashboard.updateJobProgress(job.id, 95, 'notifying-gateway');
        }
      } else {
        // Process the video using the unified processor
        result = await this.processor.processVideo(job, (progress: EncodingProgress) => {
          // Update progress in dashboard
          if (this.dashboard) {
            this.dashboard.updateJobProgress(job.id, progress.percent);
          }
          
          // Update progress with gateway
          this.gateway.pingJob(jobId, { 
            status: JobStatus.RUNNING,
            progress: progress.percent 
          }).catch((err: any) => logger.warn('Failed to update gateway progress:', err));
        });
        
        // Cache the result before attempting gateway notification
        this.jobQueue.cacheResult(jobId, result);
        logger.info(`💾 Cached processing result for potential retry: ${jobId}`);
      }

      // Transform result to gateway-expected format
      const masterOutput = result[0];
      if (!masterOutput) {
        throw new Error('No master playlist output received from video processor');
      }
      
      const gatewayResult = {
        ipfs_hash: masterOutput.ipfsHash,
        master_playlist: masterOutput.uri
      };
      
      logger.info(`📋 Sending result to gateway: ${JSON.stringify(gatewayResult)}`);
      
      // Complete the job with gateway
      const finishResponse = await this.gateway.finishJob(jobId, gatewayResult);
      
      // Clear cached result on successful completion
      this.jobQueue.clearCachedResult(jobId);
      
      // Complete job tracking
      this.jobQueue.completeJob(jobId, result);
      if (this.dashboard) {
        this.dashboard.completeJob(jobId, result);
      }
      
      logger.info(`🎉 Gateway job completed: ${jobId}`);
      logger.info(`🛡️ TANK MODE: Content uploaded, pinned, and announced to DHT`);

    } catch (error) {
      logger.error(`❌ Gateway job ${jobId} failed:`, cleanErrorForLogging(error));
      
      // Determine if this is a retryable error
      const errorMessage = error instanceof Error ? error.message : String(error);
      const isRetryable = this.isRetryableError(error);
      
      // Report failure to gateway (but don't let gateway reporting errors affect retry logic)
      try {
        await this.gateway.failJob(jobId, {
          error: errorMessage,
          timestamp: new Date().toISOString(),
          retryable: isRetryable
        });
        logger.info(`📤 Reported job failure to gateway: ${jobId}`);
      } catch (reportError) {
        logger.warn(`⚠️ Failed to report job failure to gateway for ${jobId}:`, reportError);
        // Don't throw here - we still want to handle the original job failure with retry logic
      }
      
      throw error; // Re-throw to be handled by the main job processor
    } finally {
      this.activeJobs.delete(jobId);
      await this.updateDashboard();
    }
  }

  private getProfilesForJob(profiles: string[]) {
    const profileMap: { [key: string]: any } = {
      '1080p': { name: '1080p', size: '?x1080', width: 1920, height: 1080, bitrate: '4000k' },
      '720p': { name: '720p', size: '?x720', width: 1280, height: 720, bitrate: '2500k' },
      '480p': { name: '480p', size: '?x480', width: 854, height: 480, bitrate: '1000k' }
    };
    
    return profiles.map(p => profileMap[p] || profileMap['720p']);
  }

  private async checkForNewJobs(): Promise<void> {
    try {
      // First, update dashboard with available jobs and gateway stats
      await this.updateDashboardWithGatewayInfo();
      
      // Then check if we can accept more jobs
      if (this.activeJobs.size >= (this.config.encoder?.max_concurrent_jobs || 1)) {
        logger.debug('🔄 Max concurrent jobs reached, skipping job acquisition');
        return;
      }

      const job = await this.gateway.getJob();
      if (job) {
        logger.info(`📥 Received new gateway job: ${job.id}`);
        // Add gateway job to queue for processing (non-blocking)
        this.jobQueue.addGatewayJob(job);
        logger.info(`📝 Gateway job ${job.id} added to processing queue`);
      } else {
        logger.debug('🔍 No gateway jobs assigned to us');
      }
    } catch (error) {
      logger.warn('⚠️ Gateway polling failed:', error);
      
      // Update dashboard with gateway disconnection
      if (this.dashboard) {
        this.dashboard.updateGatewayStatus(false);
      }
    }
  }

  private async updateDashboardWithGatewayInfo(): Promise<void> {
    if (!this.dashboard) return;

    try {
      // Get available jobs and gateway stats
      const [availableJobs, gatewayStats] = await Promise.all([
        this.gateway.getAvailableJobs(),
        this.gateway.getGatewayStats()
      ]);

      // Update dashboard with available jobs
      this.dashboard.updateAvailableJobs(availableJobs);
      
      // Update gateway connection status
      this.dashboard.updateGatewayStatus(true, gatewayStats);
      
      logger.debug(`📊 Dashboard updated: ${availableJobs.length} available jobs`);
    } catch (error) {
      logger.debug('⚠️ Failed to update dashboard with gateway info:', error);
      this.dashboard.updateGatewayStatus(false);
    }
  }

  private async processJob(job: VideoJob): Promise<void> {
    const jobId = job.id;
    
    try {
      // Accept the job
      await this.gateway.acceptJob(jobId);
      this.activeJobs.set(jobId, job);
      logger.info(`✅ Accepted job: ${jobId}`);

      // Update status to running
      job.status = JobStatus.RUNNING;
      await this.gateway.pingJob(jobId, { status: JobStatus.RUNNING });

      // Process the video
      const result = await this.processor.processVideo(job, (progress: EncodingProgress) => {
        // Update progress
        this.gateway.pingJob(jobId, { 
          status: JobStatus.RUNNING,
          progress: progress.percent 
        }).catch((err: any) => logger.warn('Failed to update progress:', err));
      });

      // Transform result to gateway-expected format
      const masterOutput = result[0];
      if (!masterOutput) {
        throw new Error('No master playlist output received from video processor');
      }
      
      const gatewayResult = {
        ipfs_hash: masterOutput.ipfsHash,
        master_playlist: masterOutput.uri
      };
      
      logger.info(`📋 Sending result to gateway: ${JSON.stringify(gatewayResult)}`);
      
      // Upload results and complete job  
      const finishResponse = await this.gateway.finishJob(jobId, gatewayResult);
      logger.info(`🎉 Completed job: ${jobId}`);
      logger.info(`🛡️ TANK MODE: Content uploaded, pinned, and announced to DHT`);

    } catch (error) {
      logger.error(`❌ Job ${jobId} failed:`, error);
      
      try {
        await this.gateway.failJob(jobId, {
          error: error instanceof Error ? error.message : 'Unknown error',
          timestamp: new Date().toISOString()
        });
      } catch (reportError) {
        logger.error(`Failed to report job failure for ${jobId}:`, reportError);
      }
    } finally {
      this.activeJobs.delete(jobId);
    }
  }

  /**
   * Manually release a stuck job
   */
  async releaseStuckJob(jobId: string): Promise<void> {
    logger.info(`🔧 Attempting to release stuck job: ${jobId}`);
    
    try {
      // Try to reject the job in the gateway to release it
      await this.gateway.rejectJob(jobId);
      logger.info(`✅ Successfully released job ${jobId} in gateway`);
    } catch (error) {
      logger.warn(`⚠️ Failed to reject job ${jobId} in gateway:`, error);
    }

    // Remove from our local tracking
    this.activeJobs.delete(jobId);
    this.jobQueue.abandonJob(jobId, 'Manual release of stuck job');
    
    // Update dashboard
    if (this.dashboard) {
      this.dashboard.failJob(jobId, 'Manually released stuck job');
    }
    
    logger.info(`🧹 Cleaned up local references for job: ${jobId}`);
  }

  /**
   * Manually process a specific job by job ID
   */
  async processManualJob(jobId: string): Promise<void> {
    logger.info(`🎯 Attempting to manually process job: ${jobId}`);
    
    try {
      // First check if job exists and get its status
      const jobStatus = await this.gateway.getJobStatus(jobId);
      
      if (!jobStatus) {
        throw new Error(`Job ${jobId} not found in gateway`);
      }
      
      logger.info(`📋 Job ${jobId} status: ${jobStatus.status || 'unknown'}`);
      
      // Try to accept the job (this will work if job is available/unassigned)
      await this.gateway.acceptJob(jobId);
      logger.info(`✅ Manually accepted job: ${jobId}`);
      
      // The job will be picked up by our regular polling mechanism
      // since it's now assigned to our node
      logger.info(`🎬 Job ${jobId} should be picked up by next polling cycle`);
      
    } catch (error) {
      logger.error(`❌ Failed to manually process job ${jobId}:`, error);
      
      // Update dashboard with failure
      if (this.dashboard) {
        this.dashboard.failJob(jobId, `Manual processing failed: ${error instanceof Error ? error.message : 'Unknown error'}`);
      }
      
      throw error;
    }
  }

  /**
   * Manually complete a job that was processed but failed to report completion
   */
  async manualCompleteJob(jobId: string, result: any): Promise<void> {
    logger.info(`🏁 Attempting to manually complete job: ${jobId}`);
    
    try {
      // Call the gateway finishJob API directly
      const finishResponse = await this.gateway.finishJob(jobId, result);
      logger.info(`✅ Successfully completed job ${jobId} manually`);
      logger.info(`🎉 Gateway response:`, finishResponse);
      
      // Update dashboard
      if (this.dashboard) {
        this.dashboard.completeJob(jobId, finishResponse);
      }
      
    } catch (error) {
      logger.error(`❌ Failed to manually complete job ${jobId}:`, error);
      
      // Update dashboard with failure
      if (this.dashboard) {
        this.dashboard.failJob(jobId, `Manual completion failed: ${error instanceof Error ? error.message : 'Unknown error'}`);
      }
      
      throw error;
    }
  }
}