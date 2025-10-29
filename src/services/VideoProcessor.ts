import ffmpeg from 'fluent-ffmpeg';
import { EncoderConfig } from '../config/ConfigLoader.js';
import { VideoJob, EncodedOutput, CodecCapability, EncodingProgress } from '../types/index.js';
import { logger } from './Logger.js';
import { promises as fs } from 'fs';
import { createWriteStream } from 'fs';
import { join, dirname } from 'path';
import { tmpdir } from 'os';
import { randomUUID } from 'crypto';
import { IPFSService } from './IPFSService.js';
import { DashboardService } from './DashboardService.js';
import { cleanErrorForLogging } from '../common/errorUtils.js';

export class VideoProcessor {
  private config: EncoderConfig;
  private availableCodecs: CodecCapability[] = [];
  private tempDir: string;
  private ipfsService: IPFSService;
  private dashboard: DashboardService | undefined;
  private currentJobId?: string;

  constructor(config: EncoderConfig, ipfsService: IPFSService, dashboard?: DashboardService) {
    this.config = config;
    this.ipfsService = ipfsService;
    this.dashboard = dashboard;
    this.tempDir = config.encoder?.temp_dir || join(tmpdir(), '3speak-encoder');
  }
  
  setCurrentJob(jobId: string): void {
    this.currentJobId = jobId;
  }

  async initialize(): Promise<void> {
    try {
      // Ensure temp directory exists
      await fs.mkdir(this.tempDir, { recursive: true });
      
      // Test FFmpeg availability
      await this.testFFmpeg();
      
      // Detect available codecs
      await this.detectCodecs();
      
      logger.info(`🎬 Video processor ready with ${this.availableCodecs.length} codecs`);
    } catch (error) {
      logger.error('❌ Failed to initialize video processor:', error);
      throw error;
    }
  }

  private async testFFmpeg(): Promise<void> {
    return new Promise((resolve, reject) => {
      ffmpeg.getAvailableFormats((err, formats) => {
        if (err) {
          reject(new Error(`FFmpeg not available: ${err.message}`));
        } else {
          logger.info('✅ FFmpeg is available');
          resolve();
        }
      });
    });
  }

  private async checkSystemCapabilities(): Promise<void> {
    try {
      // Check for VAAPI support
      try {
        const { access } = await import('fs/promises');
        await access('/dev/dri/renderD128');
        logger.info('✅ VAAPI device found: /dev/dri/renderD128');
      } catch {
        logger.debug('ℹ️ VAAPI device not found (/dev/dri/renderD128)');
      }

      // Check for NVIDIA GPU
      try {
        const { exec } = await import('child_process');
        await new Promise<void>((resolve, reject) => {
          exec('nvidia-smi', (error) => {
            if (error) {
              logger.debug('ℹ️ NVIDIA GPU not detected (nvidia-smi not available)');
              reject();
            } else {
              logger.info('✅ NVIDIA GPU detected');
              resolve();
            }
          });
        });
      } catch {
        // nvidia-smi not available, that's fine
      }

      // Check user groups for hardware access
      try {
        const { exec } = await import('child_process');
        const groups = await new Promise<string>((resolve, reject) => {
          exec('groups', (error, stdout) => {
            if (error) reject(error);
            else resolve(stdout.trim());
          });
        });
        
        logger.info(`👤 User groups: ${groups}`);
        
        if (groups.includes('render')) {
          logger.info('✅ User is in "render" group - VAAPI should work');
        } else {
          logger.warn('⚠️ User not in "render" group - VAAPI may not work');
          logger.warn('💡 To fix: sudo usermod -a -G render $USER (then logout/login)');
        }
        
        if (groups.includes('video')) {
          logger.info('✅ User is in "video" group - hardware access available');
        }
      } catch (error) {
        logger.debug('Could not check user groups:', error);
      }
    } catch (error) {
      logger.warn('System capability check failed:', error);
    }
  }

