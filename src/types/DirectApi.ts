import { EncodedOutput, JobStatus, VideoProfile } from './index.js';

// Direct API Types for miniservice integration (3Speak Embeds)
export interface DirectJobRequest {
  // 🎯 VIDEO IDENTIFICATION (matches embed collection)
  owner: string;              // Video owner username
  permlink: string;           // Unique video identifier
  input_cid: string;          // IPFS hash of raw uploaded file
  
  // 🎬 ENCODING SETTINGS
  short: boolean;             // true = 480p only + 60s trim, false = full encoding
  
  // 🔔 CALLBACK NOTIFICATION
  webhook_url: string;        // URL to POST completion notification
  api_key: string;            // API key for webhook authentication
  
  // 📊 OPTIONAL METADATA (pass-through)
  frontend_app?: string;      // App that initiated request
  originalFilename?: string;  // Original uploaded filename
  duration?: number;          // Video duration in seconds (if known)
  
  // Legacy support (deprecated)
  input_uri?: string;         // DEPRECATED: Use input_cid instead
  video_id?: string;          // DEPRECATED: Use owner/permlink instead
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
  // 🎯 IDENTIFICATION (from original request)
  owner: string;
  permlink: string;
  input_cid: string;
  
  // ✅ ENCODING RESULT
  status: 'complete' | 'failed';
  manifest_cid?: string;      // IPFS hash of encoded HLS directory
  video_url?: string;          // Full IPFS URI to manifest.m3u8
  
  // 📊 PROCESSING INFO
  job_id: string;
  processing_time_seconds: number;
  qualities_encoded: string[];  // ["1080p", "720p", "480p"] or ["480p"]
  encoder_id: string;
  
  // 🚨 ERROR INFO (if failed)
  error?: string;
  
  // 📋 PASS-THROUGH METADATA
  frontend_app?: string;
  originalFilename?: string;
  
  // Timestamp
  timestamp: string;
}