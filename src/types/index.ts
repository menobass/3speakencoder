// Job related types
export interface VideoJob {
  id: string;
  type?: 'gateway'; // Job type identifier
  status: JobStatus;
  created_at: string;
  updated_at?: string;
  input: {
    uri: string;
    size: number;
    format?: string;
  };
  metadata: {
    video_owner: string;
    video_permlink: string;
  };
  storageMetadata: {
    app: string;
    key: string;
    type: string;
  };
  profiles: VideoProfile[];
  output: EncodedOutput[];
  progress?: number;
  download_pct?: number;
  result?: EncodedOutput[]; // For consistency with DirectJob
  error?: string; // For error tracking
}

export interface VideoProfile {
  name: string;
  size: string; // e.g., "?x1080", "?x720", "?x480"
  width?: number;
  height?: number;
  bitrate?: string;
}

export interface EncodedOutput {
  profile: string;
  path: string;
  size: number;
  duration: number;
  segments: string[];
  playlist: string;
  ipfsHash?: string;  // IPFS hash of the uploaded directory
  uri?: string;       // IPFS URI pointing to the playlist
}

export enum JobStatus {
  PENDING = 'pending',
  QUEUED = 'queued', 
  ASSIGNED = 'assigned',
  DOWNLOADING = 'downloading',
  RUNNING = 'running',
  UPLOADING = 'uploading',
  COMPLETE = 'complete',
  FAILED = 'failed',
  CANCELLED = 'cancelled'
}

// Gateway API types
export interface GatewayJobResponse {
  data: {
    queueJob: {
      reason: string;
      job: VideoJob;
    };
  };
}

export interface NodeInfo {
  name: string;
  cryptoAccounts: {
    hive: string;
  };
  peer_id: string;
  commit_hash: string;
}

export interface JWSPayload {
  node_info: NodeInfo;
}

// Encoder types
export interface CodecCapability {
  name: string;
  type: 'hardware' | 'software';
  available: boolean;
  tested: boolean;
  priority: number;
}

export interface EncodingProgress {
  jobId: string;
  profile: string;
  percent: number;
  fps?: number;
  bitrate?: string;
  eta?: string;
}

export interface SystemCapabilities {
  ffmpeg: {
    version: string;
    codecs: CodecCapability[];
  };
  hardware: {
    gpu: boolean;
    qsv: boolean;
    nvenc: boolean;
    vaapi: boolean;
  };
  system: {
    cpu_cores: number;
    memory_gb: number;
    os: string;
  };
}

// Re-export DirectApi types
export * from './DirectApi';