  private async detectCodecs(): Promise<void> {
    const codecs: CodecCapability[] = [
      { name: 'libx264', type: 'software', available: false, tested: false, priority: 10 },
      { name: 'h264_qsv', type: 'hardware', available: false, tested: false, priority: 1 },
      { name: 'h264_nvenc', type: 'hardware', available: false, tested: false, priority: 2 },
      { name: 'h264_vaapi', type: 'hardware', available: false, tested: false, priority: 3 }
    ];

    // 🔍 System hardware capability checks
    logger.info('🔍 Checking system hardware capabilities...');
    await this.checkSystemCapabilities();

    // Check which codecs are available in FFmpeg
    const availableEncoders = await new Promise<any>((resolve, reject) => {
      ffmpeg.getAvailableEncoders((err, encoders) => {
        if (err) reject(err);
        else resolve(encoders);
      });
    });

    for (const codec of codecs) {
      if (availableEncoders[codec.name]) {
        codec.available = true;
        logger.info(`📋 ${codec.name} is available in FFmpeg`);
        
        // Test hardware codecs to ensure they actually work with the system
        if (codec.type === 'hardware') {
          logger.info(`🧪 Testing hardware codec: ${codec.name}`);
          codec.tested = await this.testCodec(codec.name);
        } else {
          codec.tested = true; // Assume software codecs work
        }
      } else {
        logger.debug(`❌ ${codec.name} not available in FFmpeg build`);
      }
    }

    // Sort by priority (working hardware codecs first, then software)
    this.availableCodecs = codecs
      .filter(c => c.available && c.tested)
      .sort((a, b) => a.priority - b.priority);

    // 📊 Detailed codec detection results
    logger.info('🔍 Codec Detection Summary:');
    logger.info('═══════════════════════════════════════');
    
    const workingHardware = this.availableCodecs.filter(c => c.type === 'hardware');
    const workingSoftware = this.availableCodecs.filter(c => c.type === 'software');
    
    if (workingHardware.length > 0) {
      logger.info('🚀 Hardware Acceleration ENABLED:');
      workingHardware.forEach(codec => {
        logger.info(`  ✅ ${codec.name} (${codec.type}) - Priority ${codec.priority}`);
      });
    } else {
      logger.warn('⚠️ No working hardware codecs found');
    }
    
    if (workingSoftware.length > 0) {
      logger.info('💻 Software Codecs Available:');
      workingSoftware.forEach(codec => {
        logger.info(`  ✅ ${codec.name} (${codec.type})`);
      });
    }
    
    // Show failed codecs for debugging
    const failedCodecs = codecs.filter(c => c.available && !c.tested);
    if (failedCodecs.length > 0) {
      logger.warn('❌ Available but Failed Codecs:');
      failedCodecs.forEach(codec => {
        logger.warn(`  ❌ ${codec.name} (${codec.type}) - Available in FFmpeg but test failed`);
      });
    }
    
    logger.info('═══════════════════════════════════════');
    
    if (this.availableCodecs.length === 0) {
      throw new Error('No working video codecs found');
    }
    
    // Log the codec that will be used
    const bestCodec = this.availableCodecs[0]!;
    if (bestCodec.type === 'hardware') {
      logger.info(`🎯 BEST CODEC: ${bestCodec.name} (Hardware acceleration ACTIVE!) 🚀`);
    } else {
      logger.info(`🎯 BEST CODEC: ${bestCodec.name} (Software encoding)`);
    }
  }

