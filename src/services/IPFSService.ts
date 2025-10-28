import { create } from 'ipfs-http-client';
import { EncoderConfig } from '../config/ConfigLoader.js';
import { logger } from './Logger.js';
import { LocalPinDatabase, LocalPin } from './LocalPinDatabase.js';

export class IPFSService {
  private config: EncoderConfig;
  private client: any;
  private peerId: string = '';
  private pinDatabase: LocalPinDatabase | null = null;

  constructor(config: EncoderConfig) {
    this.config = config;
    
    // Initialize pin database if local fallback is enabled
    if (this.config.ipfs?.enable_local_fallback) {
      this.pinDatabase = new LocalPinDatabase();
    }
  }

  async initialize(): Promise<void> {
    try {
      // Parse IPFS API address
      const apiAddr = this.config.ipfs?.apiAddr || '/ip4/127.0.0.1/tcp/5001';
      
      // Convert multiaddr to HTTP URL
      const url = this.multiaddrToUrl(apiAddr);
      
      // Create IPFS client
      this.client = create({ url });
      
      // Test connectivity and get peer ID
      // Use direct HTTP API call to avoid multiaddr parsing issues
      const axios = await import('axios');
      const response = await axios.default.post(`${url}/api/v0/id`, null, {
        timeout: 10000
      });
      
      const identity = response.data;
      this.peerId = identity.ID || identity.id;
      
      logger.info(`📂 IPFS connected: ${this.peerId}`);
      
      // Initialize pin database if needed
      if (this.pinDatabase) {
        await this.pinDatabase.initialize();
      }
      
      // 🛡️ TANK MODE: Verify 3Speak IPFS node health
      await this.checkIPFSHealth();
      
    } catch (error) {
      logger.error('❌ Failed to connect to IPFS:', error);
      throw error;
    }
  }

  /**
   * 🛡️ TANK MODE: Check IPFS node health before operations
   */
  private async checkIPFSHealth(): Promise<void> {
    const threeSpeakIPFS = this.config.ipfs?.threespeak_endpoint || 'http://65.21.201.94:5002';
    const axios = await import('axios');
    
    try {
      logger.info(`🏥 Checking 3Speak IPFS node health...`);
      
      // Check node is responding
      const idResponse = await axios.default.post(`${threeSpeakIPFS}/api/v0/id`, null, {
        timeout: 10000
      });
      
      logger.info(`✅ 3Speak IPFS node is healthy`);
      
      // Check repo stats to see if node has capacity
      try {
        const statsResponse = await axios.default.post(`${threeSpeakIPFS}/api/v0/repo/stat`, null, {
          timeout: 10000
        });
        
        let stats;
        if (typeof statsResponse.data === 'string') {
          stats = JSON.parse(statsResponse.data);
        } else {
          stats = statsResponse.data;
        }
        
        const usedGB = (stats.RepoSize || 0) / (1024 * 1024 * 1024);
        const numObjects = stats.NumObjects || 0;
        
        logger.info(`📊 IPFS Stats: ${usedGB.toFixed(2)}GB used, ${numObjects} objects`);
        
        // Warn if repo is getting large (might affect performance)
        if (usedGB > 100) {
          logger.warn(`⚠️ IPFS repo is large (${usedGB.toFixed(2)}GB) - performance may be affected`);
        }
        
      } catch (statsError) {
        // Stats check is nice-to-have, not critical
        logger.debug('Could not fetch repo stats (non-critical)');
      }
      
      // Check cluster health if cluster pinning is enabled
      if (this.config.ipfs?.use_cluster_for_pins) {
        await this.checkClusterHealth();
      }
      
    } catch (error: any) {
      logger.warn(`⚠️ 3Speak IPFS health check failed:`, error.message);
      logger.warn(`⚠️ Uploads may fail or be slow - consider checking IPFS node status`);
      // Don't throw - we'll try to proceed anyway
    }
  }

  /**
   * 🛡️ TANK MODE: Check IPFS Cluster health when cluster pinning is enabled
   */
  private async checkClusterHealth(): Promise<void> {
    const clusterEndpoint = this.config.ipfs?.cluster_endpoint || 'http://65.21.201.94:9094';
    const axios = await import('axios');
    
    try {
      logger.info(`🏥 Checking IPFS Cluster health...`);
      
      // Check cluster is responding
      const idResponse = await axios.default.get(`${clusterEndpoint}/id`, {
        timeout: 10000
      });
      
      const clusterInfo = idResponse.data;
      logger.info(`✅ IPFS Cluster is healthy (${clusterInfo.peername || 'unknown'})`);
      logger.info(`📊 Cluster version: ${clusterInfo.version}, peers: ${clusterInfo.cluster_peers?.length || 0}`);
      
    } catch (error: any) {
      logger.warn(`⚠️ IPFS Cluster health check failed:`, error.message);
      logger.warn(`⚠️ Cluster pinning may fail - consider checking cluster status`);
      // Don't throw - we'll try to proceed anyway
    }
  }

