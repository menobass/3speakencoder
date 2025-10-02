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
    } catch (error) {
      logger.error('❌ Failed to connect to IPFS:', error);
      throw error;
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
      
      logger.info(`📥 Downloading ${hash} to ${outputPath}`);
      
      // Download file from IPFS
      const chunks: Uint8Array[] = [];
      for await (const chunk of this.client.cat(hash)) {
        chunks.push(chunk);
      }
      
      // Write to file
      const { writeFile } = await import('fs/promises');
      const buffer = Buffer.concat(chunks);
      await writeFile(outputPath, buffer);
      
      logger.info(`✅ Downloaded ${buffer.length} bytes`);
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
      const fs = await import('fs/promises');
      const path = await import('path');
      
      const buffer = await fs.readFile(filePath);
      const fileName = path.basename(filePath);
      
      logger.info(`📤 Uploading ${buffer.length} bytes to 3Speak IPFS: ${fileName}`);
      
      const form = new FormData.default();
      form.append('file', buffer, fileName);
      
      // Calculate timeout based on file size
      const timeoutMs = Math.max(60000, 60000 + Math.floor(buffer.length / (10 * 1024 * 1024)) * 30000);
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
      
      // TANK MODE: Pin + Announce for maximum reliability
      await this.pinAndAnnounce(hash);
      
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
        
        // TANK MODE: Pin + Announce for maximum reliability
        await this.pinAndAnnounce(result);
        
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
    
    // Add all files to form data with their relative paths
    for (const filePath of files) {
      const relativePath = path.relative(dirPath, filePath);
      const buffer = await fs.readFile(filePath);
      const stats = await fs.stat(filePath);
      totalSize += stats.size;
      
      // Add file with proper path for directory structure
      form.append('file', buffer, {
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

  private async pinAndAnnounce(hash: string): Promise<void> {
    const threeSpeakIPFS = this.config.ipfs?.threespeak_endpoint || 'http://65.21.201.94:5002';
    const axios = await import('axios');

    try {
      // Step 2: Pin the content for persistence
      logger.info(`📌 Pinning content: ${hash}`);
      await axios.default.post(`${threeSpeakIPFS}/api/v0/pin/add?arg=${hash}`, null, {
        timeout: 30000
      });
      logger.info(`✅ Content pinned: ${hash}`);

      // Step 3: Announce to DHT for faster discovery  
      logger.info(`📢 Announcing to DHT: ${hash}`);
      await axios.default.post(`${threeSpeakIPFS}/api/v0/dht/provide?arg=${hash}`, null, {
        timeout: 30000
      });
      logger.info(`✅ Content announced to DHT: ${hash}`);

    } catch (error) {
      // Don't fail the whole upload if pin/announce fails
      logger.warn(`⚠️ Pin/Announce failed for ${hash}:`, error);
      logger.info(`📤 Content still uploaded successfully: ${hash}`);
    }
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
}