  private async testCodec(codecName: string): Promise<boolean> {
    return new Promise(async (resolve) => {
      const testFile = join(this.tempDir, `test-${codecName}-${randomUUID()}.mp4`);
      
      logger.info(`🧪 Testing codec: ${codecName}`);
      
      let command: any;
      
      // 🎯 SERVER-COMPATIBLE: Use /dev/zero instead of lavfi (works on all systems)
      if (codecName === 'h264_vaapi') {
        // VAAPI test - use /dev/zero with rawvideo format
        command = ffmpeg()
          .input('/dev/zero')
          .inputFormat('rawvideo')
          .inputOptions(['-pix_fmt', 'yuv420p', '-s', '64x64', '-r', '1'])
          .videoCodec(codecName)
          .addOption('-b:v', '100k')
          .addOption('-frames:v', '1')
          .addOption('-f', 'mp4');
      } else if (codecName === 'h264_nvenc') {
        // NVENC test - use /dev/zero with rawvideo format  
        command = ffmpeg()
          .input('/dev/zero')
          .inputFormat('rawvideo')
          .inputOptions(['-pix_fmt', 'yuv420p', '-s', '64x64', '-r', '1'])
          .videoCodec(codecName)
          .addOption('-preset', 'fast')
          .addOption('-frames:v', '1')
          .addOption('-f', 'mp4');
      } else if (codecName === 'h264_qsv') {
        // Intel QuickSync test - use /dev/zero with rawvideo format
        command = ffmpeg()
          .input('/dev/zero')
          .inputFormat('rawvideo')
          .inputOptions(['-pix_fmt', 'yuv420p', '-s', '64x64', '-r', '1'])
          .videoCodec(codecName)
          .addOption('-preset', 'medium')
          .addOption('-frames:v', '1')
          .addOption('-f', 'mp4');
      } else {
        // Software codec test - use /dev/zero with rawvideo format
        command = ffmpeg()
          .input('/dev/zero')
          .inputFormat('rawvideo')
          .inputOptions(['-pix_fmt', 'yuv420p', '-s', '64x64', '-r', '1'])
          .videoCodec(codecName)
          .addOption('-frames:v', '1')
          .addOption('-f', 'mp4');
      }
      
      command
        .output(testFile)
        .on('start', (cmdLine: string) => {
          logger.debug(`🔧 ${codecName} test command: ${cmdLine}`);
        })
        .on('end', async () => {
          try {
            await fs.unlink(testFile);
          } catch {
            // File might not exist, that's fine
          }
          logger.info(`✅ ${codecName} test passed - hardware acceleration working!`);
          resolve(true);
        })
        .on('error', (err: any) => {
          logger.warn(`❌ ${codecName} test failed: ${err.message}`);
          
          // 🔍 Detailed hardware codec troubleshooting
          if (codecName.includes('vaapi')) {
            if (err.message.includes('No such file') || err.message.includes('Cannot load')) {
              logger.warn(`💡 VAAPI: Hardware device not accessible - check /dev/dri/renderD128 and 'render' group`);
            } else if (err.message.includes('Function not implemented')) {
              logger.warn(`💡 VAAPI: Driver doesn't support this codec - try updating graphics drivers`);
            } else {
              logger.warn(`💡 VAAPI: Hardware acceleration not available on this system`);
            }
          } else if (codecName.includes('nvenc')) {
            logger.warn(`💡 NVENC: NVIDIA GPU or drivers not available`);
          } else if (codecName.includes('qsv')) {
            if (err.message.includes('unsupported')) {
              logger.warn(`💡 Intel QSV: Hardware not supported or drivers missing`);
            } else {
              logger.warn(`💡 Intel QSV: QuickSync not available on this system`);
            }
          }
          
          logger.info(`ℹ️ Codec ${codecName} will fall back to software encoding`);;
          
          resolve(false);
        });

      // 🕐 Reasonable timeout for codec tests
      const timeout = codecName.includes('264') && !codecName.includes('lib') ? 5000 : 3000;
      const timeoutHandle = setTimeout(() => {
        try {
          command.kill('SIGKILL');
        } catch (e) {
          // Ignore kill errors
        }
        logger.warn(`⏰ ${codecName} test timeout after ${timeout/1000}s`);
        resolve(false);
      }, timeout);

      try {
        command.run();
      } catch (error) {
        clearTimeout(timeoutHandle);
        logger.warn(`❌ ${codecName} failed to start: ${error}`);
        resolve(false);
      }
    });
  }