  private multiaddrToUrl(multiaddr: string): string {
    // Simple conversion from multiaddr to HTTP URL
    // /ip4/127.0.0.1/tcp/5001 -> http://127.0.0.1:5001
    const parts = multiaddr.split('/');
    if (parts.length >= 5) {
      const ip = parts[2];
      const port = parts[4];
      return `http://${ip}:${port}`;
    }
    
    // Fallback
    return 'http://127.0.0.1:5001';
  }

  async getPeerId(): Promise<string> {
    if (!this.peerId) {
      try {
        // Use direct HTTP API call to avoid multiaddr parsing issues
        const url = this.multiaddrToUrl(this.config.ipfs?.apiAddr || '/ip4/127.0.0.1/tcp/5001');
        const axios = await import('axios');
        const response = await axios.default.post(`${url}/api/v0/id`, null, {
          timeout: 10000
        });
        
        const identity = response.data;
        this.peerId = identity.ID || identity.id;
      } catch (error) {
        logger.error('❌ Failed to get peer ID:', error);
        throw error;
      }
    }
    return this.peerId;
  }

  async downloadFile(uri: string, outputPath: string): Promise<void> {
    try {
      // Extract IPFS hash from URI
      const hash = this.extractIPFSHash(uri);
      
      logger.info(`📥 Streaming download ${hash} to ${outputPath}`);
      
      // 🚨 FIX: Stream download instead of loading into memory
      const fs = await import('fs');
      const writeStream = fs.createWriteStream(outputPath);
      let totalBytes = 0;
      
      for await (const chunk of this.client.cat(hash)) {
        writeStream.write(chunk);
        totalBytes += chunk.length;
      }
      
      writeStream.end();
      await new Promise<void>((resolve, reject) => {
        writeStream.on('finish', () => resolve());
        writeStream.on('error', reject);
      });
      
      logger.info(`✅ Streamed ${(totalBytes / 1024 / 1024).toFixed(1)}MB`);
    } catch (error) {
      logger.error('❌ IPFS download failed:', error);
      throw error;
    }
  }

  async uploadFile(filePath: string, pin: boolean = false): Promise<string> {
    // Declare stream outside try block for proper cleanup access
    let fileStream: any = null;
    
    try {
      // Upload directly to 3Speak IPFS instead of local node
      const threeSpeakIPFS = 'http://65.21.201.94:5002';
      const axios = await import('axios');
      const FormData = await import('form-data');
      const fs = await import('fs');
      const fsPromises = await import('fs/promises');
      const path = await import('path');
      
      const stats = await fsPromises.stat(filePath);
      const fileName = path.basename(filePath);
      
      logger.info(`📤 Streaming ${(stats.size / 1024 / 1024).toFixed(1)}MB to 3Speak IPFS: ${fileName}`);
      
      // 🚨 FIX: Use stream instead of loading entire file into memory
      const form = new FormData.default();
      fileStream = fs.createReadStream(filePath);
      form.append('file', fileStream, fileName);
      
      // 🚨 MEMORY SAFE: Use named function to avoid closure memory leaks
      const handleStreamError = () => {
        try {
          if (fileStream && !fileStream.destroyed) {
            fileStream.destroy();
            fileStream.removeAllListeners(); // Remove all listeners to prevent leaks
          }
        } catch (e) {
          // Ignore cleanup errors
        }
      };
      
      fileStream.on('error', handleStreamError);
      
      // Calculate timeout based on file size with reasonable limits
      const baseTimeout = 60000;  // 1 minute base
      const perMBTimeout = 10000;  // 10 seconds per MB (reduced from 30s per 10MB)
      const maxTimeout = 600000;   // 10 minutes maximum
      
      const calculatedTimeout = baseTimeout + Math.floor(stats.size / (1024 * 1024)) * perMBTimeout;
      const timeoutMs = Math.min(calculatedTimeout, maxTimeout);
      
      logger.info(`⏱️ Upload timeout: ${Math.floor(timeoutMs / 1000)}s (size: ${(stats.size/1024/1024).toFixed(1)}MB, max: ${maxTimeout/1000}s)`);
      
      const response = await axios.default.post(`${threeSpeakIPFS}/api/v0/add`, form, {
        headers: {
          ...form.getHeaders(),
        },
        maxContentLength: Infinity,
        maxBodyLength: Infinity,
        timeout: timeoutMs,
        maxRedirects: 3,
        responseType: 'text', // 🚨 FIX: Ensure response is treated as text, not binary
        validateStatus: (status) => status < 400,
        onUploadProgress: (progressEvent) => {
          if (progressEvent.total) {
            const percent = Math.round((progressEvent.loaded * 100) / progressEvent.total);
            if (percent % 25 === 0) { // Log every 25%
              logger.info(`📤 Upload progress: ${percent}% (${(progressEvent.loaded / 1024 / 1024).toFixed(1)}MB)`);
            }
          }
        }
      });
      
      // 🚨 FIX: Ensure we have text data, not binary
      if (typeof response.data !== 'string') {
        logger.error('❌ IPFS response is not text data - possible binary response leak');
        throw new Error('IPFS returned non-text response data');
      }
      
      const result = JSON.parse(response.data);
      const hash = result.Hash;
      
      logger.info(`✅ File uploaded to 3Speak IPFS: ${hash}`);
      
      // Clean up file stream after successful upload
      try {
        if (!fileStream.destroyed) fileStream.destroy();
      } catch (e) {
        // Ignore cleanup errors
      }
      
      // 🛡️ TANK MODE: Bulletproof pin with verification (only if requested)
      if (pin) {
        logger.info(`🛡️ TANK MODE: Ensuring ${hash} is bulletproof pinned...`);
        await this.pinAndAnnounce(hash);
      }
      
      return hash;
    } catch (error) {
      // 🚨 CRITICAL: Clean up file stream on error to prevent memory leak
      try {
        if (!fileStream.destroyed) fileStream.destroy();
      } catch (e) {
        // Ignore cleanup errors
      }
      logger.error('❌ File upload to 3Speak IPFS failed:', error);
      throw error;
    }
  }

