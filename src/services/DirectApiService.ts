import express from 'express';
import { Server } from 'http';
import { EncoderConfig } from '../config/ConfigLoader';
import { logger } from './Logger';
import { JobQueue } from '../services/JobQueue';
import { DirectJob, DirectJobRequest, DirectJobResponse, JobStatus } from '../types/index';

export class DirectApiService {
  private app: express.Application;
  private server: Server | null = null;
  private port: number;
  private config: EncoderConfig;
  private jobQueue: JobQueue;

  constructor(port: number, config: EncoderConfig, jobQueue: JobQueue) {
    this.port = port;
    this.config = config;
    this.jobQueue = jobQueue;
    this.app = express();
    this.setupMiddleware();
    this.setupRoutes();
  }

  private setupMiddleware(): void {
    this.app.use(express.json());
    this.app.use(express.urlencoded({ extended: true }));
    
    // CORS middleware
    this.app.use((req, res, next) => {
      res.header('Access-Control-Allow-Origin', '*');
      res.header('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
      res.header('Access-Control-Allow-Headers', 'Origin, X-Requested-With, Content-Type, Accept, Authorization, X-API-Key');
      if (req.method === 'OPTIONS') {
        res.sendStatus(200);
      } else {
        next();
      }
    });

    // API Key authentication middleware (skip health check)
    this.app.use((req, res, next) => {
      // Skip auth for health check
      if (req.path === '/health') {
        return next();
      }

      // Check if Direct API is enabled
      if (!this.config.direct_api?.enabled) {
        return res.status(503).json({
          job_id: '',
          status: 'failed' as any,
          created_at: new Date().toISOString(),
          error: 'Direct API is disabled on this node'
        });
      }

      // Validate API key
      const apiKey = req.headers['x-api-key'] || req.headers['authorization']?.replace('Bearer ', '');
      
      if (!apiKey || apiKey !== this.config.direct_api.api_key) {
        logger.warn(`🔒 Unauthorized direct API access attempt from ${req.ip}`);
        return res.status(401).json({
          job_id: '',
          status: 'failed' as any,
          created_at: new Date().toISOString(),
          error: 'Invalid or missing API key'
        });
      }

      next();
    });
  }

  private setupRoutes(): void {
    // Health check
    this.app.get('/health', (req, res) => {
      res.json({ status: 'healthy', timestamp: new Date().toISOString() });
    });

    // Submit encoding job
    this.app.post('/encode', async (req, res) => {
      try {
        const jobRequest: DirectJobRequest = req.body;
        
        // Validate request
        if (!jobRequest.input_uri) {
          return res.status(400).json({
            job_id: '',
            status: JobStatus.FAILED,
            created_at: new Date().toISOString(),
            error: 'input_uri is required'
          } as DirectJobResponse);
        }

        // Create job via JobQueue
        const job = await this.jobQueue.addDirectJob(jobRequest);
        
        return res.json({
          job_id: job.id,
          status: job.status,
          created_at: job.created_at,
          message: 'Job submitted successfully',
          progress: 0
        } as DirectJobResponse);

      } catch (error) {
        logger.error('Error submitting job:', error);
        return res.status(500).json({
          job_id: '',
          status: JobStatus.FAILED,
          created_at: new Date().toISOString(),
          error: 'Failed to submit job'
        } as DirectJobResponse);
      }
    });

    // Get job status
    this.app.get('/job/:jobId', (req, res) => {
      const jobId = req.params.jobId;
      const job = this.jobQueue.getJob(jobId) as DirectJob;
      
      if (!job) {
        return res.status(404).json({
          job_id: jobId,
          status: JobStatus.FAILED,
          created_at: new Date().toISOString(),
          error: 'Job not found'
        } as DirectJobResponse);
      }

      return res.json({
        job_id: job.id,
        status: job.status,
        created_at: job.created_at,
        updated_at: job.updated_at,
        progress: job.progress,
        result: job.result,
        error: job.error
      } as DirectJobResponse);
    });

    // List all jobs
    this.app.get('/jobs', (req, res) => {
      const totalJobs = this.jobQueue.getTotalCount();
      const pendingJobs = this.jobQueue.getPendingCount();
      const activeJobs = this.jobQueue.getActiveCount();
      
      return res.json({
        total: totalJobs,
        pending: pendingJobs,
        active: activeJobs
      });
    });
  }

  async start(): Promise<void> {
    return new Promise((resolve) => {
      this.server = this.app.listen(this.port, () => {
        logger.info(`Direct API service started on port ${this.port}`);
        resolve();
      });
    });
  }

  async stop(): Promise<void> {
    if (this.server) {
      return new Promise((resolve) => {
        this.server!.close(() => {
          logger.info('Direct API service stopped');
          resolve();
        });
      });
    }
  }
}