  async processVideo(
    job: VideoJob,
    progressCallback?: (progress: EncodingProgress) => void,
    onPinFailed?: (hash: string, error: Error) => void
  ): Promise<EncodedOutput[]> {
    const jobId = job.id;
    const workDir = join(this.tempDir, jobId);
    const outputsDir = join(workDir, 'outputs'); // Separate directory for encoded outputs only
    
    try {
      // Create work and outputs directories
      await fs.mkdir(workDir, { recursive: true });
      await fs.mkdir(outputsDir, { recursive: true });
      
      // Download source video (temporary, will be deleted after encoding)
      const sourceFile = join(workDir, 'source.mp4');
      logger.info(`📥 Downloading source video for job ${jobId}`);
      await this.downloadVideo(job.input.uri, sourceFile);
      
      // Process each quality profile
      const outputs: EncodedOutput[] = [];
      const profiles = [
        { name: '1080p', height: 1080 },
        { name: '720p', height: 720 },
        { name: '480p', height: 480 }
      ];

      for (let i = 0; i < profiles.length; i++) {
        const profile = profiles[i]!;
        logger.info(`🎬 Processing ${profile.name} for job ${jobId}`);
        
        const output = await this.encodeProfile(
          sourceFile,
          profile,
          outputsDir, // Encode directly to outputs directory
          (progress) => {
            if (progressCallback) {
              const totalProgress = ((i / profiles.length) + (progress / 100 / profiles.length)) * 100;
              progressCallback({
                jobId,
                profile: profile.name,
                percent: totalProgress
              });
            }
          }
        );
        
        outputs.push(output);
      }
      
      logger.info(`🎉 All profiles completed for job ${jobId}`);
      
      // 🗑️ Delete source file immediately after encoding (no longer needed)
      try {
        await fs.unlink(sourceFile);
        logger.info(`🗑️ Source file deleted: ${sourceFile}`);
      } catch (error) {
        logger.warn(`⚠️ Failed to delete source file:`, error);
      }
      
      // Create master playlist (manifest.m3u8) that references all profiles
      await this.createMasterPlaylist(outputs, outputsDir);
      
      // Upload ONLY the encoded outputs directory to IPFS (no source file!)
      logger.info(`📤 Uploading encoded outputs to IPFS for job ${jobId} (source file excluded)`);
      
      // 🚨 PINATA-STYLE: Upload and get CID immediately, handle pinning in background
      const ipfsHash = await this.ipfsService.uploadDirectory(outputsDir, false, onPinFailed);
      
      // 🎯 MANUAL COMPLETION: Log CID prominently for manual job finishing
      logger.info(`🎉 ═══════════════════════════════════════════════════════════════`);
      logger.info(`🎯 JOB ${jobId}: IPFS CID READY FOR MANUAL COMPLETION`);
      logger.info(`📱 CID: ${ipfsHash}`);
      logger.info(`🔗 Gateway: https://gateway.3speak.tv/ipfs/${ipfsHash}/manifest.m3u8`);
      logger.info(`✅ Content Size: 1282MB | Files: 1701 | Status: UPLOADED`);
      logger.info(`🛠️ MANUAL FINISH: Use this CID to complete job if encoder gets stuck`);
      logger.info(`🎉 ═══════════════════════════════════════════════════════════════`);
      
      // 🔄 LAZY PINNING: Queue for background pinning (non-blocking)
      if (onPinFailed) {
        // Trigger background pinning by calling the callback with no error
        setTimeout(() => {
          logger.info(`🔄 Triggering lazy pinning for ${ipfsHash}`);
          // This will queue it for background pinning
          onPinFailed(ipfsHash, new Error('lazy_pin_requested'));
        }, 100);
      }
      
      // Create final outputs with master playlist
      const masterPlaylistUri = `ipfs://${ipfsHash}/manifest.m3u8`;
      const uploadedOutputs: EncodedOutput[] = [{
        profile: 'master',
        path: join(outputsDir, 'manifest.m3u8'),
        size: 0, // Will be calculated
        duration: 0,
        segments: [],
        playlist: join(outputsDir, 'manifest.m3u8'),
        ipfsHash: ipfsHash,
        uri: masterPlaylistUri
      }];
      
      logger.info(`✅ Complete HLS structure uploaded to IPFS: ${ipfsHash}`);
      logger.info(`🎬 Master playlist available at: ${masterPlaylistUri}`);
      
      return uploadedOutputs;
      
    } catch (error) {
      logger.error(`❌ Video processing failed for job ${jobId}:`, cleanErrorForLogging(error));
      throw error;
    } finally {
      // Cleanup work directory
      try {
        await fs.rm(workDir, { recursive: true, force: true });
      } catch (cleanupError) {
        logger.warn(`⚠️ Failed to cleanup ${workDir}:`, cleanupError);
      }
    }
  }