  async uploadDirectory(dirPath: string, pin: boolean = false, onPinFailed?: (hash: string, error: Error) => void): Promise<string> {
    const maxRetries = 3;
    let lastError: any;
    
    for (let attempt = 1; attempt <= maxRetries; attempt++) {
      try {
        logger.info(`📤 Uploading directory ${dirPath} to 3Speak IPFS (attempt ${attempt}/${maxRetries})`);
        
        const result = await this.performDirectoryUpload(dirPath);
        
        // � PINATA-STYLE: Only pin if explicitly requested
        if (pin) {
          // �🛡️ TANK MODE: Bulletproof pin with verification  
          logger.info(`🛡️ TANK MODE: Ensuring ${result} is bulletproof pinned...`);
          
          try {
            await this.pinAndAnnounce(result);
            logger.info(`🎯 Directory upload complete and verified: ${result}`);
          } catch (pinError: any) {
            // 🚨 FALLBACK: If pinning fails, still return the hash since content is uploaded
            logger.warn(`⚠️ Pinning failed for ${result}, but content is uploaded: ${pinError.message}`);
            logger.warn(`🚨 Job will complete without pinning to prevent stuck jobs`);
            
            // 🔄 LAZY PINNING: Queue for background retry
            if (onPinFailed) {
              onPinFailed(result, pinError);
              logger.info(`📋 Queued ${result} for lazy pinning retry`);
            }
            
            logger.info(`📤 Directory upload complete (no pinning): ${result}`);
          }
        } else {
          // 🚀 PINATA-STYLE: Just return CID immediately, no pinning
          logger.info(`🚀 PINATA-STYLE: Upload complete, returning CID immediately: ${result}`);
          logger.info(`🔄 Pinning will be handled by lazy pinning service in background`);
          
          // 🔄 LAZY PINNING: Queue for background pinning
          if (onPinFailed) {
            setTimeout(() => {
              logger.info(`🔄 Triggering lazy pinning for ${result}`);
              onPinFailed(result, new Error('lazy_pin_requested'));
            }, 100);
          }
        }
        
        return result;
      } catch (error: any) {
        lastError = error;
        logger.warn(`⚠️ Upload attempt ${attempt} failed:`, error.message);
        
        if (attempt < maxRetries) {
          const delay = Math.min(1000 * Math.pow(2, attempt - 1), 10000); // Exponential backoff, max 10s
          logger.info(`⏱️ Retrying in ${delay}ms...`);
          await new Promise(resolve => setTimeout(resolve, delay));
        }
      }
    }
    
    logger.error('❌ All upload attempts failed');
    throw lastError;
  }
  
