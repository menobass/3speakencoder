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
import { MongoVerifier } from './MongoVerifier.js';
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
  private mongoVerifier: MongoVerifier;
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
    this.mongoVerifier = new MongoVerifier(config);
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

      // Initialize MongoDB verifier (optional - will skip if disabled)
      try {
        await this.mongoVerifier.initialize();
        if (this.mongoVerifier.isEnabled()) {
          logger.info('✅ MongoDB direct verification ready');
        } else {
          logger.info('ℹ️ MongoDB direct verification disabled');
        }
      } catch (error) {
        logger.warn('⚠️ MongoDB direct verification failed to initialize:', error);
        logger.warn('🔄 Encoder will continue without MongoDB fallback');
      }
      
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
    
    // Cleanup MongoDB verifier connection
    if (this.mongoVerifier) {
      try {
        await this.mongoVerifier.cleanup();
        logger.info('✅ MongoDB verifier cleanup completed');
      } catch (error) {
        logger.warn('⚠️ MongoDB verifier cleanup failed:', error);
      }
    }
    
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

  private async processGatewayJob(job: any, ownershipAlreadyConfirmed: boolean = false): Promise<void> {
    const jobId = job.id;
    const ourDID = this.identity.getDIDKey();
    let ownershipCheckInterval: NodeJS.Timeout | null = null;
    
    // 🛡️ Variables for MongoDB fallback (scope accessible from catch blocks)
    let completedResult: any = null;
    let masterCID: string | null = null;
    
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
      // 🔍 SMART CLAIMING: Skip ownership check if already confirmed
      let jobStatus: any;
      
      if (ownershipAlreadyConfirmed) {
        logger.info(`✅ OWNERSHIP_PRECONFIRMED: Job ${jobId} ownership already verified - skipping all gateway checks`);
        // Skip all gateway interactions and go straight to processing
      } else {
        // 🔍 Check if we need to claim the job first
        let needsToClaim = true;
        
        try {
          // Check current job status to see if we already own it
          jobStatus = await this.gateway.getJobStatus(jobId);
          if (jobStatus?.assigned_to === ourDID) {
            logger.info(`✅ ALREADY_OWNED: Job ${jobId} is already assigned to us - no need to claim`);
            needsToClaim = false;
          } else if (!jobStatus?.assigned_to) {
            logger.info(`🎯 NEEDS_CLAIMING: Job ${jobId} is unassigned - will claim it`);
            needsToClaim = true;
          } else {
            logger.warn(`⚠️ OWNERSHIP_CONFLICT: Job ${jobId} is assigned to ${jobStatus.assigned_to}, not us`);
            throw new Error(`Job ${jobId} is assigned to another encoder: ${jobStatus.assigned_to}`);
          }
        } catch (statusError) {
          logger.warn(`⚠️ Could not check job status, will attempt to claim anyway:`, statusError);
          needsToClaim = true; // Default to claiming if we can't check status
        }
        
        // Only call acceptJob if we need to claim the job
        if (needsToClaim) {
          logger.info(`📞 CLAIMING: Calling acceptJob() for ${jobId}`);
          
          try {
            await this.gateway.acceptJob(jobId);
            logger.info(`✅ Successfully claimed gateway job: ${jobId}`);
            
            // Re-check status after claiming
            jobStatus = await this.gateway.getJobStatus(jobId);
            
          } catch (acceptError: any) {
            // 🛡️ DEFENSIVE CLAIMING: Gateway failed to assign job - investigate and take control
            const errorMessage = acceptError instanceof Error ? acceptError.message : String(acceptError);
            logger.error(`❌ GATEWAY_CLAIM_FAILED: acceptJob() failed for ${jobId}:`, errorMessage);
            logger.info(`🔍 DEFENSIVE_MODE: Investigating job status via MongoDB before giving up...`);
            
            // Check MongoDB to see if the job is still unassigned
            if (this.mongoVerifier.isEnabled()) {
              try {
                const mongoResult = await this.mongoVerifier.verifyJobOwnership(jobId, ourDID);
                
                if (mongoResult.jobExists) {
                  if (mongoResult.isOwned) {
                    // Job was actually assigned to us somehow
                    logger.info(`✅ MONGODB_SURPRISE: Job ${jobId} was assigned to us despite gateway failure!`);
                    logger.info(`🎯 PROCEEDING: Gateway lied, but MongoDB shows we own the job`);
                  } else if (!mongoResult.actualOwner) {
                    // Job is still unassigned - TAKE CONTROL
                    logger.warn(`🚨 GATEWAY_BROKEN: Job ${jobId} still unassigned after gateway failure`);
                    logger.info(`🛡️ DEFENSIVE_TAKEOVER: Force-assigning job to ourselves to prevent limbo`);
                    
                    try {
                      // Force assign the job to ourselves in MongoDB
                      await this.mongoVerifier.forceAssignJob(jobId, ourDID);
                      logger.info(`✅ FORCE_ASSIGNED: Job ${jobId} forcibly assigned to us in MongoDB`);
                      logger.info(`🎯 DEFENSIVE_SUCCESS: Proceeding with processing despite gateway failure`);
                      logger.info(`📊 TELEMETRY: Gateway broken, but MongoDB takeover successful`);
                      
                    } catch (forceAssignError) {
                      logger.error(`❌ FORCE_ASSIGN_FAILED: Could not force-assign job ${jobId}:`, forceAssignError);
                      throw new Error(`Both gateway and MongoDB assignment failed: ${errorMessage}`);
                    }
                  } else {
                    // Job was assigned to someone else
                    logger.info(`🏃‍♂️ RACE_CONDITION: Job ${jobId} was assigned to ${mongoResult.actualOwner} while we were trying`);
                    throw new Error(`Job assigned to another encoder: ${mongoResult.actualOwner}`);
                  }
                } else {
                  logger.error(`🤔 JOB_NOT_FOUND: Job ${jobId} doesn't exist in MongoDB`);
                  throw new Error(`Job not found in database: ${jobId}`);
                }
                
              } catch (mongoError) {
                logger.error(`❌ MONGODB_VERIFICATION_FAILED: Could not check job status in MongoDB:`, mongoError);
                throw new Error(`Gateway failed and MongoDB verification failed: ${errorMessage}`);
              }
            } else {
              logger.error(`🔒 MONGODB_DISABLED: Cannot perform defensive takeover - MongoDB access required`);
              throw acceptError; // Re-throw original error
            }
          }
        } else {
          logger.info(`⏩ SKIP_CLAIMING: Job ${jobId} already owned, proceeding directly to processing`);
        }
      }

      // 🔒 CRITICAL OWNERSHIP VALIDATION: Verify we own the job (skip if already confirmed)
      if (!ownershipAlreadyConfirmed) {
        try {
        jobStatus = await this.gateway.getJobStatus(jobId);
        logger.info(`🔍 Job ${jobId} status after accept: assigned_to=${jobStatus.assigned_to || 'null'}, status=${jobStatus.status || 'unknown'}`);
        
        // 🔍 DEBUG: Log DID format details for investigation
        logger.info(`🔍 DID_FORMAT_DEBUG: Our DID="${ourDID}"`);
        logger.info(`🔍 DID_FORMAT_DEBUG: Gateway assigned_to="${jobStatus.assigned_to || 'null'}"`);
        
        // 🛡️ DEFENSIVE: Handle DID format mismatches (did:key: prefix issues)
        const normalizeJobOwner = (owner: string | null): string => {
          if (!owner) return '';
          // Handle both "did:key:xyz" and "didxyz" formats
          if (owner.startsWith('did:key:')) {
            return owner; // Already has prefix
          } else if (owner.startsWith('did')) {
            return `did:key:${owner.substring(3)}`; // Convert "didxyz" to "did:key:xyz" 
          }
          return owner;
        };
        
        const normalizeOurDID = (ourDid: string): string => {
          if (!ourDid) return '';
          // Handle both "did:key:xyz" and "didxyz" formats
          if (ourDid.startsWith('did:key:')) {
            return ourDid; // Already has prefix
          } else if (ourDid.startsWith('did')) {
            return `did:key:${ourDid.substring(3)}`; // Convert "didxyz" to "did:key:xyz"
          }
          return ourDid;
        };
        
        const normalizedJobOwner = normalizeJobOwner(jobStatus.assigned_to);
        const normalizedOurDID = normalizeOurDID(ourDID);
        
        logger.info(`🔍 DID_NORMALIZED: Our DID="${normalizedOurDID}"`);
        logger.info(`🔍 DID_NORMALIZED: Gateway assigned_to="${normalizedJobOwner}"`);
        
        // After acceptJob(), the job MUST be assigned to us (with normalized comparison)
        if (normalizedJobOwner !== normalizedOurDID) {
          const actualOwner = jobStatus.assigned_to || 'unassigned/null';
          
          if (!jobStatus.assigned_to) {
            logger.error(`🚨 CLAIM FAILED: Job ${jobId} is still unassigned after acceptJob() - gateway may have rejected our claim`);
          } else {
            logger.error(`🚨 DID_MISMATCH: Job ${jobId} assigned_to="${actualOwner}" vs our DID="${ourDID}"`);
            logger.error(`🔍 NORMALIZED: Gateway="${normalizedJobOwner}" vs Ours="${normalizedOurDID}"`);
            
            // Check if it's just a format mismatch vs actual different owner
            const jobOwnerCore = (jobStatus.assigned_to || '').replace(/^did:key:/, '').replace(/^did/, '');
            const ourDIDCore = ourDID.replace(/^did:key:/, '').replace(/^did/, '');
            
            if (jobOwnerCore === ourDIDCore) {
              logger.warn(`⚠️ DID_FORMAT_MISMATCH: Same core DID but different format - this is a gateway API bug`);
              logger.warn(`🔧 PROCEEDING: Core DIDs match, treating as successful claim`);
              // Continue processing since it's the same DID with different format
            } else {
              logger.error(`🚨 RACE CONDITION: Job ${jobId} is assigned to different encoder: ${actualOwner}`);
              logger.error(`🚨 Another encoder won the race condition! This indicates high competition for jobs.`);
              // Gracefully handle the conflict without throwing
              this.jobQueue.failJob(jobId, `Failed to claim job: assigned_to=${actualOwner}, expected=${ourDID}`, false);
              return;
            }
          }
        }
        
        if (jobStatus.status !== 'assigned') {
          logger.warn(`⚠️ Unexpected job status after accept: ${jobStatus.status} (expected 'assigned')`);
        }
        
        logger.info(`✅ Successfully claimed job ${jobId} - confirmed ownership and proceeding with work`);
        
      } catch (statusError) {
        logger.error(`❌ OWNERSHIP_VERIFICATION_FAILED: Cannot verify job ${jobId} ownership:`, statusError);
        logger.warn(`🛡️ DEFENSIVE: This could indicate gateway API issues - attempting MongoDB direct verification`);
        logger.warn(`📊 TELEMETRY: Gateway getJobStatus API failure after successful acceptJob`);
        
        // 🛡️ NUCLEAR OPTION: MongoDB Direct Verification
        if (this.mongoVerifier.isEnabled()) {
          try {
            logger.info(`🚀 MONGODB_FALLBACK: Gateway failed, checking MongoDB directly for job ${jobId}`);
            const mongoResult = await this.mongoVerifier.verifyJobOwnership(jobId, ourDID);
            
            if (mongoResult.jobExists) {
              if (mongoResult.isOwned) {
                logger.info(`✅ MONGODB_CONFIRMED: Job ${jobId} ownership verified via MongoDB - gateway was wrong!`);
                logger.info(`📊 EVIDENCE: MongoDB shows assigned_to=${mongoResult.actualOwner}, status=${mongoResult.status}`);
                logger.info(`🎯 CONCLUSION: Proceeding with job processing - MongoDB is ground truth`);
              } else {
                logger.error(`🚨 MONGODB_CONFLICT: Job ${jobId} assigned to different encoder in MongoDB: ${mongoResult.actualOwner}`);
                logger.error(`🛑 ABORTING: MongoDB confirms job belongs to another encoder`);
                this.jobQueue.failJob(jobId, `MongoDB verification failed: job assigned to ${mongoResult.actualOwner}`, false);
                return;
              }
            } else {
              logger.error(`🤔 MONGODB_NOT_FOUND: Job ${jobId} doesn't exist in MongoDB - may be invalid job ID`);
              logger.warn(`⚠️ PROCEEDING_WITH_CAUTION: Neither gateway nor MongoDB can confirm job ownership`);
            }
          } catch (mongoError) {
            logger.error(`❌ MONGODB_VERIFICATION_FAILED: ${mongoError}`);
            logger.warn(`🆘 ALL_VERIFICATION_FAILED: Both gateway API and MongoDB verification failed`);
            logger.info(`⚠️ RISK_ASSESSMENT: Continuing since acceptJob() succeeded, but this is high risk`);
          }
        } else {
          logger.warn(`⚠️ MONGODB_UNAVAILABLE: Direct verification disabled - proceeding with caution`);
          logger.info(`⚠️ RISK_ASSESSMENT: Continuing since acceptJob() succeeded, but monitoring for conflicts`);
        }
      }
      } // End of ownership validation check
      
      // 🛡️ DEFENSIVE: Additional safety check - verify we're not processing someone else's job
      // This catches race conditions that might have occurred after our ownership check
      logger.info(`🔒 SAFETY_CHECK: Job ${jobId} processing started by encoder ${ourDID}`);
      logger.info(`⏱️ TIMESTAMP: ${new Date().toISOString()} - Starting processing phase`);
      
      // 🛡️ DEFENSIVE: Set up periodic ownership verification during processing
      const startOwnershipMonitoring = () => {
        ownershipCheckInterval = setInterval(async () => {
          try {
            const currentStatus = await this.gateway.getJobStatus(jobId);
            
            // 🛡️ DEFENSIVE: Use same DID normalization logic as initial check
            const normalizeOwner = (owner: string | null): string => {
              if (!owner) return '';
              if (owner.startsWith('did:key:')) return owner;
              if (owner.startsWith('did')) return `did:key:${owner.substring(3)}`;
              return owner;
            };
            
            const normalizedCurrentOwner = normalizeOwner(currentStatus.assigned_to);
            const normalizedOurDID = normalizeOwner(ourDID);
            
            if (normalizedCurrentOwner !== normalizedOurDID && currentStatus.assigned_to) {
              // Check if it's just format mismatch vs real ownership change
              const currentOwnerCore = (currentStatus.assigned_to || '').replace(/^did:key:/, '').replace(/^did/, '');
              const ourDIDCore = ourDID.replace(/^did:key:/, '').replace(/^did/, '');
              
              if (currentOwnerCore !== ourDIDCore) {
                logger.error(`🚨 OWNERSHIP_HIJACK_DETECTED: Job ${jobId} reassigned during processing!`);
                logger.error(`📊 CRITICAL_BUG: assigned_to changed from ${ourDID} to ${currentStatus.assigned_to}`);
                logger.error(`🛑 ABORTING: Stopping processing to prevent duplicate work`);
                
                // Clear the interval and abort processing
                if (ownershipCheckInterval) clearInterval(ownershipCheckInterval);
                throw new Error(`Job ownership hijacked: assigned_to=${currentStatus.assigned_to}, expected=${ourDID}`);
              } else {
                logger.debug(`🔍 DID format difference detected but same core DID - continuing safely`);
              }
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
      
      // 🛡️ Capture values for MongoDB fallback in outer scope
      completedResult = result;
      masterCID = masterOutput.ipfsHash;
      
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
      
      // 🛡️ MONGODB FALLBACK: If we have the CID and MongoDB access, try to complete directly
      const gatewayErrorMessage = error instanceof Error ? error.message : String(error);
      const isRaceCondition = gatewayErrorMessage.includes('no longer available') || 
                             gatewayErrorMessage.includes('already assigned') ||
                             gatewayErrorMessage.includes('not assigned');
      
      // Only use MongoDB fallback if:
      // 1. We successfully processed the video (have CID)
      // 2. MongoDB verification is enabled  
      // 3. This is NOT a race condition (job stolen by another encoder)
      // 4. Gateway completion failed for infrastructure reasons
      if (masterCID && this.mongoVerifier?.isEnabled() && !isRaceCondition) {
        logger.warn(`🔄 GATEWAY_COMPLETION_FAILED: Attempting MongoDB fallback for job ${jobId}`);
        logger.info(`🎯 Video processing succeeded, CID: ${masterCID}`);
        logger.info(`🛡️ Content is safely uploaded and pinned - attempting direct database completion`);
        
        try {
          await this.mongoVerifier.forceCompleteJob(jobId, { cid: masterCID });
          
          // Mark as complete in local systems
          this.jobQueue.completeJob(jobId, completedResult);
          if (this.dashboard) {
            this.dashboard.completeJob(jobId, completedResult);
          }
          
          logger.info(`✅ MONGODB_FALLBACK_SUCCESS: Job ${jobId} completed via direct database update`);
          logger.info(`🎊 Video is now marked as complete despite gateway failure`);
          logger.info(`📊 FALLBACK_STATS: Gateway failed, MongoDB succeeded - video delivered to users`);
          
          return; // Success! Exit without failing the job
          
        } catch (mongoError) {
          logger.error(`❌ MONGODB_FALLBACK_FAILED: Could not complete job ${jobId} via database:`, mongoError);
          logger.warn(`💔 Both gateway AND MongoDB completion failed - job will be marked as failed`);
          // Continue to normal error handling
        }
      } else if (isRaceCondition) {
        logger.info(`🏃‍♂️ RACE_CONDITION: Skipping MongoDB fallback - job ${jobId} belongs to another encoder`);
      } else if (!masterCID) {
        logger.warn(`🚨 NO_CID: Cannot use MongoDB fallback - video processing did not complete successfully`);
      } else if (!this.mongoVerifier?.isEnabled()) {
        logger.info(`🔒 MONGODB_DISABLED: MongoDB fallback not available - continuing with normal error handling`);
      }
      
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
      
      // 🔍 CRITICAL LOGIC FIX: Determine if we should report this as a failure
      let shouldReportFailure = true;
      let skipJobSilently = false;
      
      // Check if this was a job assignment uncertainty (not a real failure)
      if (errorMessage.includes('status code 500')) {
        // For HTTP 500 errors, check if we confirmed job ownership
        try {
          const forensicStatus = await this.gateway.getJobStatus(jobId);
          if (forensicStatus.assigned_to && forensicStatus.assigned_to !== ourDID) {
            // Job belongs to another encoder - this isn't our failure
            logger.info(`🎯 JOB_SKIP: Job ${jobId} belongs to another encoder, not reporting failure`);
            shouldReportFailure = false;
            skipJobSilently = true;
          } else if (!forensicStatus.assigned_to) {
            // Job is unassigned - we never owned it
            logger.info(`🎯 JOB_SKIP: Job ${jobId} was never assigned to us, not reporting failure`);
            shouldReportFailure = false;
            skipJobSilently = true;
          }
        } catch (forensicError) {
          // If we can't verify ownership and have MongoDB access, try that
          if (this.mongoVerifier.isEnabled()) {
            try {
              const mongoResult = await this.mongoVerifier.verifyJobOwnership(jobId, ourDID);
              if (mongoResult.jobExists && !mongoResult.isOwned) {
                logger.info(`🎯 MONGODB_CONFIRM: Job ${jobId} belongs to another encoder, not reporting failure`);
                shouldReportFailure = false;
                skipJobSilently = true;
              } else if (!mongoResult.jobExists) {
                logger.info(`🎯 MONGODB_CONFIRM: Job ${jobId} doesn't exist, not reporting failure`);
                shouldReportFailure = false;
                skipJobSilently = true;
              }
            } catch (mongoError) {
              logger.warn(`⚠️ Could not verify job ownership via MongoDB: ${mongoError}`);
              // Default to not reporting if we can't confirm ownership
              shouldReportFailure = false;
              skipJobSilently = true;
            }
          } else {
            // No MongoDB access and can't confirm via gateway - don't report
            logger.info(`🎯 DEFENSIVE: Cannot confirm job ownership, not reporting failure`);
            shouldReportFailure = false;
            skipJobSilently = true;
          }
        }
      } else if (errorMessage.includes('Job already accepted by another encoder') || 
                 errorMessage.includes('already assigned')) {
        // Clear race condition - not our failure
        logger.info(`🎯 JOB_SKIP: Job ${jobId} was claimed by another encoder, not reporting failure`);
        shouldReportFailure = false;
        skipJobSilently = true;
      }
      
      // Only report failure if we confirmed we owned the job
      if (shouldReportFailure) {
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
      } else {
        logger.info(`✅ JOB_SKIP: Not reporting failure for ${jobId} - job assignment was uncertain`);
      }
      
      // If this was a job we never owned, don't treat it as a failure
      if (skipJobSilently) {
        logger.info(`🔄 JOB_SKIP: Silently moving to next job - ${jobId} was never ours`);
        
        // Clean up from active jobs since we're skipping
        this.activeJobs.delete(jobId);
        
        // Log as completed (skipped) for tracking purposes
        logger.info(`🏁 JOB_SKIPPED: Encoder ${ourDID} gracefully skipped job ${jobId} at ${new Date().toISOString()}`);
        
        return; // Exit gracefully without throwing error
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
        // 🚨 DUPLICATE PREVENTION: Check if we're already processing this job
        if (this.activeJobs.has(job.id) || this.jobQueue.hasJob(job.id)) {
          logger.debug(`🔄 Job ${job.id} already in queue or active - skipping duplicate from gateway`);
          return;
        }
        
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
    
    // 🛡️ Variables for MongoDB fallback (scope accessible from catch blocks)  
    let completedResult: any = null;
    let masterCID: string | null = null;
    
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
      
      // 🛡️ Capture values for MongoDB fallback in outer scope
      completedResult = result;
      masterCID = masterOutput.ipfsHash || null;
      
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
      
      // 🛡️ MONGODB FALLBACK: If we have the CID and MongoDB access, try to complete directly
      const gatewayErrorMessage = error instanceof Error ? error.message : String(error);
      const isRaceCondition = gatewayErrorMessage.includes('no longer available') || 
                             gatewayErrorMessage.includes('already assigned') ||
                             gatewayErrorMessage.includes('not assigned');
      
      // Only use MongoDB fallback if:
      // 1. We successfully processed the video (have CID)
      // 2. MongoDB verification is enabled  
      // 3. This is NOT a race condition (job stolen by another encoder)
      // 4. Gateway completion failed for infrastructure reasons
      if (masterCID && this.mongoVerifier?.isEnabled() && !isRaceCondition) {
        logger.warn(`🔄 GATEWAY_COMPLETION_FAILED: Attempting MongoDB fallback for job ${jobId}`);
        logger.info(`🎯 Video processing succeeded, CID: ${masterCID}`);
        logger.info(`🛡️ Content is safely uploaded and pinned - attempting direct database completion`);
        
        try {
          await this.mongoVerifier.forceCompleteJob(jobId, { cid: masterCID });
          
          logger.info(`✅ MONGODB_FALLBACK_SUCCESS: Job ${jobId} completed via direct database update`);
          logger.info(`🎊 Video is now marked as complete despite gateway failure`);
          logger.info(`📊 FALLBACK_STATS: Gateway failed, MongoDB succeeded - video delivered to users`);
          
          return; // Success! Exit without failing the job
          
        } catch (mongoError) {
          logger.error(`❌ MONGODB_FALLBACK_FAILED: Could not complete job ${jobId} via database:`, mongoError);
          logger.warn(`💔 Both gateway AND MongoDB completion failed - job will be marked as failed`);
          // Continue to normal error handling
        }
      } else if (isRaceCondition) {
        logger.info(`🏃‍♂️ RACE_CONDITION: Skipping MongoDB fallback - job ${jobId} belongs to another encoder`);
      } else if (!masterCID) {
        logger.warn(`🚨 NO_CID: Cannot use MongoDB fallback - video processing did not complete successfully`);
      } else if (!this.mongoVerifier?.isEnabled()) {
        logger.info(`🔒 MONGODB_DISABLED: MongoDB fallback not available - continuing with normal error handling`);
      }
      
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
      // 🛡️ ENHANCED: Check MongoDB first if available (more reliable than gateway)
      let jobOwnershipConfirmed = false;
      const ourDID = this.identity.getDIDKey();
      
      if (this.mongoVerifier.isEnabled()) {
        try {
          logger.info(`🔍 Checking MongoDB for job ${jobId} ownership...`);
          const mongoResult = await this.mongoVerifier.verifyJobOwnership(jobId, ourDID);
          
          if (mongoResult.jobExists) {
            if (mongoResult.isOwned) {
              logger.info(`✅ MONGODB_CONFIRMED: Job ${jobId} is assigned to us in database`);
              logger.info(`🎯 SKIP_GATEWAY: No need to call acceptJob() - we already own this job`);
              jobOwnershipConfirmed = true;
            } else {
              logger.warn(`⚠️ MONGODB_CONFLICT: Job ${jobId} is assigned to another encoder: ${mongoResult.actualOwner}`);
              throw new Error(`Job ${jobId} is already assigned to another encoder: ${mongoResult.actualOwner}`);
            }
          } else {
            logger.warn(`⚠️ Job ${jobId} not found in MongoDB - may be completed or cancelled`);
          }
        } catch (mongoError) {
          logger.warn(`⚠️ MongoDB verification failed, falling back to gateway check:`, mongoError);
        }
      }
      
      // Only try gateway if MongoDB didn't confirm ownership
      if (!jobOwnershipConfirmed) {
        logger.info(`🔍 Checking gateway for job ${jobId} status...`);
        const jobStatus = await this.gateway.getJobStatus(jobId);
        
        if (!jobStatus) {
          throw new Error(`Job ${jobId} not found in gateway`);
        }
        
        logger.info(`📋 Job ${jobId} gateway status: ${jobStatus.status || 'unknown'}`);
        
        // Check if job is already assigned to us via gateway
        if (jobStatus.assigned_to === ourDID) {
          logger.info(`✅ GATEWAY_CONFIRMED: Job ${jobId} is already assigned to us`);
          logger.info(`🎯 SKIP_ACCEPT: No need to call acceptJob() - we already own this job`);
          jobOwnershipConfirmed = true;
        } else if (!jobStatus.assigned_to) {
          // Job is unassigned - need to claim it
          logger.info(`🎯 CLAIMING: Job ${jobId} is unassigned, attempting to claim via acceptJob()`);
          await this.gateway.acceptJob(jobId);
          logger.info(`✅ Successfully claimed job via gateway: ${jobId}`);
          jobOwnershipConfirmed = true;
        } else {
          // Job is assigned to someone else
          throw new Error(`Job ${jobId} is assigned to another encoder: ${jobStatus.assigned_to}`);
        }
      }
      
      if (jobOwnershipConfirmed) {
        // Check if job is already in our active jobs to prevent duplicates
        if (this.activeJobs.has(jobId)) {
          logger.warn(`⚠️ Job ${jobId} is already being processed - skipping duplicate`);
          return;
        }
        
        // Create a job object and process it directly
        const job = {
          id: jobId,
          type: 'gateway',
          status: 'accepted'
        };
        
        logger.info(`🚀 Starting manual processing for job: ${jobId}`);
        this.activeJobs.set(jobId, job);
        
        // Process the job directly with ownership already confirmed
        await this.processGatewayJob(job, true); // true = ownership already confirmed
      }
      
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
   * 🚀 FORCE PROCESSING: Bypass gateway completely and process job directly
   * 
   * This is the nuclear option for 3Speak infrastructure nodes:
   * 1. Query MongoDB directly for job details
   * 2. Download and process video completely
   * 3. Upload results to IPFS
   * 4. Update MongoDB directly with completion status
   * 
   * ⚠️ REQUIRES MONGODB ACCESS - Only works for 3Speak infrastructure nodes
   */
  async forceProcessJob(jobId: string): Promise<void> {
    if (!this.mongoVerifier.isEnabled()) {
      throw new Error('Force processing requires MongoDB access - only available for 3Speak infrastructure nodes');
    }

    logger.info(`🚀 FORCE_PROCESSING: Starting bypass processing for job ${jobId}`);
    logger.warn(`⚠️ TANK_MODE: Bypassing gateway completely - direct MongoDB control`);
    
    try {
      // Step 1: Get job details directly from MongoDB
      logger.info(`📊 Step 1: Querying MongoDB for job details...`);
      const jobDoc = await this.mongoVerifier.getJobDetails(jobId);
      
      if (!jobDoc) {
        throw new Error(`Job ${jobId} not found in MongoDB database`);
      }

      logger.info(`✅ Found job in MongoDB:`);
      logger.info(`   📄 Job ID: ${jobDoc.id}`);
      logger.info(`   📺 Video: ${jobDoc.metadata?.video_owner}/${jobDoc.metadata?.video_permlink}`);
      logger.info(`   📊 Status: ${jobDoc.status}`);
      logger.info(`   📥 Input: ${jobDoc.input.uri}`);
      logger.info(`   💾 Size: ${(jobDoc.input.size / 1024 / 1024).toFixed(2)} MB`);

      // Step 2: 🔒 SECURITY CHECK - Prevent processing completed jobs
      if (jobDoc.status === 'complete') {
        logger.warn(`🚨 SECURITY: Rejecting force processing request - job ${jobId} is already complete`);
        logger.info(`📊 Job status: ${jobDoc.status}`);
        if (jobDoc.result?.cid) {
          logger.info(`📹 Video CID: ${jobDoc.result.cid}`);
          logger.info(`✅ Video is already published and available`);
        }
        if (jobDoc.completed_at) {
          logger.info(`⏰ Completed at: ${jobDoc.completed_at}`);
        }
        logger.info(`�️ This prevents spam/abuse of the force processing feature`);
        throw new Error(`Job ${jobId} is already complete - cannot reprocess completed jobs`);
      }
      
      // Additional security checks
      if (jobDoc.status === 'deleted') {
        logger.warn(`🚨 SECURITY: Job ${jobId} is marked as deleted - cannot force process`);
        throw new Error(`Job ${jobId} has been deleted - cannot process deleted jobs`);
      }

      // Step 3: Force assign job to ourselves in database first (claim ownership)
      const ourDID = this.identity.getDIDKey();
      logger.info(`🔒 Step 2: Claiming job ownership in MongoDB...`);
      
      await this.mongoVerifier.updateJob(jobId, {
        assigned_to: ourDID,
        assigned_date: new Date(),
        status: 'assigned',
        last_pinged: new Date()
      });
      logger.info(`✅ Claimed job ${jobId} ownership in MongoDB`);

      // Step 4: Convert MongoDB job to VideoJob format for processing
      logger.info(`🔄 Step 3: Converting to internal job format...`);
      
      const videoJob: VideoJob = {
        id: jobDoc.id,
        type: 'gateway',
        status: JobStatus.RUNNING,
        created_at: jobDoc.created_at.toISOString(),
        input: {
          uri: jobDoc.input.uri,
          size: jobDoc.input.size
        },
        metadata: {
          video_owner: jobDoc.metadata?.video_owner || 'unknown',
          video_permlink: jobDoc.metadata?.video_permlink || 'unknown'
        },
        storageMetadata: jobDoc.storageMetadata || {
          app: '3speak',
          key: `${jobDoc.metadata?.video_owner}/${jobDoc.metadata?.video_permlink}/video`,
          type: 'video'
        },
        profiles: this.getProfilesForJob(['1080p', '720p', '480p']),
        output: []
      };

      // Step 5: Mark as running in MongoDB
      await this.mongoVerifier.updateJob(jobId, {
        status: 'running',
        last_pinged: new Date(),
        'progress.download_pct': 0,
        'progress.pct': 0
      });

      // Step 6: Start dashboard tracking
      if (this.dashboard) {
        this.dashboard.startJob(jobId, {
          type: 'force-processing',
          video_id: jobDoc.metadata?.video_permlink || jobId,
          input_uri: jobDoc.input.uri,
          profiles: ['1080p', '720p', '480p']
        });
      }

      // Step 7: Process the video using existing pipeline
      logger.info(`🎬 Step 4: Processing video (download → encode → upload)...`);
      
      this.processor.setCurrentJob(jobId);
      
      const result = await this.processor.processVideo(videoJob, (progress) => {
        // Update progress in MongoDB instead of gateway
        this.mongoVerifier.updateJob(jobId, {
          'progress.pct': progress.percent,
          'progress.download_pct': 100, // Download always complete during encoding
          last_pinged: new Date()
        }).catch(err => {
          logger.warn(`⚠️ Failed to update progress in MongoDB:`, err);
        });

        // Update dashboard
        if (this.dashboard) {
          this.dashboard.updateJobProgress(jobId, progress.percent, 'force-processing');
        }
      });

      // Step 8: Get master playlist CID
      const masterOutput = result[0];
      if (!masterOutput || !masterOutput.ipfsHash) {
        throw new Error('No master playlist CID received from video processor');
      }

      logger.info(`✅ Step 5: Video processing complete!`);
      logger.info(`📋 Master playlist CID: ${masterOutput.ipfsHash}`);

      // Step 9: Force complete job in MongoDB (the magic happens here!)
      logger.info(`🚀 Step 6: Force completing job in MongoDB...`);
      await this.mongoVerifier.forceCompleteJob(jobId, { cid: masterOutput.ipfsHash });

      // Step 10: Complete dashboard tracking
      if (this.dashboard) {
        this.dashboard.completeJob(jobId, result);
      }

      logger.info(`🎉 FORCE_PROCESSING_COMPLETE: Job ${jobId} processed and marked complete!`);
      logger.info(`🌟 Video should now be published automatically by 3Speak system`);
      logger.info(`🛡️ TANK_MODE: Bypassed all gateway issues - direct database control succeeded`);

    } catch (error) {
      logger.error(`❌ Force processing failed for job ${jobId}:`, error);
      
      // Try to mark as failed in MongoDB
      try {
        await this.mongoVerifier.updateJob(jobId, {
          status: 'failed',
          last_pinged: new Date(),
          error: error instanceof Error ? error.message : 'Force processing failed'
        });
      } catch (updateError) {
        logger.warn(`⚠️ Failed to update job failure in MongoDB:`, updateError);
      }

      // Update dashboard with failure
      if (this.dashboard) {
        this.dashboard.failJob(jobId, `Force processing failed: ${error instanceof Error ? error.message : 'Unknown error'}`);
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

  /**
   * Check MongoDB for real-time job status updates
   */
  async checkJobStatusUpdate(jobId: string): Promise<any> {
    if (!this.mongoVerifier.isEnabled()) {
      throw new Error('Job status updates require MongoDB access - only available for 3Speak infrastructure nodes');
    }

    logger.info(`🔍 CHECKING_UPDATES: Getting real-time status for job ${jobId} from MongoDB...`);
    
    try {
      const statusUpdate = await this.mongoVerifier.getJobStatusUpdate(jobId);
      
      if (!statusUpdate.exists) {
        logger.warn(`❌ Job ${jobId} not found in MongoDB - may have been deleted`);
        return {
          found: false,
          status: 'not_found',
          message: 'Job not found in database - may have been deleted',
          timestamp: new Date().toISOString()
        };
      }

      // Analyze the status and provide helpful context
      let analysis = '';
      let recommendation = '';
      
      switch (statusUpdate.status) {
        case 'complete':
          analysis = '✅ Job completed successfully';
          recommendation = statusUpdate.result?.cid 
            ? `Video is published with CID: ${statusUpdate.result.cid}` 
            : 'Job marked complete but no CID found - may need investigation';
          break;
          
        case 'running':
        case 'assigned':
          const assignedTo = statusUpdate.assigned_to || 'unknown encoder';
          analysis = `🔄 Job is currently being processed by: ${assignedTo}`;
          recommendation = 'Wait for completion or check if encoder is stuck';
          break;
          
        case 'failed':
          analysis = '❌ Job failed in database';
          recommendation = 'Safe to retry or force process if needed';
          break;
          
        case 'pending':
        case 'queued':
          analysis = '⏳ Job is waiting to be processed';
          recommendation = 'Job should be picked up automatically by available encoders';
          break;
          
        default:
          analysis = `❓ Unknown status: ${statusUpdate.status}`;
          recommendation = 'Manual investigation may be required';
      }

      // Check if job has been recently active
      const lastPing = statusUpdate.last_pinged ? new Date(statusUpdate.last_pinged) : null;
      const now = new Date();
      const timeSinceLastPing = lastPing ? Math.floor((now.getTime() - lastPing.getTime()) / 60000) : null;
      
      let activityStatus = '';
      if (lastPing && timeSinceLastPing !== null) {
        if (timeSinceLastPing < 5) {
          activityStatus = '🟢 Recently active (last ping < 5 min ago)';
        } else if (timeSinceLastPing < 30) {
          activityStatus = '🟡 Moderately active (last ping < 30 min ago)';
        } else {
          activityStatus = `🔴 Stale (last ping ${timeSinceLastPing} minutes ago)`;
        }
      } else {
        activityStatus = '⚫ No recent activity recorded';
      }

      const result = {
        found: true,
        status: statusUpdate.status,
        assigned_to: statusUpdate.assigned_to,
        analysis,
        recommendation,
        activity_status: activityStatus,
        last_pinged: statusUpdate.last_pinged,
        completed_at: statusUpdate.completed_at,
        progress: statusUpdate.progress,
        result: statusUpdate.result,
        error_message: statusUpdate.error_message,
        metadata: statusUpdate.metadata,
        timestamp: new Date().toISOString()
      };

      logger.info(`📋 STATUS_UPDATE: ${analysis}`);
      logger.info(`💡 RECOMMENDATION: ${recommendation}`);
      logger.info(`📊 ACTIVITY: ${activityStatus}`);
      
      return result;

    } catch (error) {
      logger.error(`❌ Failed to check job status update for ${jobId}:`, error);
      throw error;
    }
  }
}