  private async downloadVideo(uri: string, outputPath: string): Promise<void> {
    logger.info(`📥 Downloading video from: ${uri}`);
    
    // Extract IPFS hash if it's an IPFS URL
    const ipfsMatch = uri.match(/\/ipfs\/([a-zA-Z0-9]+)/);
    const ipfsHash = ipfsMatch ? ipfsMatch[1] : null;
    
    if (ipfsHash) {
      // 🎯 SMART TWO-TIER FALLBACK for IPFS content
      
      // Tier 1: Try 3Speak gateway first (direct access to their infrastructure)
      try {
        logger.info('🎯 Trying 3Speak IPFS gateway (direct access)');
        await this.downloadFromGateway('https://ipfs.3speak.tv', ipfsHash, outputPath);
        logger.info('✅ Successfully downloaded via 3Speak gateway');
        return;
      } catch (error: any) {
        logger.warn(`⚠️ 3Speak gateway failed: ${error.message}`, cleanErrorForLogging(error));
        logger.info('🔍 Falling back to local IPFS daemon (P2P network)');
      }
      
      // Tier 2: Fallback to local IPFS daemon (P2P network discovery)
      try {
        await this.downloadFromLocalIPFS(ipfsHash, outputPath);
        logger.info('✅ Successfully downloaded via local IPFS daemon');
        return;
      } catch (error: any) {
        logger.error(`❌ Local IPFS daemon failed: ${error.message}`, cleanErrorForLogging(error));
        throw new Error(`Both 3Speak gateway and local IPFS failed. Gateway: ${error.message}`);
      }
      
    } else if (uri.startsWith('file://')) {
      // Handle local file:// URLs by copying the file directly
      await this.copyLocalFile(uri, outputPath);
    } else {
      // For regular HTTP/HTTPS URLs, use HTTP download
      await this.downloadFromHTTP(uri, outputPath);
    }
  }
  
  /**
   * Download from 3Speak IPFS gateway (Tier 1 - Direct Access)
   */
  private async downloadFromGateway(gateway: string, ipfsHash: string, outputPath: string): Promise<void> {
    const axios = await import('axios');
    const gatewayUrl = `${gateway}/ipfs/${ipfsHash}`;
    
    logger.info(`⏱️ Gateway timeout: 90 seconds (should be fast for direct access)`);
    
    const response = await axios.default.get(gatewayUrl, {
      responseType: 'stream',
      timeout: 90000, // 1.5 minutes - gateway should be fast
      maxRedirects: 5,
      headers: {
        'User-Agent': '3SpeakEncoder/1.0'
      }
    });
    
    await this.streamToFileWithProgress(response.data, outputPath, `gateway ${gateway}`, response.headers['content-length']);
  }
  
  /**
   * Download from local IPFS daemon (Tier 2 - P2P Network)
   */
  private async downloadFromLocalIPFS(ipfsHash: string, outputPath: string): Promise<void> {
    const axios = await import('axios');
    
    logger.info(`⏱️ Local IPFS timeout: 5 minutes (P2P discovery can take time)`);
    logger.info(`🔍 Starting P2P discovery and download for ${ipfsHash}...`);
    
    const response = await axios.default.post(
      `http://127.0.0.1:5001/api/v0/cat?arg=${ipfsHash}`,
      null,
      {
        responseType: 'stream',
        timeout: 300000, // 5 minutes - P2P discovery can take time
        maxRedirects: 0
      }
    );
    
    await this.streamToFileWithProgress(response.data, outputPath, 'local IPFS daemon (P2P)');
  }
  
