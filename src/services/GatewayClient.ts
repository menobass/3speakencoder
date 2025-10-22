import axios, { AxiosInstance } from 'axios';
import { EncoderConfig } from '../config/ConfigLoader';
import { VideoJob, NodeInfo, GatewayJobResponse } from '../types';
import { IdentityService } from './IdentityService';
import { logger } from './Logger';
import { cleanErrorForLogging } from '../common/errorUtils.js';

export class GatewayClient {
  private config: EncoderConfig;
  private apiUrl: string;
  private client: AxiosInstance;
  private identity?: IdentityService;

  constructor(config: EncoderConfig) {
    this.config = config;
    this.apiUrl = config.remote_gateway.api;
    
    this.client = axios.create({
      baseURL: this.apiUrl,
      timeout: 30000,
      headers: {
        'Content-Type': 'application/json',
        'User-Agent': '3Speak-Encoder-Modern/1.0.0'
      },
      // 🚨 MEMORY SAFE: Additional config to prevent memory leaks
      maxRedirects: 3,
      maxContentLength: 50 * 1024 * 1024, // 50MB max response size
      maxBodyLength: 50 * 1024 * 1024,    // 50MB max request size
    });

    // 🚨 MEMORY SAFE: Add interceptors to clean up failed requests
    this.client.interceptors.response.use(
      (response) => response,
      (error) => {
        // Clean up any large response data on error to prevent memory leaks
        if (error.response && error.response.data) {
          // Don't hold onto large error response bodies
          if (typeof error.response.data === 'object' && 
              JSON.stringify(error.response.data).length > 1000) {
            error.response.data = '[Large response data removed to prevent memory leak]';
          }
        }
        throw error;
      }
    );
  }

  async initialize(): Promise<void> {
    // Test gateway connectivity with retry logic
    const maxRetries = 3;
    let lastError: any;
    
    for (let attempt = 1; attempt <= maxRetries; attempt++) {
      try {
        logger.info(`🔍 Testing gateway connection (attempt ${attempt}/${maxRetries})...`);
        await this.client.get('/api/v0/gateway/stats', { timeout: 10000 });
        logger.info('🌐 Gateway connection verified');
        return;
      } catch (error) {
        lastError = error;
        logger.warn(`⚠️ Gateway connection attempt ${attempt} failed:`, cleanErrorForLogging(error));
        
        if (attempt < maxRetries) {
          const delay = 2000 * attempt; // 2s, 4s, 6s
          logger.info(`⏱️ Retrying gateway connection in ${delay}ms...`);
          await new Promise(resolve => setTimeout(resolve, delay));
        }
      }
    }
    
    logger.error('❌ Gateway connection failed after all retries:', cleanErrorForLogging(lastError));
    // Don't fail initialization completely, encoder should still work for direct API
    logger.warn('⚠️ Gateway features will be disabled, but direct API will still work');
  }

  setIdentityService(identity: IdentityService): void {
    this.identity = identity;
  }

  async updateNode(nodeInfo: NodeInfo): Promise<void> {
    if (!this.identity) {
      throw new Error('Identity service not set');
    }

    try {
      const jws = await this.identity.createJWS({ node_info: nodeInfo });
      
      const response = await this.client.post('/api/v0/gateway/updateNode', {
        jws
      });

      if (response.status !== 201 && response.status !== 200) {
        throw new Error(`Node registration failed with status ${response.status}: ${response.data}`);
      }

      logger.info('📡 Node registered successfully');
    } catch (error) {
      if (axios.isAxiosError(error)) {
        const status = error.response?.status;
        const message = error.response?.data?.message || error.message;
        logger.error(`❌ Gateway registration failed [${status}]: ${message}`);
        throw new Error(`Gateway registration failed: ${message}`);
      }
      throw error;
    }
  }

  async getJob(): Promise<VideoJob | null> {
    try {
      const response = await this.client.get<VideoJob>('/api/v0/gateway/getJob', { timeout: 15000 });
      
      if (response.data) {
        logger.debug('📋 Gateway job retrieved successfully');
        return response.data;
      }
      
      return null;
    } catch (error) {
      if (axios.isAxiosError(error)) {
        if (error.response?.status === 404) {
          // No jobs available - this is normal
          return null;
        } else if (error.code === 'ECONNREFUSED' || error.code === 'EHOSTUNREACH') {
          logger.warn('🔌 Gateway unreachable, will retry on next poll');
          return null;
        } else if (error.code === 'ENOTFOUND') {
          logger.warn('🌐 DNS resolution failed for gateway, will retry on next poll');
          return null;
        }
      }
      
      logger.error('❌ Gateway job polling error:', cleanErrorForLogging(error));
      throw error;
    }
  }

  async acceptJob(jobId: string): Promise<void> {
    if (!this.identity) {
      throw new Error('Identity service not set');
    }

    const jws = await this.identity.createJWS({ job_id: jobId });

    try {
      await this.client.post('/api/v0/gateway/acceptJob', {
        jws
      });
      logger.debug(`✅ Successfully accepted job: ${jobId}`);
    } catch (error) {
      // Handle "job already accepted by another encoder" scenario
      if (axios.isAxiosError(error)) {
        const status = error.response?.status;
        const errorMessage = error.response?.data?.message || error.message;

        const isAlreadyAccepted = status === 400 || status === 409 || (
          errorMessage.toLowerCase().includes('already') ||
          errorMessage.toLowerCase().includes('accepted') ||
          errorMessage.toLowerCase().includes('not assigned') ||
          errorMessage.toLowerCase().includes('invalid state')
        );

        if (isAlreadyAccepted) {
          logger.warn(`⚠️ Job ${jobId} was already accepted by another encoder: ${errorMessage}`);
          throw new Error(`Job already accepted by another encoder: ${errorMessage}`);
        }
      }

      // Re-throw other errors
      throw error;
    }
  }