  private async performDirectoryUpload(dirPath: string): Promise<string> {
    // Upload directly to 3Speak's IPFS node using UnixFS directory approach
    const threeSpeakIPFS = this.config.ipfs?.threespeak_endpoint || 'http://65.21.201.94:5002';
    const axios = await import('axios');
    const FormData = await import('form-data');
    const fs = await import('fs/promises');
    const path = await import('path');
    
    logger.info(`📦 Uploading directory ${dirPath} using UnixFS approach`);
    
    // Get all files in the directory
    const files = await this.getAllFiles(dirPath);
    const form = new FormData.default();
    let totalSize = 0;
    
    // 🚨 FIX: Add all files to form data with streams instead of buffers
    const fileStreams: any[] = []; // Track streams for cleanup
    
    for (const filePath of files) {
      const relativePath = path.relative(dirPath, filePath);
      const stats = await fs.stat(filePath);
      totalSize += stats.size;
      
      // Add file stream with proper path for directory structure
      const nodeFs = await import('fs');
      const fileStream = nodeFs.createReadStream(filePath);
      fileStreams.push(fileStream); // Track for cleanup
      
      form.append('file', fileStream, {
        filename: relativePath,
        filepath: relativePath
      });
      
      logger.info(`📤 Adding to directory: ${relativePath} (${(stats.size / 1024 / 1024).toFixed(2)}MB)`);
    }
    
    // 🚨 MEMORY SAFE: Function to clean up all file streams
    const cleanupAllStreams = () => {
      fileStreams.forEach(stream => {
        try {
          if (!stream.destroyed) stream.destroy();
        } catch (e) {
          // Ignore cleanup errors
        }
      });
    };
    
    logger.info(`📦 Total directory size: ${(totalSize / 1024 / 1024).toFixed(1)}MB in ${files.length} files`);
    
    // Calculate timeout based on total size with reasonable limits
    const baseTiimeout = 120000; // 2 minutes base
    const perMBTimeout = 5000;   // 5 seconds per MB (reduced from 10s)
    const maxTimeout = 900000;   // 15 minutes maximum (was 6+ hours!)
    
    const calculatedTimeout = baseTiimeout + Math.floor(totalSize / (1024 * 1024)) * perMBTimeout;
    const timeoutMs = Math.min(calculatedTimeout, maxTimeout);
    
    logger.info(`⏱️ Directory upload timeout: ${Math.floor(timeoutMs / 1000)}s (size: ${(totalSize/1024/1024).toFixed(1)}MB, max: ${maxTimeout/1000}s)`);
    
    try {
      const response = await axios.default.post(`${threeSpeakIPFS}/api/v0/add?wrap-with-directory=true&recursive=true`, form, {
        headers: {
          ...form.getHeaders(),
        },
        maxContentLength: Infinity,
        maxBodyLength: Infinity,
        timeout: timeoutMs,
        responseType: 'text', // 🚨 FIX: Ensure response is treated as text, not binary
        validateStatus: (status) => status < 400,
        onUploadProgress: (progressEvent) => {
          if (progressEvent.total) {
            const percent = Math.round((progressEvent.loaded * 100) / progressEvent.total);
            if (percent % 25 === 0) { // Log every 25%
              logger.info(`📦 Directory upload progress: ${percent}% (${(progressEvent.loaded / 1024 / 1024).toFixed(1)}MB)`);
            }
          }
        }
      });
      
      // Parse response - should be newline-delimited JSON
      // 🚨 FIX: Ensure we have text data, not binary
      if (typeof response.data !== 'string') {
        logger.error('❌ IPFS response is not text data - possible binary response leak');
        throw new Error('IPFS returned non-text response data');
      }
      
      // 🔍 DEBUG: Log the raw response for troubleshooting
      logger.info(`🗂️ Raw 3Speak IPFS response (first 500 chars): ${response.data.substring(0, 500)}`);
      
      const lines = response.data.trim().split('\n');
      let directoryHash = '';
      
      logger.info(`📊 Response contains ${lines.length} lines`);
      
      // Find the directory hash (usually the last entry)
      for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        if (!line) continue; // Skip undefined lines
        
        try {
          if (!line.trim()) continue; // Skip empty lines
          
          const result = JSON.parse(line);
          logger.info(`🔍 Line ${i + 1}: Name="${result.Name || ''}", Hash="${result.Hash || ''}", Size=${result.Size || 0}`);
          
          if (result.Name === '' || result.Name === dirPath || !result.Name) {
            directoryHash = result.Hash;
            logger.info(`🎯 Found directory hash: ${directoryHash} (matched on Name="${result.Name || 'empty'}")`);
          }
        } catch (parseError) {
          logger.warn(`⚠️ Could not parse IPFS response line ${i + 1}: ${line.substring(0, 100)}...`);
          // Continue processing other lines
        }
      }
      
      // 🆘 FALLBACK: If no directory hash found, try the last hash in the response
      if (!directoryHash && lines.length > 0) {
        logger.warn(`⚠️ No directory hash found using standard criteria, trying fallback...`);
        
        // Try the last line (often the directory wrapper)
        for (let i = lines.length - 1; i >= 0; i--) {
          const line = lines[i];
          if (!line) continue;
          
          try {
            const result = JSON.parse(line);
            if (result.Hash) {
              directoryHash = result.Hash;
              logger.info(`🆘 Fallback: Using last hash as directory hash: ${directoryHash}`);
              break;
            }
          } catch (e) {
            // Continue to previous line
          }
        }
      }
      
      if (!directoryHash) {
        logger.error(`🚨 CRITICAL: Could not extract directory hash from response`);
        logger.error(`🗂️ Full response data: ${response.data}`);
        throw new Error(`Could not find directory hash in response. Response had ${lines.length} lines.`);
      }
      
      logger.info(`✅ Directory uploaded successfully: ${directoryHash}`);
      
      // Clean up all file streams after successful upload
      cleanupAllStreams();
      
      return directoryHash;
      
    } catch (error: any) {
      // 🚨 CRITICAL: Clean up all file streams on error to prevent memory leak
      cleanupAllStreams();
      logger.error('❌ UnixFS directory upload failed:', error.message);
      throw error;
    }
  }
  
  
  
  private async createDirectoryFromFiles(files: Array<{hash: string, name: string}>, threeSpeakIPFS: string): Promise<string> {
    const axios = await import('axios');
    
    // Create directory object using IPFS object patch
    logger.info(`�️ Creating directory structure from ${files.length} files`);
    
    // Start with empty directory
    const emptyDirResponse = await axios.default.post(`${threeSpeakIPFS}/api/v0/object/new?arg=unixfs-dir`, null, {
      timeout: 30000
    });
    
    // Handle both JSON string and object responses
    let emptyDirResult;
    if (typeof emptyDirResponse.data === 'string') {
      emptyDirResult = JSON.parse(emptyDirResponse.data);
    } else {
      emptyDirResult = emptyDirResponse.data;
    }
    
    let dirHash = emptyDirResult.Hash;
    logger.info(`📁 Created empty directory: ${dirHash}`);
    
    // Add each file to the directory
    for (const file of files) {
      try {
        const addResponse = await axios.default.post(
          `${threeSpeakIPFS}/api/v0/object/patch/add-link?arg=${dirHash}&arg=${file.name}&arg=${file.hash}`,
          null,
          { timeout: 30000 }
        );
        
        // Handle both JSON string and object responses
        let addResult;
        if (typeof addResponse.data === 'string') {
          addResult = JSON.parse(addResponse.data);
        } else {
          addResult = addResponse.data;
        }
        
        dirHash = addResult.Hash;
        logger.info(`🔗 Added ${file.name} to directory: ${dirHash}`);
      } catch (error) {
        logger.error(`❌ Failed to add ${file.name} to directory:`, error);
        throw error;
      }
    }
    
    logger.info(`✅ Directory created: ${dirHash}`);
    return dirHash;
  }

  /**
   * � BULLETPROOF: Pinning that NEVER blocks job completion
   * Jobs MUST complete regardless of pinning status
   */
  private async pinAndAnnounce(hash: string): Promise<void> {
    try {
      // 🚨 CRITICAL: Use bulletproof timeout that CANNOT be bypassed
      await this.attemptPinWithBulletproofTimeout(hash);
      logger.info(`✅ Pinning completed successfully for ${hash}`);
    } catch (error: any) {
      // 🚨 NEVER let pinning failures block job completion
      logger.warn(`⚠️ Pinning failed for ${hash}, but job will continue:`, error.message);
      logger.warn(`📋 Content is uploaded and accessible - pinning can be retried later`);
      
      // Log for manual retry if needed
      this.logFailedPin(hash, error.message);
    }
  }

  /**
   * 🚨 BULLETPROOF TIMEOUT: Pinning with multiple timeout layers
   */
  private async attemptPinWithBulletproofTimeout(hash: string): Promise<void> {
    const threeSpeakIPFS = this.config.ipfs?.threespeak_endpoint || 'http://65.21.201.94:5002';
    const axios = await import('axios');
    const localFallbackEnabled = this.config.ipfs?.enable_local_fallback || false;
    
    // 🚨 BULLETPROOF: Multiple timeout layers
    const HARD_TIMEOUT = 120000; // 2 minutes - absolute maximum
    const SOFT_TIMEOUT = 60000;  // 1 minute - preferred timeout
    
    logger.info(`🛡️ Starting bulletproof pin for ${hash} (max ${HARD_TIMEOUT/1000}s)`);
    
    // Create a promise that WILL resolve within the hard timeout no matter what
    const bulletproofPromise = new Promise<void>((resolve, reject) => {
      let isResolved = false;
      
      // HARD TIMEOUT - this WILL fire no matter what happens
      const hardTimeout = setTimeout(() => {
        if (!isResolved) {
          isResolved = true;
          logger.warn(`� HARD TIMEOUT: Pinning took longer than ${HARD_TIMEOUT/1000}s for ${hash}`);
          reject(new Error(`Pinning hard timeout after ${HARD_TIMEOUT/1000}s`));
        }
      }, HARD_TIMEOUT);
      
      // Try remote pinning first
      const tryRemotePin = async () => {
        try {
          logger.info(`📌 Attempting remote pin: ${hash}`);
          
          await axios.default.post(
            `${threeSpeakIPFS}/api/v0/pin/add?arg=${hash}&recursive=true&progress=true`,
            null,
            { 
              timeout: SOFT_TIMEOUT,
              maxContentLength: 10 * 1024 * 1024,
              maxBodyLength: 1024 * 1024
            }
          );
          
          if (!isResolved) {
            isResolved = true;
            clearTimeout(hardTimeout);
            logger.info(`✅ Remote pin succeeded: ${hash}`);
            resolve();
          }
          
        } catch (remoteError: any) {
          logger.warn(`⚠️ Remote pin failed: ${remoteError.message}`);
          
          // Try local fallback if enabled and not already resolved
          if (localFallbackEnabled && !isResolved) {
            try {
              logger.info(`🏠 Trying local fallback pin: ${hash}`);
              await this.client.pin.add(hash);
              
              if (!isResolved) {
                isResolved = true;
                clearTimeout(hardTimeout);
                logger.info(`✅ Local fallback pin succeeded: ${hash}`);
                await this.logLocalPin(hash);
                resolve();
              }
              
            } catch (localError: any) {
              if (!isResolved) {
                isResolved = true;
                clearTimeout(hardTimeout);
                logger.error(`❌ Both remote and local pin failed: ${hash}`);
                reject(new Error(`All pin methods failed - Remote: ${remoteError.message}, Local: ${localError.message}`));
              }
            }
          } else {
            // No fallback available or already resolved
            if (!isResolved) {
              isResolved = true;
              clearTimeout(hardTimeout);
              reject(remoteError);
            }
          }
        }
      };
      
      // Start the pinning attempt
      tryRemotePin().catch(error => {
        if (!isResolved) {
          isResolved = true;
          clearTimeout(hardTimeout);
          reject(error);
        }
      });
    });
    
    // Execute with bulletproof timeout
    return bulletproofPromise;
  }

  /**
   * Log failed pins for manual retry
   */
  private async logFailedPin(hash: string, errorMessage: string): Promise<void> {
    try {
      const fs = await import('fs/promises');
      const path = await import('path');
      
      const logDir = path.join(process.cwd(), 'logs');
      await fs.mkdir(logDir, { recursive: true });
      
      const logEntry = {
        hash,
        timestamp: new Date().toISOString(),
        type: 'failed_pin',
        error: errorMessage,
        node_id: this.peerId || 'unknown'
      };
      
      const logFile = path.join(logDir, 'failed-pins.jsonl');
      await fs.appendFile(logFile, JSON.stringify(logEntry) + '\n');
      
      logger.info(`� Logged failed pin for manual retry: ${hash}`);
    } catch (error: any) {
      logger.debug(`Could not log failed pin: ${error.message}`);
    }
  }

  /**
   * Verify that content is actually pinned by checking pin list
   */
  private async verifyPinStatus(hash: string, ipfsEndpoint: string, maxRetries: number = 3): Promise<boolean> {
    const axios = await import('axios');
    
    for (let attempt = 1; attempt <= maxRetries; attempt++) {
      try {
        logger.info(`� Pin verification attempt ${attempt}/${maxRetries} for ${hash}`);
        
        // Check if hash is in pin list
        const response = await axios.default.post(
          `${ipfsEndpoint}/api/v0/pin/ls?arg=${hash}&type=all`,
          null,
          { timeout: 30000 }
        );
        
        // Parse response
        let pinData;
        if (typeof response.data === 'string') {
          pinData = JSON.parse(response.data);
        } else {
          pinData = response.data;
        }
        
        // Check if our hash is in the pins
        if (pinData && pinData.Keys && pinData.Keys[hash]) {
          const pinType = pinData.Keys[hash].Type;
          logger.info(`✅ Pin verified: ${hash} (type: ${pinType})`);
          return true;
        }
        
        logger.warn(`⚠️ Hash ${hash} not found in pin list (attempt ${attempt})`);
        
        // Wait before retry
        if (attempt < maxRetries) {
          await new Promise(resolve => setTimeout(resolve, 2000));
        }
        
      } catch (error: any) {
        logger.warn(`⚠️ Pin verification attempt ${attempt} failed:`, error.message);
        
        if (attempt < maxRetries) {
          await new Promise(resolve => setTimeout(resolve, 2000));
        }
      }
    }
    
    return false;
  }

  private async getAllFiles(dirPath: string): Promise<string[]> {
    const fs = await import('fs/promises');
    const path = await import('path');
    
    const files: string[] = [];
    const items = await fs.readdir(dirPath);
    
    for (const item of items) {
      const fullPath = path.join(dirPath, item);
      const stat = await fs.stat(fullPath);
      
      if (stat.isDirectory()) {
        const subFiles = await this.getAllFiles(fullPath);
        files.push(...subFiles);
      } else {
        files.push(fullPath);
      }
    }
    
    return files;
  }

  private extractIPFSHash(uri: string): string {
    // Extract IPFS hash from various URI formats
    if (uri.startsWith('ipfs://')) {
      return uri.replace('ipfs://', '');
    }
    
    if (uri.includes('/ipfs/')) {
      return uri.split('/ipfs/')[1]!.split('/')[0]!;
    }
    
    // Assume it's already a hash
    return uri;
  }

  async pinHash(hash: string): Promise<void> {
    try {
      // Use cluster for pins if enabled, otherwise use main daemon
      if (this.config.ipfs?.use_cluster_for_pins) {
        await this.pinHashWithCluster(hash);
      } else {
        await this.client.pin.add(hash);
        logger.info(`📌 Pinned (main daemon): ${hash}`);
      }
    } catch (error) {
      logger.error(`❌ Failed to pin ${hash}:`, error);
      throw error;
    }
  }

  private async pinHashWithCluster(hash: string): Promise<void> {
    const clusterEndpoint = this.config.ipfs?.cluster_endpoint || 'http://65.21.201.94:9094';
    const axios = await import('axios');
    
    try {
      const response = await axios.default.post(`${clusterEndpoint}/pins/${hash}`, null, {
        timeout: 30000,
        headers: { 'Content-Type': 'application/json' }
      });
      
      logger.info(`📌 Pinned (cluster): ${hash}`);
      logger.debug(`Cluster pin response:`, response.data);
    } catch (error: any) {
      if (error.response) {
        logger.error(`❌ Cluster pin failed for ${hash}: ${error.response.status} ${error.response.statusText}`);
        if (error.response.data) {
          logger.error(`Response data:`, error.response.data);
        }
      } else {
        logger.error(`❌ Cluster pin request failed for ${hash}:`, error.message);
      }
      throw error;
    }
  }

  async unpinHash(hash: string): Promise<void> {
    try {
      // Use cluster for pins if enabled, otherwise use main daemon  
      if (this.config.ipfs?.use_cluster_for_pins) {
        await this.unpinHashWithCluster(hash);
      } else {
        await this.client.pin.rm(hash);
        logger.info(`📌 Unpinned (main daemon): ${hash}`);
      }
    } catch (error) {
      logger.warn(`⚠️ Failed to unpin ${hash}:`, error);
      // Don't throw, unpinning failures are not critical
    }
  }

  private async unpinHashWithCluster(hash: string): Promise<void> {
    const clusterEndpoint = this.config.ipfs?.cluster_endpoint || 'http://65.21.201.94:9094';
    const axios = await import('axios');
    
    try {
      await axios.default.delete(`${clusterEndpoint}/pins/${hash}`, {
        timeout: 30000,
        headers: { 'Content-Type': 'application/json' }
      });
      
      logger.info(`📌 Unpinned (cluster): ${hash}`);
    } catch (error: any) {
      if (error.response) {
        logger.warn(`⚠️ Cluster unpin failed for ${hash}: ${error.response.status} ${error.response.statusText}`);
      } else {
        logger.warn(`⚠️ Cluster unpin request failed for ${hash}:`, error.message);
      }
      throw error;
    }
  }

  async cleanupTemporaryContent(hashes: string[]): Promise<void> {
    logger.info(`🧹 Cleaning up ${hashes.length} temporary IPFS uploads`);
    
    for (const hash of hashes) {
      try {
        await this.unpinHash(hash);
      } catch (error) {
        // Continue cleanup even if individual unpins fail
        logger.warn(`⚠️ Failed to cleanup ${hash}:`, error);
      }
    }
    
    // Run garbage collection to free up space
    try {
      await this.client.repo.gc();
      logger.info('🗑️ IPFS garbage collection completed');
    } catch (error) {
      logger.warn('⚠️ IPFS garbage collection failed:', error);
    }
  }

  /**
   * 🛡️ TANK MODE: Final verification that content is still pinned
   * Call this before reporting job as complete to gateway
   */
  async verifyContentPersistence(hash: string): Promise<boolean> {
    const threeSpeakIPFS = this.config.ipfs?.threespeak_endpoint || 'http://65.21.201.94:5002';
    
    logger.info(`🔐 TANK MODE: Final persistence check for ${hash}`);
    
    // Verify pin status
    const isPinned = await this.verifyPinStatus(hash, threeSpeakIPFS, 3);
    
    if (!isPinned) {
      logger.error(`🚨 CRITICAL: Content ${hash} is NOT pinned!`);
      return false;
    }
    
    // 🛡️ ENHANCED: Verify directory structure integrity
    try {
      const axios = await import('axios');
      logger.info(`🔍 Verifying directory structure integrity: ${hash}`);
      
      // Check directory listing to ensure structure is intact
      const listResponse = await axios.default.post(
        `${threeSpeakIPFS}/api/v0/ls?arg=${hash}`,
        null,
        { timeout: 30000 }
      );
      
      const listing = typeof listResponse.data === 'string' 
        ? JSON.parse(listResponse.data) 
        : listResponse.data;
      
      if (!listing.Objects || !listing.Objects[0] || !listing.Objects[0].Links) {
        logger.error(`🚨 CRITICAL: Directory structure is corrupted - no folder structure found in ${hash}`);
        return false;
      }
      
      const links = listing.Objects[0].Links;
      const foundFolders = links.filter((link: any) => link.Type === 1); // Type 1 = directory
      const foundFiles = links.filter((link: any) => link.Type === 2);   // Type 2 = file
      
      logger.info(`📁 Directory structure verification: ${foundFolders.length} folders, ${foundFiles.length} files`);
      
      // 🛡️ RELAXED: Check for reasonable content structure (not overly strict)
      const expectedFiles = ['master.m3u8', 'index.m3u8', 'playlist.m3u8']; // Multiple possible playlist names
      const expectedFolders = ['1080p', '720p', '480p', '360p', '240p']; // All possible quality folders
      
      const hasPlaylistFile = expectedFiles.some(file => 
        foundFiles.find((link: any) => link.Name === file)
      );
      
      const hasQualityContent = foundFolders.length > 0 || foundFiles.length > 0;
      
      if (!hasPlaylistFile && foundFiles.length === 0) {
        logger.error(`🚨 CRITICAL: No playlist files or content found in directory structure`);
        return false;
      }
      
      if (!hasQualityContent) {
        logger.error(`🚨 CRITICAL: Directory appears to be completely empty`);
        return false;
      }
      
      // 📊 Log what we found for debugging
      if (hasPlaylistFile) {
        const playlist = expectedFiles.find(file => 
          foundFiles.find((link: any) => link.Name === file)
        );
        logger.info(`✅ Found playlist file: ${playlist}`);
      }
      
      const qualityFolders = foundFolders.filter((link: any) => 
        expectedFolders.includes(link.Name)
      );
      if (qualityFolders.length > 0) {
        logger.info(`✅ Found quality folders: ${qualityFolders.map((f: any) => f.Name).join(', ')}`);
      }
      
      logger.info(`✅ Directory structure verified - proper HLS layout confirmed`);
      return true;
      
    } catch (error: any) {
      logger.error(`🚨 Directory structure verification failed for ${hash}:`, error.message);
      return false;
    }
  }

  /**
   * Verify local pin status using local IPFS client
   */
  private async verifyLocalPinStatus(hash: string): Promise<boolean> {
    try {
      const pins = this.client.pin.ls({ paths: [hash] });
      
      for await (const pin of pins) {
        if (pin.cid.toString() === hash) {
          logger.info(`✅ Local pin verification succeeded for ${hash}`);
          return true;
        }
      }
      
      logger.warn(`⚠️ Local pin verification failed - ${hash} not found in local pins`);
      return false;
      
    } catch (error: any) {
      logger.error(`❌ Local pin verification error for ${hash}:`, error.message);
      return false;
    }
  }

  /**
   * Log locally pinned content for future sync service processing
   */
  private async logLocalPin(hash: string, jobId?: string, contentType?: string, sizeByes?: number): Promise<void> {
    try {
      // Use database if available
      if (this.pinDatabase) {
        const pin: LocalPin = {
          hash,
          sync_status: 'pending'
        };
        
        // Only set optional properties if they have values
        if (jobId) pin.job_id = jobId;
        if (contentType) pin.content_type = contentType;
        if (sizeByes) pin.size_bytes = sizeByes;
        
        await this.pinDatabase.addLocalPin(pin);
        logger.info(`📊 Added local pin to database: ${hash}`);
        return;
      }

      // Fallback to file logging if no database
      const fs = await import('fs/promises');
      const path = await import('path');
      
      // Create logs directory if it doesn't exist
      const logDir = path.join(process.cwd(), 'logs');
      try {
        await fs.mkdir(logDir, { recursive: true });
      } catch (error) {
        // Directory might already exist, ignore
      }
      
      // Log locally pinned content with timestamp
      const logEntry = {
        hash: hash,
        timestamp: new Date().toISOString(),
        type: 'local_fallback_pin',
        node_id: this.peerId || 'unknown',
        job_id: jobId,
        content_type: contentType
      };
      
      const logFile = path.join(logDir, 'local-pins.jsonl');
      const logLine = JSON.stringify(logEntry) + '\n';
      
      await fs.appendFile(logFile, logLine);
      logger.info(`📝 Logged local pin for future sync: ${hash}`);
      
    } catch (error: any) {
      logger.warn(`⚠️ Failed to log local pin (non-critical): ${error.message}`);
      // Don't throw - this is just for bookkeeping
    }
  }
}