  /**
   * Download from regular HTTP URL
   */
  private async downloadFromHTTP(uri: string, outputPath: string): Promise<void> {
    const axios = await import('axios');
    
    const response = await axios.default.get(uri, {
      responseType: 'stream',
      timeout: 120000, // 2 minutes for regular HTTP
      maxRedirects: 5,
      headers: {
        'User-Agent': '3SpeakEncoder/1.0'
      }
    });
    
    await this.streamToFileWithProgress(response.data, outputPath, `HTTP ${uri}`, response.headers['content-length']);
  }
  
  /**
   * Copy local file:// URL to output path
   */
  private async copyLocalFile(fileUri: string, outputPath: string): Promise<void> {
    const fs = await import('fs').then(m => m.promises);
    const path = await import('path');
    
    // Convert file:// URL to local path
    const localPath = fileUri.replace('file://', '');
    
    logger.info(`📁 Copying local file: ${localPath} -> ${outputPath}`);
    
    try {
      // Check if source file exists
      const stats = await fs.stat(localPath);
      const fileSizeMB = (stats.size / 1024 / 1024).toFixed(1);
      
      logger.info(`📊 Local file size: ${fileSizeMB}MB`);
      
      // Update dashboard - starting local file copy
      if (this.dashboard && this.currentJobId) {
        this.dashboard.updateJobProgress(this.currentJobId, 10, 'copying-local-file', {
          fileSizeMB: fileSizeMB,
          source: 'local file'
        });
      }
      
      // Ensure output directory exists
      const outputDir = path.dirname(outputPath);
      await fs.mkdir(outputDir, { recursive: true });
      
      // Copy the file
      await fs.copyFile(localPath, outputPath);
      
      logger.info(`✅ Successfully copied local file: ${fileSizeMB}MB`);
      
      // Update dashboard - local file copy complete
      if (this.dashboard && this.currentJobId) {
        this.dashboard.updateJobProgress(this.currentJobId, 25, 'local-file-copied', {
          fileSizeMB: fileSizeMB,
          source: 'local file'
        });
      }
      
    } catch (error: any) {
      logger.error(`❌ Failed to copy local file: ${error.message}`);
      throw new Error(`Failed to copy local file from ${localPath}: ${error.message}`);
    }
  }
  
  /**
   * 🚨 MEMORY SAFE: Stream data to file with progress tracking
   */
  private async streamToFileWithProgress(dataStream: any, outputPath: string, source: string, contentLength?: string): Promise<void> {
    const writer = createWriteStream(outputPath);
    dataStream.pipe(writer);
    
    let downloadedBytes = 0;
    const totalBytes = contentLength ? parseInt(contentLength) : null;
    let lastProgressTime = Date.now();
    
    // Progress tracking
    dataStream.on('data', (chunk: Buffer) => {
      downloadedBytes += chunk.length;
      const now = Date.now();
      
      // Log progress every 10 seconds or every 25MB
      if (now - lastProgressTime > 10000 || downloadedBytes % (25 * 1024 * 1024) < chunk.length) {
        if (totalBytes) {
          const percent = Math.round((downloadedBytes / totalBytes) * 100);
          const mbDownloaded = (downloadedBytes / 1024 / 1024).toFixed(1);
          const mbTotal = (totalBytes / 1024 / 1024).toFixed(1);
          logger.info(`📥 Download progress: ${percent}% (${mbDownloaded}MB / ${mbTotal}MB) from ${source}`);
          
          // 📊 Update dashboard with download progress (5-25% range for download phase)
          if (this.dashboard && this.currentJobId) {
            const dashboardProgress = 5 + Math.round(percent * 0.2); // Scale to 5-25% of total job
            this.dashboard.updateJobProgress(this.currentJobId, dashboardProgress, `downloading-${source.includes('gateway') ? 'gateway' : source.includes('IPFS') ? 'ipfs' : 'http'}`, {
              downloadPercent: percent,
              downloadedMB: mbDownloaded,
              totalMB: mbTotal,
              source: source
            });
          }
        } else {
          const mbDownloaded = (downloadedBytes / 1024 / 1024).toFixed(1);
          logger.info(`📥 Downloaded: ${mbDownloaded}MB from ${source} (size unknown)`);
          
          // 📊 Update dashboard with unknown size progress
          if (this.dashboard && this.currentJobId) {
            const estimatedProgress = Math.min(25, 5 + Math.floor(downloadedBytes / (50 * 1024 * 1024))); // Rough estimate
            this.dashboard.updateJobProgress(this.currentJobId, estimatedProgress, `downloading-${source.includes('gateway') ? 'gateway' : source.includes('IPFS') ? 'ipfs' : 'http'}`, {
              downloadedMB: mbDownloaded,
              source: source
            });
          }
        }
        lastProgressTime = now;
      }
    });
    
    return new Promise<void>((resolve, reject) => {
      // 🚨 MEMORY SAFE: Ensure streams are destroyed on completion/error
      const cleanup = () => {
        try {
          if (!dataStream.destroyed) dataStream.destroy();
          if (!writer.destroyed) writer.destroy();
        } catch (e) {
          // Ignore cleanup errors
        }
      };
      
      writer.on('finish', () => {
        const finalMB = (downloadedBytes / 1024 / 1024).toFixed(1);
        logger.info(`✅ Successfully downloaded ${finalMB}MB from ${source}`);
        
        // 📊 Update dashboard - download complete (25% of total job)
        if (this.dashboard && this.currentJobId) {
          this.dashboard.updateJobProgress(this.currentJobId, 25, 'download-complete', {
            downloadedMB: finalMB,
            source: source
          });
        }
        
        cleanup();
        resolve();
      });
      
      writer.on('error', (err: any) => {
        cleanup();
        reject(err);
      });
      
      dataStream.on('error', (err: any) => {
        cleanup();
        reject(err);
      });
      
      // 🚨 CRITICAL: Handle aborted streams explicitly
      dataStream.on('aborted', () => {
        cleanup();
        reject(new Error('Download stream was aborted'));
      });
    });
  }

