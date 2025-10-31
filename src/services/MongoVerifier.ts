import { MongoClient, Db, Collection } from 'mongodb';
import { EncoderConfig } from '../config/ConfigLoader.js';
import { createLogger, format, transports } from 'winston';

const logger = createLogger({
  level: 'info',
  format: format.combine(
    format.timestamp(),
    format.printf(({ timestamp, level, message, ...meta }: any) => {
      return `${timestamp} [${level.toUpperCase()}] MongoVerifier: ${message} ${Object.keys(meta).length ? JSON.stringify(meta) : ''}`;
    })
  ),
  transports: [
    new transports.Console()
  ]
});

/**
 * Job document structure from MongoDB
 */
export interface JobDocument {
  _id: any;
  id: string;
  created_at: Date;
  status: string;
  start_date?: Date | null;
  last_pinged?: Date | null;
  completed_at?: Date | null;
  assigned_to?: string | null;
  assigned_date?: Date | null;
  metadata: {
    video_owner: string;
    video_permlink: string;
  };
  storageMetadata: {
    app: string;
    key: string;
    type: string;
  };
  input: {
    uri: string;
    size: number;
  };
  result?: any | null;
  last_pinged_diff?: Date | null;
  attempt_count?: number;
}

/**
 * 🛡️ TANK MODE: MongoDB Direct Verification Service
 * 
 * When gateway APIs fail or return 500 errors, this service connects directly
 * to the MongoDB database to verify job ownership. This bypasses gateway 
 * inconsistencies and provides ground-truth job state information.
 */
export class MongoVerifier {
  private client: MongoClient | null = null;
  private db: Db | null = null;
  private jobs: Collection<JobDocument> | null = null;
  private config: EncoderConfig;
  private isConnected: boolean = false;
  private connectionAttempts: number = 0;
  private maxConnectionAttempts: number = 3;

  constructor(config: EncoderConfig) {
    this.config = config;
  }

  /**
   * Initialize MongoDB connection
   */
  async initialize(): Promise<void> {
    if (!this.config.mongodb?.enabled) {
      logger.info('🚫 MongoDB verification disabled - skipping initialization');
      return;
    }

    if (!this.config.mongodb?.uri || !this.config.mongodb?.database_name) {
      logger.warn('⚠️ MongoDB verification enabled but missing URI or database name - skipping initialization');
      return;
    }

    try {
      logger.info('🔌 Initializing MongoDB direct verification connection...');
      logger.info(`📊 Target: ${this.config.mongodb.database_name} database`);
      
      // Create MongoDB client with appropriate timeouts
      this.client = new MongoClient(this.config.mongodb.uri, {
        connectTimeoutMS: this.config.mongodb.connection_timeout || 10000,
        socketTimeoutMS: this.config.mongodb.socket_timeout || 30000,
        serverSelectionTimeoutMS: 15000,
        maxPoolSize: 5,
        minPoolSize: 1
      });

      // Connect to MongoDB
      await this.client.connect();
      logger.info('✅ MongoDB client connected successfully');

      // Get database and collection references
      this.db = this.client.db(this.config.mongodb.database_name);
      this.jobs = this.db.collection<JobDocument>('jobs');
      
      // Test the connection with a simple operation
      await this.jobs.findOne({}, { limit: 1 });
      
      this.isConnected = true;
      this.connectionAttempts = 0;
      
      logger.info('✅ MongoDB direct verification initialized successfully');
      logger.info('🛡️ Ready to provide ground-truth job ownership verification');
      
    } catch (error) {
      this.connectionAttempts++;
      logger.error('❌ Failed to initialize MongoDB direct verification:', error);
      
      if (this.connectionAttempts >= this.maxConnectionAttempts) {
        logger.error(`🚨 MongoDB connection failed after ${this.maxConnectionAttempts} attempts - direct verification unavailable`);
      }
      
      // Cleanup on failure
      await this.cleanup();
      throw error;
    }
  }