  async rejectJob(jobId: string): Promise<void> {
    if (!this.identity) {
      throw new Error('Identity service not set');
    }

    const jws = await this.identity.createJWS({ job_id: jobId });
    
    await this.client.post('/api/v0/gateway/rejectJob', {
      jws
    });
  }

  async failJob(jobId: string, errorDetails: any): Promise<void> {
    if (!this.identity) {
      throw new Error('Identity service not set');
    }

    const jws = await this.identity.createJWS({ 
      job_id: jobId,
      error: errorDetails
    });
    
    await this.client.post('/api/v0/gateway/failJob', {
      jws
    });
  }

  async finishJob(jobId: string, result: any): Promise<any> {
    if (!this.identity) {
      throw new Error('Identity service not set');
    }

    // Extract the IPFS hash/CID from the result
    const cid = result.ipfs_hash || result.cid;
    if (!cid) {
      throw new Error('No IPFS CID found in result');
    }

    // Use the same format as the old working encoder
    const jws = await this.identity.createJWS({
      job_id: jobId,
      output: {
        cid: cid
      }
    });

    try {
      const response = await this.client.post('/api/v0/gateway/finishJob', {
        jws
      });

      return response.data;
    } catch (error) {
      // Handle "job already completed by another encoder" scenario
      if (axios.isAxiosError(error)) {
        const status = error.response?.status;
        const errorMessage = error.response?.data?.message || error.message;

        // Check for duplicate completion indicators
        const isDuplicateCompletion = status === 500 && (
          errorMessage.toLowerCase().includes('already') ||
          errorMessage.toLowerCase().includes('completed') ||
          errorMessage.toLowerCase().includes('duplicate') ||
          errorMessage.toLowerCase().includes('not assigned') ||
          errorMessage.toLowerCase().includes('invalid state')
        );

        if (isDuplicateCompletion) {
          logger.warn(`⚠️ Job ${jobId} was already completed by another encoder - treating as success`);
          logger.warn(`📋 Duplicate completion details: ${errorMessage}`);

          // Return synthetic success response
          return {
            success: true,
            message: 'Job already completed by another encoder',
            duplicate: true,
            originalError: errorMessage
          };
        }

        // Check for other gateway state errors that indicate the job is in an unexpected state
        const isStateError = status === 400 || status === 409;
        if (isStateError) {
          logger.warn(`⚠️ Job ${jobId} state conflict: ${errorMessage}`);
          throw new Error(`Job state conflict: ${errorMessage}`);
        }
      }

      // Re-throw other errors
      throw error;
    }
  }



  async pingJob(jobId: string, status: any): Promise<void> {
    if (!this.identity) {
      throw new Error('Identity service not set');
    }

    const jws = await this.identity.createJWS({ 
      job_id: jobId,
      status
    });
    
    await this.client.post('/api/v0/gateway/pingJob', {
      jws
    });
  }

  async cancelJob(jobId: string): Promise<void> {
    if (!this.identity) {
      throw new Error('Identity service not set');
    }

    const jws = await this.identity.createJWS({ job_id: jobId });
    
    await this.client.post('/api/v0/gateway/cancelJob', {
      jws
    });
  }

  async getNodeStats(nodeId: string): Promise<any> {
    const response = await this.client.get(`/api/v0/gateway/nodestats/${nodeId}`);
    return response.data;
  }

  async getJobStatus(jobId: string): Promise<any> {
    const response = await this.client.get(`/api/v0/gateway/jobstatus/${jobId}`);
    return response.data;
  }

  /**
   * Validate that a job is assigned to this encoder before processing
   */
  async validateJobOwnership(jobId: string): Promise<boolean> {
    try {
      const jobStatus = await this.getJobStatus(jobId);

      if (!jobStatus) {
        logger.warn(`⚠️ Job ${jobId} not found in gateway`);
        return false;
      }

      // Check if job is in a valid state for this encoder
      const validStates = ['assigned', 'accepted', 'running'];
      if (!validStates.includes(jobStatus.status)) {
        logger.warn(`⚠️ Job ${jobId} is in invalid state: ${jobStatus.status}`);
        return false;
      }

      // If the gateway tracks assigned encoder, we could check it here
      // For now, we assume if we got the job via getJob(), it's ours

      return true;
    } catch (error) {
      logger.warn(`⚠️ Failed to validate job ownership for ${jobId}:`, error);
      return false;
    }
  }

  async getAvailableJobs(): Promise<VideoJob[]> {
    // Note: The 3Speak gateway doesn't provide a public available jobs endpoint
    // We can only poll for jobs assigned to us via getJob()
    // For now, return empty array - we'd need gateway API changes to show available jobs
    logger.debug('📋 Available jobs endpoint not supported by gateway');
    return [];
  }

  async getGatewayStats(): Promise<any> {
    try {
      const response = await this.client.get('/api/v0/gateway/stats', { timeout: 10000 });
      return response.data;
    } catch (error) {
      logger.debug('❌ Failed to get gateway stats:', error);
      return null;
    }
  }
}