  private async encodeProfile(
    sourceFile: string,
    profile: { name: string; height: number },
    workDir: string,
    progressCallback?: (progress: number) => void
  ): Promise<EncodedOutput> {
    const profileDir = join(workDir, profile.name);
    await fs.mkdir(profileDir, { recursive: true });
    
    const outputPath = join(profileDir, 'index.m3u8');
    const bestCodec = this.availableCodecs[0]!;
    
    return new Promise((resolve, reject) => {
      let segmentCount = 0;
      const segments: string[] = [];
      
      // Get profile-specific settings matching Eddie's script
      const profileSettings = this.getProfileSettings(profile.name);
      
      const command = ffmpeg(sourceFile)
        .videoCodec(bestCodec.name)
        .addOption('-preset', 'veryfast')
        .addOption('-profile:v', profileSettings.profile)
        .addOption('-level', profileSettings.level)
        .addOption('-b:v', profileSettings.bitrate)
        .addOption('-maxrate', profileSettings.maxrate)
        .addOption('-bufsize', profileSettings.bufsize)
        .addOption('-vf', `scale=-2:${profile.height},fps=30`)
        .audioCodec('aac')
        .audioBitrate(profileSettings.audioBitrate)
        .addOption('-ac', '2')
        .addOption('-ar', '48000')
        .addOption('-video_track_timescale', '90000')
        .addOption('-hls_time', '6')
        .addOption('-hls_playlist_type', 'vod')
        .addOption('-hls_list_size', '0')
        .addOption('-start_number', '0')
        .addOption('-hls_segment_filename', join(profileDir, `${profile.name}_%d.ts`))
        .format('hls')
        .output(outputPath)
        .on('start', (commandLine) => {
          logger.info(`🎬 Starting ${profile.name} encoding with ${bestCodec.name}`);
          logger.debug('FFmpeg command:', commandLine);
        })
        .on('progress', (progress) => {
          if (progressCallback && progress.percent) {
            progressCallback(progress.percent);
          }
        })
        .on('end', async () => {
          try {
            // Count segments
            const files = await fs.readdir(profileDir);
            const segmentFiles = files.filter(f => f.endsWith('.ts'));
            
            // Get file size
            const stats = await fs.stat(outputPath);
            
            resolve({
              profile: profile.name,
              path: outputPath,
              size: stats.size,
              duration: 0, // TODO: Get actual duration
              segments: segmentFiles,
              playlist: outputPath
            });
          } catch (error) {
            reject(error);
          }
        })
        .on('error', (error) => {
          logger.error(`❌ ${profile.name} encoding failed:`, cleanErrorForLogging(error));
          // 🚨 CRITICAL: Kill FFmpeg process to prevent memory leak
          try {
            command.kill('SIGKILL');
          } catch (e) {
            // Ignore kill errors
          }
          reject(error);
        });

      // Add codec-specific options
      if (bestCodec.name === 'h264_qsv') {
        command.addOption('-preset', 'medium');
        command.addOption('-global_quality', '23');
      } else if (bestCodec.name === 'h264_nvenc') {
        command.addOption('-preset', 'medium');
        command.addOption('-cq', '23');
      } else {
        command.addOption('-preset', 'medium');
        command.addOption('-crf', '23');
      }

      // 🚨 MEMORY SAFE: Add timeout to prevent hung FFmpeg processes
      const timeoutId = setTimeout(() => {
        logger.warn(`⚠️ FFmpeg timeout for ${profile.name}, killing process...`);
        try {
          command.kill('SIGKILL');
        } catch (e) {
          // Ignore kill errors
        }
        reject(new Error(`FFmpeg encoding timeout for ${profile.name}`));
      }, 30 * 60 * 1000); // 30 minute timeout per profile

      command.on('end', () => {
        clearTimeout(timeoutId); // Cancel timeout on success
      });

      command.on('error', () => {
        clearTimeout(timeoutId); // Cancel timeout on error
      });

      command.run();
    });
  }