  /**
   * Verify job ownership directly from MongoDB
   * This is the nuclear option when gateway APIs are unreliable
   */
  async verifyJobOwnership(jobId: string, expectedOwnerDID: string): Promise<{
    isOwned: boolean;
    jobExists: boolean;
    actualOwner?: string | null;
    status?: string;
    rawDocument?: JobDocument;
  }> {
    if (!this.isEnabled()) {
      throw new Error('MongoDB verification not enabled or not connected');
    }

    try {
      logger.info(`🔍 DIRECT_VERIFICATION: Querying MongoDB for job ${jobId}`);
      logger.info(`🔍 Expected owner DID: ${expectedOwnerDID}`);
      
      // Query the job directly from MongoDB
      const jobDoc = await this.jobs!.findOne({ id: jobId });
      
      if (!jobDoc) {
        logger.warn(`⚠️ Job ${jobId} not found in MongoDB - may be invalid job ID`);
        return {
          isOwned: false,
          jobExists: false
        };
      }

      logger.info(`📄 Found job ${jobId} in MongoDB:`);
      logger.info(`📊 Status: ${jobDoc.status || 'unknown'}`);
      logger.info(`📊 Assigned to: ${jobDoc.assigned_to || 'unassigned'}`);
      logger.info(`📊 Created: ${jobDoc.created_at}`);
      logger.info(`📊 Last pinged: ${jobDoc.last_pinged || 'never'}`);

      // Normalize DIDs for comparison (handle format mismatches)
      const normalizeOwner = (owner: string | null): string => {
        if (!owner) return '';
        if (owner.startsWith('did:key:')) return owner;
        if (owner.startsWith('did')) return `did:key:${owner.substring(3)}`;
        return owner;
      };

      const normalizedExpected = normalizeOwner(expectedOwnerDID);
      const normalizedActual = normalizeOwner(jobDoc.assigned_to || null);

      logger.info(`🔍 DID_COMPARISON: Expected="${normalizedExpected}"`);
      logger.info(`🔍 DID_COMPARISON: Actual="${normalizedActual}"`);

      const isOwned = normalizedActual === normalizedExpected;

      if (isOwned) {
        logger.info(`✅ OWNERSHIP_CONFIRMED: Job ${jobId} is correctly assigned to us in MongoDB`);
      } else if (jobDoc.assigned_to) {
        logger.warn(`⚠️ OWNERSHIP_CONFLICT: Job ${jobId} is assigned to different encoder: ${jobDoc.assigned_to}`);
      } else {
        logger.warn(`⚠️ UNASSIGNED_JOB: Job ${jobId} is not assigned to any encoder`);
      }

      return {
        isOwned,
        jobExists: true,
        actualOwner: jobDoc.assigned_to || null,
        status: jobDoc.status,
        rawDocument: jobDoc
      };

    } catch (error) {
      logger.error(`❌ MongoDB direct verification failed for job ${jobId}:`, error);
      
      // If connection is lost, mark as disconnected
      if (error instanceof Error && (
        error.message.includes('connection') || 
        error.message.includes('timeout') ||
        error.message.includes('ECONNREFUSED')
      )) {
        this.isConnected = false;
        logger.warn('🔌 MongoDB connection lost - will need to reconnect');
      }
      
      throw new Error(`MongoDB verification failed: ${error instanceof Error ? error.message : 'Unknown error'}`);
    }
  }

  /**
   * Get job details directly from MongoDB (useful for debugging)
   */
  async getJobDetails(jobId: string): Promise<JobDocument | null> {
    if (!this.isEnabled()) {
      throw new Error('MongoDB verification not enabled or not connected');
    }

    try {
      const jobDoc = await this.jobs!.findOne({ id: jobId });
      return jobDoc;
    } catch (error) {
      logger.error(`❌ Failed to get job details for ${jobId}:`, error);
      throw error;
    }
  }

  /**
   * Check if MongoDB verification is enabled and ready
   */
  isEnabled(): boolean {
    return !!(
      this.config.mongodb?.enabled && 
      this.config.mongodb?.uri && 
      this.config.mongodb?.database_name &&
      this.isConnected && 
      this.client && 
      this.jobs
    );
  }

