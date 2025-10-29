import { EncoderConfig } from '../config/ConfigLoader.js';
import { VideoJob, JobStatus, EncodingProgress, VideoProfile } from '../types/index.js';
import { logger } from './Logger.js';
import { GatewayClient } from './GatewayClient.js';
import { VideoProcessor } from './VideoProcessor.js';
import { IPFSService } from './IPFSService.js';
import { IdentityService } from './IdentityService.js';
import { DashboardService } from './DashboardService.js';
import { DirectApiService } from './DirectApiService.js';
import { JobQueue } from './JobQueue.js';
import { JobProcessor } from './JobProcessor.js';
import { PendingPinService } from './PendingPinService.js';
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
  private pendingPinService: PendingPinService;
  private isRunning: boolean = false;
  private activeJobs: Map<string, any> = new Map();
  private gatewayFailureCount: number = 0;
  private readonly maxGatewayFailures: number = 3; // Mark offline after 3 consecutive failures
  private lastGatewaySuccess: Date = new Date();
  private startTime = new Date();

  constructor(config: EncoderConfig, dashboard?: DashboardService) {
    this.config = config;
    if (dashboard) {
      this.dashboard = dashboard;
    }
    this.identity = new IdentityService(config);
    this.ipfs = new IPFSService(config);
    this.processor = new VideoProcessor(config, this.ipfs, dashboard);
    this.gateway = new GatewayClient(config);
    this.jobQueue = new JobQueue(
      config.encoder?.max_concurrent_jobs || 1,
      5, // maxRetries (increased for gateway server issues)
      3 * 60 * 1000 // 3 minutes (reduced for faster recovery)
    );
    // 🏠 Pass config and IPFS client for local fallback support
    this.pendingPinService = new PendingPinService('./data', config, this.ipfs.getClient());
    
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
      
      await this.pendingPinService.initialize();
      logger.info('✅ Pending pin service ready');
      
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
      // Reset gateway failure tracking on successful start
      this.gatewayFailureCount = 0;
      this.lastGatewaySuccess = new Date();
      
      // Start background lazy pinning
      this.startLazyPinning();
      
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

      // Determine gateway status based on failure count
      const isGatewayOnline = this.gatewayFailureCount < this.maxGatewayFailures;

      this.dashboard.updateNodeStatus({
        online: this.isRunning,
        registered: this.isRunning,
        didKey: this.identity?.getDIDKey() || 'Not initialized',
        ipfsPeerId: peerId,
        activeJobs: this.activeJobs.size,
        totalJobs: this.jobQueue.getTotalCount(),
        lastJobCheck: new Date().toISOString(),
        nodeName: this.config.node?.name || 'Unknown',
        gatewayStatus: {
          connected: isGatewayOnline,
          failureCount: this.gatewayFailureCount,
          maxFailures: this.maxGatewayFailures,
          lastSuccess: this.lastGatewaySuccess.toISOString(),
          timeSinceLastSuccess: Date.now() - this.lastGatewaySuccess.getTime()
        }
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
    // Update dashboard status every 30 seconds, or every 10 seconds if gateway has issues
    const updateInterval = this.gatewayFailureCount > 0 ? 10 : 30;
    const cronPattern = `*/${updateInterval} * * * * *`;
    
    // Cancel any existing heartbeat first
    if ((this as any)._heartbeatJob) {
      (this as any)._heartbeatJob.destroy();
    }
    
    (this as any)._heartbeatJob = cron.schedule(cronPattern, async () => {
      if (!this.isRunning) return;
      
      try {
        await this.updateDashboard();
        logger.debug('📊 Dashboard heartbeat sent');
      } catch (error) {
        logger.debug('⚠️ Dashboard heartbeat failed:', error);
      }
    });
    
    logger.info(`💓 Dashboard heartbeat started (${updateInterval}s interval)`);
    
    // 🚨 FIX: Start memory management timer
    this.startMemoryManagement();
  }

  private startMemoryManagement(): void {
    setInterval(() => {
      // Clean up old cached results
      this.jobQueue.cleanupOldCache();
      
      // Monitor memory usage
      const usage = process.memoryUsage();
      const heapMB = Math.round(usage.heapUsed / 1024 / 1024);
      const totalMB = Math.round(usage.heapTotal / 1024 / 1024);
      
      logger.debug(`🧠 Memory: ${heapMB}MB heap / ${totalMB}MB total`);
      
      if (heapMB > 1500) { // Warn at 1.5GB
        logger.warn(`⚠️ HIGH MEMORY USAGE: ${heapMB}MB heap / ${totalMB}MB total - potential leak!`);
        
        // Force garbage collection if available
        if (global.gc) {
          global.gc();
          const newUsage = process.memoryUsage();
          const newHeapMB = Math.round(newUsage.heapUsed / 1024 / 1024);
          logger.info(`🗑️ Forced GC: ${heapMB}MB → ${newHeapMB}MB (freed ${heapMB - newHeapMB}MB)`);
        }
      }
      
      // 🚨 EMERGENCY: Kill encoder if memory gets critically high
      if (heapMB > 10000) { // 10GB emergency limit
        logger.error(`🚨 CRITICAL MEMORY LEAK DETECTED: ${heapMB}MB heap usage!`);
        logger.error(`🚨 This indicates a serious memory leak - encoder will restart to prevent crash`);
        
        // Log active jobs for debugging
        logger.error(`🚨 Active jobs: ${Array.from(this.activeJobs.keys()).join(', ')}`);
        
        // Kill any active FFmpeg processes
        import('child_process').then(({ exec }) => {
          exec('pkill -9 ffmpeg', (error) => {
            if (error) {
              logger.warn('Could not kill FFmpeg processes:', error.message);
            } else {
              logger.info('🔪 Killed all FFmpeg processes');
            }
            
            // Exit with error code to trigger restart
            process.exit(1);
          });
        }).catch(() => {
          // If we can't kill FFmpeg processes, just exit
          process.exit(1);
        });
      }
    }, 5 * 60 * 1000); // Every 5 minutes
    
    logger.info(`🧠 Memory management started (5min intervals)`);
  }

  /**
   * 🚨 MEMORY SAFE: Fire-and-forget ping job to prevent promise accumulation
   */
  private safePingJob(jobId: string, status: any): void {
    // Use setImmediate to ensure this runs asynchronously without creating
    // a promise that could accumulate in memory during network issues
    setImmediate(async () => {
      try {
        await this.gateway.pingJob(jobId, status);
      } catch (error: any) {
        // Log but don't propagate errors to prevent memory leaks
        const errorMsg = error?.message || error?.code || error?.toString() || 'Unknown error';
        logger.warn(`Failed to update gateway progress for ${jobId}: ${errorMsg}`);
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
      logger.error(`❌ Job ${job.id} failed:`, cleanErrorForLogging(error));
      
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
    const ourDID = this.identity.getDIDKey();
    let ownershipCheckInterval: NodeJS.Timeout | null = null;
    
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
      // Accept the job with gateway (atomic claim operation)
      await this.gateway.acceptJob(jobId);
      logger.info(`✅ Accepted gateway job: ${jobId}`);

      // 🔒 CRITICAL OWNERSHIP VALIDATION: Verify we successfully claimed the job
      let jobStatus: any;
      
      try {
        jobStatus = await this.gateway.getJobStatus(jobId);
        logger.info(`🔍 Job ${jobId} status after accept: assigned_to=${jobStatus.assigned_to || 'null'}, status=${jobStatus.status || 'unknown'}`);
        
        // After acceptJob(), the job MUST be assigned to us
        if (jobStatus.assigned_to !== ourDID) {
          const actualOwner = jobStatus.assigned_to || 'unassigned/null';
          
          if (!jobStatus.assigned_to) {
            logger.error(`🚨 CLAIM FAILED: Job ${jobId} is still unassigned after acceptJob() - gateway may have rejected our claim`);
          } else {
            logger.error(`🚨 RACE CONDITION: Job ${jobId} is assigned to ${actualOwner}, but we called acceptJob() first`);
            logger.error(`🚨 Another encoder won the race condition! This indicates high competition for jobs.`);
          }
          
          // Gracefully handle the conflict without throwing
          this.jobQueue.failJob(jobId, `Failed to claim job: assigned_to=${actualOwner}, expected=${ourDID}`, false);
          return;
        }
        
        if (jobStatus.status !== 'assigned') {
          logger.warn(`⚠️ Unexpected job status after accept: ${jobStatus.status} (expected 'assigned')`);
        }
        
        logger.info(`✅ Successfully claimed job ${jobId} - confirmed ownership and proceeding with work`);
        
      } catch (statusError) {
        logger.error(`❌ OWNERSHIP_VERIFICATION_FAILED: Cannot verify job ${jobId} ownership:`, statusError);
        logger.warn(`🛡️ DEFENSIVE: This could indicate gateway API issues - proceeding with extreme caution`);
        logger.warn(`📊 TELEMETRY: Gateway getJobStatus API failure after successful acceptJob`);
        
        // 🛡️ DEFENSIVE: If we can't verify ownership, we should be extra cautious
        // Log this as a potential gateway inconsistency but continue since acceptJob() succeeded
        logger.info(`⚠️ RISK_ASSESSMENT: Continuing since acceptJob() succeeded, but monitoring for conflicts`);
      }
      
      // 🛡️ DEFENSIVE: Additional safety check - verify we're not processing someone else's job
      // This catches race conditions that might have occurred after our ownership check
      logger.info(`🔒 SAFETY_CHECK: Job ${jobId} processing started by encoder ${ourDID}`);
      logger.info(`⏱️ TIMESTAMP: ${new Date().toISOString()} - Starting processing phase`);
      
      // 🛡️ DEFENSIVE: Set up periodic ownership verification during processing
      const startOwnershipMonitoring = () => {
        ownershipCheckInterval = setInterval(async () => {
          try {
            const currentStatus = await this.gateway.getJobStatus(jobId);
            if (currentStatus.assigned_to !== ourDID) {
              logger.error(`🚨 OWNERSHIP_HIJACK_DETECTED: Job ${jobId} reassigned during processing!`);
              logger.error(`📊 CRITICAL_BUG: assigned_to changed from ${ourDID} to ${currentStatus.assigned_to}`);
              logger.error(`🛑 ABORTING: Stopping processing to prevent duplicate work`);
              
              // Clear the interval and abort processing
              if (ownershipCheckInterval) clearInterval(ownershipCheckInterval);
              throw new Error(`Job ownership hijacked: assigned_to=${currentStatus.assigned_to}, expected=${ourDID}`);
            }
          } catch (error) {
            // Don't abort on verification errors, just log them
            logger.warn(`⚠️ Periodic ownership check failed for job ${jobId}:`, error);
          }
        }, 60000); // Check every minute during processing
      };
      
      // Start monitoring (will be cleared in finally block)
      startOwnershipMonitoring();

      // Update status to running using legacy-compatible format
      job.status = JobStatus.RUNNING;
      await this.gateway.pingJob(jobId, { 
        progressPct: 1.0,    // ⚠️ CRITICAL: Must be > 1 to trigger gateway status change
        download_pct: 100    // Download complete at this point
      });

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
        // Set current job ID for dashboard progress tracking
        this.processor.setCurrentJob(job.id);
        
        // Process the video using the unified processor
        result = await this.processor.processVideo(job, (progress: EncodingProgress) => {
          // Update progress in dashboard
          if (this.dashboard) {
            this.dashboard.updateJobProgress(job.id, progress.percent);
          }
          
          // Update progress with gateway (fire-and-forget to prevent memory leaks) - LEGACY FORMAT
          this.safePingJob(jobId, { 
            progress: progress.percent,        // Our internal format
            progressPct: progress.percent,     // Legacy gateway format
            download_pct: 100                  // Download always complete during encoding
          });
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
      
      // 🛡️ TANK MODE: Final verification before reporting to gateway
      logger.info(`🛡️ TANK MODE: Final persistence verification before gateway notification`);
      logger.info(`🔍 DEBUG: About to verify persistence for CID: ${masterOutput.ipfsHash}`);
      
      try {
        logger.info(`🔍 DEBUG: Starting verifyContentPersistence...`);
        const isContentPersisted = await this.ipfs.verifyContentPersistence(masterOutput.ipfsHash);
        logger.info(`🔍 DEBUG: Verification result: ${isContentPersisted}`);
        
        if (!isContentPersisted) {
          // 🛡️ FALLBACK: Try a simpler verification (just pin status)
          logger.warn(`⚠️ Detailed verification failed, trying simpler check...`);
          const threeSpeakIPFS = this.config.ipfs?.threespeak_endpoint || 'http://65.21.201.94:5002';
          const axios = await import('axios');
          
          const pinResponse = await axios.default.post(
            `${threeSpeakIPFS}/api/v0/pin/ls?arg=${masterOutput.ipfsHash}&type=all`,
            null,
            { timeout: 15000 }
          );
          
          const pinData = typeof pinResponse.data === 'string' 
            ? JSON.parse(pinResponse.data) 
            : pinResponse.data;
          
          if (pinData?.Keys?.[masterOutput.ipfsHash]) {
            logger.info(`✅ Fallback verification: Content is pinned, proceeding with gateway notification`);
          } else {
            throw new Error(`CRITICAL: Content ${masterOutput.ipfsHash} failed both detailed and fallback verification!`);
          }
        } else {
          logger.info(`✅ Content persistence verified - safe to report to gateway`);
        }
        
      } catch (verifyError: any) {
        // 🚨 Last resort: If verification completely fails, log but don't fail the job
        // (Content was uploaded successfully, verification might be having issues)
        logger.error(`❌ Verification failed: ${verifyError.message}`);
        logger.error(`🔍 DEBUG: Verification error details:`, verifyError);
        logger.warn(`🆘 PROCEEDING ANYWAY - Content was uploaded successfully, verification may have issues`);
        logger.warn(`🔍 Manual check recommended for hash: ${masterOutput.ipfsHash}`);
      }
      logger.info(`🔍 DEBUG: Verification phase complete, proceeding to gateway notification...`);
      logger.info(`📋 Sending result to gateway: ${JSON.stringify(gatewayResult)}`);
      
      // Complete the job with gateway
      logger.info(`🔍 DEBUG: About to call gateway.finishJob for ${jobId}...`);
      const finishResponse = await this.gateway.finishJob(jobId, gatewayResult);
      logger.info(`🔍 DEBUG: Gateway finishJob response received:`, finishResponse);
      
      // 🚨 FIX: Always clear cached result to prevent memory leak
      this.jobQueue.clearCachedResult(jobId);
      
      // Check if this was a duplicate completion (job already done by another encoder)
      if (finishResponse.duplicate) {
        logger.info(`🎯 Job ${jobId} was already completed by another encoder - our work was successful but redundant`);
        logger.info(`💡 This is normal in distributed systems - another encoder got there first`);
        this.jobQueue.completeJob(jobId, result);
        if (this.dashboard) {
          this.dashboard.completeJob(jobId, result);
        }
        
        logger.info(`✅ Job ${jobId} marked as completed (duplicate completion handled)`);
        return; // Exit early - don't throw error
      }
      
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
      
      // Determine if this is a retryable error and handle race conditions
      const errorMessage = error instanceof Error ? error.message : String(error);
      let isRetryable = this.isRetryableError(error);
      
      // 🛡️ DEFENSIVE: Enhanced gateway race condition detection and telemetry
      if (errorMessage.includes('no longer available') || errorMessage.includes('already assigned')) {
        logger.info(`🏃‍♂️ GATEWAY_RACE_CONDITION: Job ${jobId} was claimed by another encoder`);
        logger.info(`📊 TELEMETRY: Gateway race condition detected - evidence of gateway atomic operation bug`);
        logger.info(`🔍 DIAGNOSIS: This should return HTTP 409, not generic error message`);
        isRetryable = false; // Don't retry race conditions
        
      } else if (errorMessage.includes('status code 502')) {
        // 🚨 CRITICAL: HTTP 502 Bad Gateway - service is completely down
        logger.error(`💥 GATEWAY_COMPLETELY_DOWN: HTTP 502 for job ${jobId} - gateway service is offline`);
        logger.error(`🔍 DIAGNOSIS: nginx cannot connect to gateway backend service`);
        logger.error(`🛠️ REQUIRED_ACTION: Gateway admin must fix Docker/systemd service immediately`);
        logger.error(`⚠️ IMPACT: All encoders cannot get jobs until gateway is restored`);
        isRetryable = true; // Retry infrastructure failures
        
      } else if (errorMessage.includes('status code 500')) {
        // 🛡️ DEFENSIVE: HTTP 500 during acceptJob likely indicates race condition disguised as server error
        logger.error(`🚨 GATEWAY_API_BUG: HTTP 500 for job ${jobId} during acceptJob - likely race condition disguised as server error`);
        logger.error(`📊 CRITICAL_EVIDENCE: Gateway fails to communicate job ownership information`);
        logger.error(`🔍 EXPECTED_BEHAVIOR: Should return HTTP 409 with message "Job already assigned to encoder_xyz"`);
        logger.error(`🔍 ACTUAL_BEHAVIOR: Returns HTTP 500 with generic error, hiding ownership details`);
        logger.error(`🔍 ROOT_CAUSE: Gateway acceptJob() API lacks proper conflict handling`);
        logger.error(`💡 IMPACT: Forces encoders to guess job state instead of receiving clear ownership info`);
        logger.error(`🛠️ REQUIRED_FIX: Gateway must return HTTP 409 + ownership details for assigned jobs`);
        
        // 🔍 FORENSIC: Try to get actual job status to prove this was a hidden race condition
        try {
          logger.info(`🔍 FORENSIC_INVESTIGATION: Checking actual job status after HTTP 500...`);
          const forensicStatus = await this.gateway.getJobStatus(jobId);
          if (forensicStatus.assigned_to && forensicStatus.assigned_to !== ourDID) {
            logger.error(`🎯 SMOKING_GUN: Job ${jobId} IS assigned to ${forensicStatus.assigned_to}!`);
            logger.error(`🚨 PROOF: HTTP 500 was hiding race condition - job belongs to another encoder`);
            logger.error(`� EVIDENCE: status=${forensicStatus.status}, assigned_to=${forensicStatus.assigned_to}`);
            logger.error(`⚖️ CONCLUSION: Gateway API bug confirmed - should have returned HTTP 409`);
            isRetryable = false; // Don't retry jobs that are clearly assigned to others
          } else if (!forensicStatus.assigned_to) {
            logger.warn(`🤔 Job ${jobId} shows unassigned after HTTP 500 - possible transient gateway error`);
            isRetryable = true;
          } else {
            logger.warn(`🧩 Job ${jobId} shows assigned to us after HTTP 500 - gateway inconsistency`);
            isRetryable = true;
          }
        } catch (forensicError) {
          logger.warn(`🔍 Could not perform forensic investigation on job ${jobId}:`, forensicError);
          logger.info(`�🔄 Will retry as potential temporary gateway instability (defensive approach)`);
          isRetryable = true; // Default to retrying if we can't investigate
        }
        
      } else if (errorMessage.includes('timeout')) {
        logger.warn(`⏰ GATEWAY_TIMEOUT: Job ${jobId} - gateway performance issue detected`);
        logger.info(`📊 TELEMETRY: Gateway response time exceeded configured timeout`);
        isRetryable = true; // Retry timeouts
        
      } else if (errorMessage.includes('ECONNREFUSED') || errorMessage.includes('ENOTFOUND')) {
        logger.error(`🔌 GATEWAY_UNREACHABLE: Job ${jobId} - network connectivity issue`);
        logger.info(`📊 TELEMETRY: Gateway network connectivity problem`);
        isRetryable = true; // Retry network issues
        
      } else {
        logger.error(`❌ UNKNOWN_GATEWAY_ERROR: Job ${jobId} failed with: ${errorMessage}`);
        logger.info(`📊 TELEMETRY: Unrecognized error pattern - may need investigation`);
        logger.info(`🔍 PLEASE_INVESTIGATE: New error type not in defensive handling logic`);
      }
      
      // Report failure to gateway (but don't let gateway reporting errors affect retry logic)
      try {
        await this.gateway.failJob(jobId, {
          error: errorMessage,
          timestamp: new Date().toISOString(),
          retryable: isRetryable,
          encoder_version: '2.0.0' // Help identify new encoder issues
        });
        logger.info(`📤 Reported job failure to gateway: ${jobId}`);
      } catch (reportError: any) {
        if (reportError.response?.status === 500) {
          logger.warn(`⚠️ Gateway server error (500) - may be due to DST/time change issues`);
          logger.warn(`🕐 Encoder time: ${new Date().toISOString()}`);
        } else {
          logger.warn(`⚠️ Failed to report job failure to gateway for ${jobId}:`, reportError.message);
        }
        // Don't throw here - we still want to handle the original job failure with retry logic
      }
      
      throw error; // Re-throw to be handled by the main job processor
    } finally {
      // 🛡️ DEFENSIVE: Cleanup monitoring interval
      if (ownershipCheckInterval) {
        clearInterval(ownershipCheckInterval);
        logger.info(`🧹 CLEANUP: Stopped ownership monitoring for job ${jobId}`);
      }
      
      this.activeJobs.delete(jobId);
      await this.updateDashboard();
      
      logger.info(`🏁 JOB_COMPLETE: Encoder ${ourDID} finished processing job ${jobId} at ${new Date().toISOString()}`);
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
      
      // Reset failure count on success
      const wasFailing = this.gatewayFailureCount > 0;
      this.gatewayFailureCount = 0;
      this.lastGatewaySuccess = new Date();
      
      // If we recovered from failures, restart heartbeat with normal interval
      if (wasFailing) {
        logger.info('🔄 Gateway connection recovered - switching to normal heartbeat interval');
        this.startDashboardHeartbeat();
      }
      
      // Then check if we can accept more jobs
      if (this.activeJobs.size >= (this.config.encoder?.max_concurrent_jobs || 1)) {
        logger.debug('🔄 Max concurrent jobs reached, skipping job acquisition');
        return;
      }

      const job = await this.gateway.getJob();
      if (job) {
        logger.info(`📥 Received new gateway job: ${job.id}`);
        
        // 🔒 OWNERSHIP VALIDATION: Check if job is already assigned to someone else
        const ourDID = this.identity.getDIDKey();
        const jobWithAssignment = job as any;
        
        if (jobWithAssignment.assigned_to && jobWithAssignment.assigned_to !== ourDID) {
          // Job is already assigned to a different encoder - skip it
          logger.warn(`⚠️ Job ${job.id} is already assigned to ${jobWithAssignment.assigned_to}, not us (${ourDID}). Skipping.`);
          return;
        } else if (!jobWithAssignment.assigned_to) {
          // Job is unassigned - this is what we want to claim
          logger.info(`📋 Job ${job.id} is unassigned - will attempt to claim it`);
        } else if (jobWithAssignment.assigned_to === ourDID) {
          // Job is already assigned to us (resuming?)
          logger.info(`📋 Job ${job.id} is already assigned to us - resuming work`);
        }
        
        // Add gateway job to queue for processing (non-blocking)
        this.jobQueue.addGatewayJob(job);
        logger.info(`📝 Gateway job ${job.id} added to processing queue`);
      } else {
        logger.debug('🔍 No gateway jobs assigned to us');
      }
    } catch (error) {
      // Increment failure count
      this.gatewayFailureCount++;
      const timeSinceLastSuccess = Date.now() - this.lastGatewaySuccess.getTime();
      
      // 🚨 Special handling for HTTP 502 (gateway completely down)
      const errorMessage = error instanceof Error ? error.message : String(error);
      if (errorMessage.includes('status code 502')) {
        logger.error(`💥 GATEWAY_SERVICE_DOWN: HTTP 502 Bad Gateway - backend service is offline`);
        logger.error(`🔍 Root cause: nginx cannot connect to gateway Docker container/systemd service`);
        logger.error(`⚠️ This requires immediate sysadmin intervention to restore service`);
      }
      
      logger.warn(`⚠️ Gateway polling failed (${this.gatewayFailureCount}/${this.maxGatewayFailures}):`, error);
      
      // Only mark as offline after multiple consecutive failures
      if (this.gatewayFailureCount >= this.maxGatewayFailures) {
        logger.warn(`🚨 Gateway marked offline after ${this.gatewayFailureCount} consecutive failures`);
        if (this.dashboard) {
          this.dashboard.updateGatewayStatus(false);
        }
      } else if (this.gatewayFailureCount === 1) {
        // First failure - switch to faster heartbeat
        logger.info('🔄 First gateway failure - switching to faster heartbeat for monitoring');
        this.startDashboardHeartbeat();
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
      // Don't immediately mark offline here - let checkForNewJobs handle the failure tracking
    }
  }

  private async processJob(job: VideoJob): Promise<void> {
    const jobId = job.id;
    
    try {
      // Accept the job
      await this.gateway.acceptJob(jobId);
      this.activeJobs.set(jobId, job);
      logger.info(`✅ Accepted job: ${jobId}`);

      // 🔒 CRITICAL OWNERSHIP VALIDATION: Verify we actually own the job after accepting
      const ourDID = this.identity.getDIDKey();
      
      try {
        const jobStatus = await this.gateway.getJobStatus(jobId);
        logger.info(`🔍 Job ${jobId} status after accept: assigned_to=${jobStatus.assigned_to || 'null'}`);
        
        if (!jobStatus.assigned_to || jobStatus.assigned_to !== ourDID) {
          const actualOwner = jobStatus.assigned_to || 'unassigned';
          logger.error(`🚨 OWNERSHIP CONFLICT: Job ${jobId} is assigned to ${actualOwner}, but we are ${ourDID}`);
          logger.error(`🚨 Another encoder claimed this job! Aborting processing.`);
          throw new Error(`Ownership conflict: job assigned to ${actualOwner}, not us`);
        }
        
        logger.info(`✅ Confirmed ownership of job ${jobId}`);
        
      } catch (statusError: any) {
        if (statusError.message && statusError.message.includes('Ownership conflict')) {
          throw statusError; // Re-throw ownership conflicts
        }
        logger.warn(`⚠️ Failed to verify job ownership for ${jobId}, proceeding with caution:`, statusError);
      }

      // Update status to running using legacy-compatible format
      job.status = JobStatus.RUNNING;
      await this.gateway.pingJob(jobId, { 
        progressPct: 1.0,    // ⚠️ CRITICAL: Must be > 1 to trigger gateway status change
        download_pct: 100    // Download complete at this point
      });

      // Set current job ID for dashboard progress tracking
      this.processor.setCurrentJob(jobId);

      // Process the video
      const result = await this.processor.processVideo(job, (progress: EncodingProgress) => {
        // Update progress (fire-and-forget to prevent memory leaks) - LEGACY FORMAT
        this.safePingJob(jobId, { 
          progress: progress.percent,        // Our internal format
          progressPct: progress.percent,     // Legacy gateway format
          download_pct: 100                  // Download always complete during encoding
        });
      }, (hash: string, error: Error) => {
        // 🔄 LAZY PINNING: Queue failed pins for background retry
        this.pendingPinService.addPendingPin(hash, jobId, 0, 'directory').catch(err => {
          logger.warn(`⚠️ Failed to queue lazy pin for ${hash}:`, err.message);
        });
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
      logger.error(`❌ Job ${jobId} failed:`, cleanErrorForLogging(error));
      
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
   * Manually reset gateway failure tracking (useful for dashboard)
   */
  resetGatewayStatus(): void {
    this.gatewayFailureCount = 0;
    this.lastGatewaySuccess = new Date();
    logger.info('🔄 Gateway failure tracking reset manually');
    
    // Update dashboard immediately
    this.updateDashboard();
    
    // Restart heartbeat with normal interval
    this.startDashboardHeartbeat();
  }

  /**
   * Get current gateway health status
   */
  getGatewayHealth(): { 
    failureCount: number; 
    maxFailures: number; 
    isOnline: boolean; 
    lastSuccess: Date; 
    timeSinceLastSuccess: number 
  } {
    return {
      failureCount: this.gatewayFailureCount,
      maxFailures: this.maxGatewayFailures,
      isOnline: this.gatewayFailureCount < this.maxGatewayFailures,
      lastSuccess: this.lastGatewaySuccess,
      timeSinceLastSuccess: Date.now() - this.lastGatewaySuccess.getTime()
    };
  }

  /**
   * 🔄 LAZY PINNING: Start background pinning of queued content during idle time
   */
  private startLazyPinning(): void {
    // Process pending pins every 2 minutes during idle time
    const lazyPinInterval = setInterval(async () => {
      if (!this.isRunning) {
        clearInterval(lazyPinInterval);
        return;
      }

      // Only process during idle time (no active jobs)
      if (this.activeJobs.size === 0) {
        try {
          const stats = await this.pendingPinService.getStats();
          if (stats.totalPending > 0) {
            logger.info(`🔄 LAZY PINNING: Processing ${stats.totalPending} pending pins during idle time`);
            
            // Process one pending pin
            const success = await this.processSinglePendingPin();
            if (success) {
              logger.info(`✅ LAZY PINNING: Successfully processed 1 pending pin`);
            }
          }
        } catch (error) {
          logger.debug(`⚠️ LAZY PINNING: Background processing error:`, error);
        }
      } else {
        logger.debug(`🔄 LAZY PINNING: Skipping (${this.activeJobs.size} active jobs)`);
      }
    }, 2 * 60 * 1000); // Every 2 minutes

    logger.info(`🔄 LAZY PINNING: Background processing started (2min intervals)`);
  }

  /**
   * Process a single pending pin from the queue
   */
  private async processSinglePendingPin(): Promise<boolean> {
    const pendingPin = await this.pendingPinService.getNextPendingPin();
    if (!pendingPin) {
      return false;
    }

    try {
      logger.info(`🔄 LAZY PINNING: Attempting to pin ${pendingPin.hash}`);
      
      // Use IPFS service to pin the content
      await this.ipfs.pinHash(pendingPin.hash);
      
      // Mark as successful
      await this.pendingPinService.markPinSuccessful(pendingPin.hash);
      logger.info(`✅ LAZY PINNING: Successfully pinned ${pendingPin.hash} for job ${pendingPin.job_id}`);
      
      return true;
    } catch (error) {
      logger.warn(`⚠️ LAZY PINNING: Failed to pin ${pendingPin.hash}:`, error);
      
      // The PendingPinService will handle retry logic automatically
      return false;
    }
  }
}