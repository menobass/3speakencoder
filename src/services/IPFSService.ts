import { create } from 'ipfs-http-client';
import { EncoderConfig } from '../config/ConfigLoader';
import { logger } from './Logger';

export class IPFSService {
  private config: EncoderConfig;
  private client: any;
  private peerId: string = '';

  constructor(config: EncoderConfig) {
    this.config = config;
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
      
    } catch (error: any) {
      logger.warn(`⚠️ 3Speak IPFS health check failed:`, error.message);
      logger.warn(`⚠️ Uploads may fail or be slow - consider checking IPFS node status`);
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
      const fileStream = fs.createReadStream(filePath);
      form.append('file', fileStream, fileName);
      
      // Calculate timeout based on file size
      const timeoutMs = Math.max(60000, 60000 + Math.floor(stats.size / (10 * 1024 * 1024)) * 30000);
      logger.info(`⏱️ Upload timeout set to: ${Math.floor(timeoutMs / 1000)}s`);
      
      const response = await axios.default.post(`${threeSpeakIPFS}/api/v0/add`, form, {
        headers: {
          ...form.getHeaders(),
        },
        maxContentLength: Infinity,
        maxBodyLength: Infinity,
        timeout: timeoutMs,
        maxRedirects: 3,
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
      
      const result = JSON.parse(response.data);
      const hash = result.Hash;
      
      logger.info(`✅ File uploaded to 3Speak IPFS: ${hash}`);
      
      // 🛡️ TANK MODE: Bulletproof pin with verification (only if requested)
      if (pin) {
        logger.info(`🛡️ TANK MODE: Ensuring ${hash} is bulletproof pinned...`);
        await this.pinAndAnnounce(hash);
      }
      
      return hash;
    } catch (error) {
      logger.error('❌ File upload to 3Speak IPFS failed:', error);
      throw error;
    }
  }

  async uploadDirectory(dirPath: string, pin: boolean = false): Promise<string> {
    const maxRetries = 3;
    let lastError: any;
    
    for (let attempt = 1; attempt <= maxRetries; attempt++) {
      try {
        logger.info(`📤 Uploading directory ${dirPath} to 3Speak IPFS (attempt ${attempt}/${maxRetries})`);
        
        const result = await this.performDirectoryUpload(dirPath);
        
        // 🛡️ TANK MODE: Bulletproof pin with verification
        logger.info(`🛡️ TANK MODE: Ensuring ${result} is bulletproof pinned...`);
        await this.pinAndAnnounce(result);
        
        logger.info(`🎯 Directory upload complete and verified: ${result}`);
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
    for (const filePath of files) {
      const relativePath = path.relative(dirPath, filePath);
      const stats = await fs.stat(filePath);
      totalSize += stats.size;
      
      // Add file stream with proper path for directory structure
      const fileStream = require('fs').createReadStream(filePath);
      form.append('file', fileStream, {
        filename: relativePath,
        filepath: relativePath
      });
      
      logger.info(`📤 Adding to directory: ${relativePath} (${(stats.size / 1024 / 1024).toFixed(2)}MB)`);
    }
    
    logger.info(`📦 Total directory size: ${(totalSize / 1024 / 1024).toFixed(1)}MB in ${files.length} files`);
    
    // Calculate timeout based on total size
    const timeoutMs = Math.max(120000, Math.floor(totalSize / (1024 * 1024)) * 10000); // 2min base + 10s per MB
    logger.info(`⏱️ Directory upload timeout set to: ${Math.floor(timeoutMs / 1000)}s`);
    
    try {
      const response = await axios.default.post(`${threeSpeakIPFS}/api/v0/add?wrap-with-directory=true&recursive=true`, form, {
        headers: {
          ...form.getHeaders(),
        },
        maxContentLength: Infinity,
        maxBodyLength: Infinity,
        timeout: timeoutMs,
        validateStatus: (status) => status < 400,
        onUploadProgress: (progressEvent) => {
          if (progressEvent.total) {
            const percent = Math.round((progressEvent.loaded * 100) / progressEvent.total);
            if (percent % 25 === 0) { // Log every 25%
              logger.info(`� Directory upload progress: ${percent}% (${(progressEvent.loaded / 1024 / 1024).toFixed(1)}MB)`);
            }
          }
        }
      });
      
      // Parse response - should be newline-delimited JSON
      const lines = response.data.trim().split('\n');
      let directoryHash = '';
      
      // Find the directory hash (usually the last entry)
      for (const line of lines) {
        let result;
        if (typeof line === 'string') {
          result = JSON.parse(line);
        } else {
          result = line;
        }
        
        if (result.Name === '' || result.Name === dirPath || !result.Name) {
          directoryHash = result.Hash;
        }
      }
      
      if (!directoryHash) {
        throw new Error('Could not find directory hash in response');
      }
      
      logger.info(`✅ Directory uploaded successfully: ${directoryHash}`);
      return directoryHash;
      
    } catch (error: any) {
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
   * 🛡️ TANK MODE: Bulletproof pinning with verification and retries
   * This function WILL NOT return until content is verified pinned or max retries exhausted
   */
  private async pinAndAnnounce(hash: string): Promise<void> {
    const threeSpeakIPFS = this.config.ipfs?.threespeak_endpoint || 'http://65.21.201.94:5002';
    const axios = await import('axios');
    const maxRetries = 5; // More retries for pin operations
    const baseDelay = 2000; // Start with 2 second delay
    
    logger.info(`🛡️ TANK MODE: Initiating bulletproof pin for ${hash}`);

    // Step 1: Pin with retry logic
    for (let attempt = 1; attempt <= maxRetries; attempt++) {
      try {
        logger.info(`📌 Pinning attempt ${attempt}/${maxRetries}: ${hash}`);
        
        // Pin with recursive flag and longer timeout
        await axios.default.post(
          `${threeSpeakIPFS}/api/v0/pin/add?arg=${hash}&recursive=true&progress=true`,
          null,
          { timeout: 120000 } // 2 minute timeout for complex structures
        );
        
        logger.info(`✅ Pin command succeeded for ${hash}`);
        break; // Success, exit retry loop
        
      } catch (error: any) {
        const isLastAttempt = attempt === maxRetries;
        
        if (isLastAttempt) {
          logger.error(`❌ Pin failed after ${maxRetries} attempts for ${hash}:`, error.message);
          throw new Error(`CRITICAL: Pin failed after ${maxRetries} attempts - ${error.message}`);
        }
        
        const delay = Math.min(baseDelay * Math.pow(2, attempt - 1), 30000); // Max 30s
        logger.warn(`⚠️ Pin attempt ${attempt} failed, retrying in ${delay}ms:`, error.message);
        await new Promise(resolve => setTimeout(resolve, delay));
      }
    }

    // Step 2: VERIFY the pin actually worked
    logger.info(`🔍 Verifying pin status for ${hash}`);
    const pinVerified = await this.verifyPinStatus(hash, threeSpeakIPFS);
    
    if (!pinVerified) {
      throw new Error(`CRITICAL: Pin verification failed for ${hash} - content may not be persisted!`);
    }
    
    logger.info(`✅ Pin verified successfully: ${hash}`);

    // Step 3: Announce to DHT (best effort, don't fail if this fails)
    try {
      logger.info(`📢 Announcing to DHT: ${hash}`);
      await axios.default.post(
        `${threeSpeakIPFS}/api/v0/dht/provide?arg=${hash}`,
        null,
        { timeout: 60000 }
      );
      logger.info(`✅ Content announced to DHT: ${hash}`);
    } catch (error: any) {
      // DHT announce is nice-to-have, not critical
      logger.warn(`⚠️ DHT announcement failed (non-critical): ${error.message}`);
    }
    
    logger.info(`🎯 TANK MODE: ${hash} is fully pinned, verified, and announced!`);
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
      await this.client.pin.add(hash);
      logger.info(`📌 Pinned: ${hash}`);
    } catch (error) {
      logger.error(`❌ Failed to pin ${hash}:`, error);
      throw error;
    }
  }

  async unpinHash(hash: string): Promise<void> {
    try {
      await this.client.pin.rm(hash);
      logger.info(`📌 Unpinned: ${hash}`);
    } catch (error) {
      logger.warn(`⚠️ Failed to unpin ${hash}:`, error);
      // Don't throw, unpinning failures are not critical
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
    
    // Try to fetch the content to ensure it's actually retrievable
    try {
      const axios = await import('axios');
      logger.info(`🔍 Verifying content is retrievable: ${hash}`);
      
      // Just check if we can get the stat (don't download the whole thing)
      await axios.default.post(
        `${threeSpeakIPFS}/api/v0/object/stat?arg=${hash}`,
        null,
        { timeout: 30000 }
      );
      
      logger.info(`✅ Content ${hash} is retrievable`);
      return true;
      
    } catch (error: any) {
      logger.error(`🚨 Content ${hash} exists but is not retrievable:`, error.message);
      return false;
    }
  }
}