  /**
   * Get connection status information
   */
  getStatus(): {
    enabled: boolean;
    connected: boolean;
    connectionAttempts: number;
    databaseName?: string;
    lastError?: string;
  } {
    const result: {
      enabled: boolean;
      connected: boolean;
      connectionAttempts: number;
      databaseName?: string;
      lastError?: string;
    } = {
      enabled: !!this.config.mongodb?.enabled,
      connected: this.isConnected,
      connectionAttempts: this.connectionAttempts
    };
    
    if (this.config.mongodb?.database_name) {
      result.databaseName = this.config.mongodb.database_name;
    }
    
    return result;
  }

  /**
   * Attempt to reconnect to MongoDB
   */
  async reconnect(): Promise<void> {
    logger.info('🔄 Attempting to reconnect to MongoDB...');
    
    await this.cleanup();
    await this.initialize();
  }

  /**
   * Clean up MongoDB connection
   */
  async cleanup(): Promise<void> {
    this.isConnected = false;
    
    if (this.client) {
      try {
        await this.client.close();
        logger.info('🧹 MongoDB client connection closed');
      } catch (error) {
        logger.warn('⚠️ Error closing MongoDB client:', error);
      }
    }
    
    this.client = null;
    this.db = null;
    this.jobs = null;
  }

  /**
   * Update job status and progress in MongoDB
   */
  async updateJob(jobId: string, updates: any): Promise<void> {
    if (!this.isEnabled()) {
      throw new Error('MongoDB verification not enabled');
    }

    try {
      const updateResult = await this.jobs!.updateOne(
        { id: jobId },
        { $set: updates }
      );

      if (updateResult.matchedCount === 0) {
        throw new Error(`Job ${jobId} not found in MongoDB`);
      }

    } catch (error) {
      logger.error(`❌ Failed to update job ${jobId} in MongoDB:`, error);
      throw error;
    }
  }

  /**
   * 🚀 FORCE MODE: Update job directly in MongoDB (bypass gateway)
   * This is the nuclear option for 3Speak infrastructure nodes
   */
  async forceCompleteJob(jobId: string, result: { cid: string }): Promise<void> {
    if (!this.isEnabled()) {
      throw new Error('MongoDB verification not enabled - cannot force complete job');
    }

    try {
      logger.info(`🚀 FORCE_COMPLETE: Updating job ${jobId} directly in MongoDB`);
      logger.info(`📊 Setting status=complete, result={cid: ${result.cid}, message: 'Force processed successfully'}`);
      
      const updateResult = await this.jobs!.updateOne(
        { id: jobId },
        {
          $set: {
            status: 'complete',
            completed_at: new Date(),
            last_pinged: new Date(),
            result: {
              cid: result.cid,
              message: 'Force processed successfully'
            },
            'progress.pct': 100,
            'progress.download_pct': 100
          }
        }
      );

      if (updateResult.matchedCount === 0) {
        throw new Error(`Job ${jobId} not found in MongoDB`);
      }

      if (updateResult.modifiedCount === 0) {
        logger.warn(`⚠️ Job ${jobId} was found but not modified - may already be complete`);
      } else {
        logger.info(`✅ FORCE_COMPLETE: Job ${jobId} marked as complete in MongoDB`);
        logger.info(`🎉 Video should now be published automatically`);
      }

    } catch (error) {
      logger.error(`❌ Failed to force complete job ${jobId}:`, error);
      throw error;
    }
  }

  /**
   * Health check for MongoDB connection
   */
  async healthCheck(): Promise<boolean> {
    if (!this.isEnabled()) {
      return false;
    }

    try {
      // Simple ping to verify connection
      await this.db!.admin().ping();
      return true;
    } catch (error) {
      logger.warn('⚠️ MongoDB health check failed:', error);
      this.isConnected = false;
      return false;
    }
  }
}