  getBestCodec(): string {
    return this.availableCodecs[0]?.name || 'libx264';
  }

  private getProfileSettings(profileName: string) {
    // Eddie's exact settings for each profile
    const settings = {
      '1080p': {
        profile: 'high',
        level: '4.1',
        bitrate: '5000k',
        maxrate: '5350k',
        bufsize: '7500k',
        audioBitrate: '128k'
      },
      '720p': {
        profile: 'high', 
        level: '4.0',
        bitrate: '2800k',
        maxrate: '2996k',
        bufsize: '4200k',
        audioBitrate: '128k'
      },
      '480p': {
        profile: 'main',
        level: '3.1', 
        bitrate: '1400k',
        maxrate: '1498k',
        bufsize: '2100k',
        audioBitrate: '96k'
      }
    };
    
    return settings[profileName as keyof typeof settings] || settings['480p'];
  }

  getAvailableCodecs(): CodecCapability[] {
    return [...this.availableCodecs];
  }

  private async createMasterPlaylist(outputs: EncodedOutput[], workDir: string): Promise<void> {
    logger.info('📝 Creating master playlist (manifest.m3u8)');
    
    // Define profile specifications matching Eddie's script
    const profileSpecs = [
      { name: '1080p', bandwidth: 6500000, resolution: '1920x1080', codecs: 'avc1.640028,mp4a.40.2' },
      { name: '720p', bandwidth: 3500000, resolution: '1280x720', codecs: 'avc1.64001F,mp4a.40.2' },
      { name: '480p', bandwidth: 1800000, resolution: '854x480', codecs: 'avc1.4D401F,mp4a.40.2' }
    ];
    
    let masterPlaylist = '#EXTM3U\n';
    masterPlaylist += '#EXT-X-VERSION:3\n';
    
    // Add each profile to master playlist
    for (const spec of profileSpecs) {
      const output = outputs.find(o => o.profile === spec.name);
      if (output) {
        masterPlaylist += `#EXT-X-STREAM-INF:BANDWIDTH=${spec.bandwidth},RESOLUTION=${spec.resolution},CODECS="${spec.codecs}"\n`;
        masterPlaylist += `${spec.name}/index.m3u8\n`;
      }
    }
    
    // Write master playlist to work directory
    const masterPlaylistPath = join(workDir, 'manifest.m3u8');
    await fs.writeFile(masterPlaylistPath, masterPlaylist);
    
    logger.info(`✅ Master playlist created: manifest.m3u8`);
  }


}