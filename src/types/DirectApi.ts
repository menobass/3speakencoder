import { EncodedOutput, JobStatus, VideoProfile } from './index.js';

// Direct API Types for miniservice integration
export interface DirectJobRequest {
  input_uri: string;
  video_id: string;
  profiles?: string[]; // e.g., ["1080p", "720p", "480p"]
  webhook_url?: string;
  priority?: 'normal' | 'high';
  metadata?: {
    [key: string]: any;
  };
}

export interface DirectJobResponse {
  job_id: string;
  status: JobStatus;
  message?: string;
  created_at: string;
  updated_at?: string;
  estimated_position?: number;
  progress?: number;
  result?: EncodedOutput[];
  error?: string;
}

export interface DirectJob {
  id: string;
  type: 'direct';
  status: JobStatus;
  created_at: string;
  updated_at?: string;
  request: DirectJobRequest;
  progress?: number;
  result?: EncodedOutput[];
  error?: string;
}

export interface WebhookPayload {
  video_id: string;
  job_id: string;
  status: JobStatus;
  result?: EncodedOutput[];
  error?: string;
  timestamp: string;
}