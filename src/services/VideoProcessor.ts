import ffmpeg from 'fluent-ffmpeg';
import { EncoderConfig } from '../config/ConfigLoader';
import { VideoJob, EncodedOutput, CodecCapability, EncodingProgress } from '../types';
import { logger } from './Logger';
import { promises as fs } from 'fs';
import { createWriteStream } from 'fs';
import { join, dirname } from 'path';
import { tmpdir } from 'os';
import { randomUUID } from 'crypto';
import { IPFSService } from './IPFSService';
import { cleanErrorForLogging } from '../common/errorUtils.js';

export class VideoProcessor {
  private config: EncoderConfig;
  private availableCodecs: CodecCapability[] = [];
  private tempDir: string;
  private ipfsService: IPFSService;

  constructor(config: EncoderConfig, ipfsService: IPFSService) {
    this.config = config;
    this.ipfsService = ipfsService;
    this.tempDir = config.encoder?.temp_dir || join(tmpdir(), '3speak-encoder');
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

  private async detectCodecs(): Promise<void> {
    const codecs: CodecCapability[] = [
      { name: 'libx264', type: 'software', available: false, tested: false, priority: 10 },
      { name: 'h264_qsv', type: 'hardware', available: false, tested: false, priority: 1 },
      { name: 'h264_nvenc', type: 'hardware', available: false, tested: false, priority: 2 },
      { name: 'h264_vaapi', type: 'hardware', available: false, tested: false, priority: 3 }
    ];

    // Check which codecs are available
    const availableEncoders = await new Promise<any>((resolve, reject) => {
      ffmpeg.getAvailableEncoders((err, encoders) => {
        if (err) reject(err);
        else resolve(encoders);
      });
    });

    for (const codec of codecs) {
      if (availableEncoders[codec.name]) {
        codec.available = true;
        
        // Test hardware codecs to ensure they actually work
        if (codec.type === 'hardware') {
          codec.tested = await this.testCodec(codec.name);
        } else {
          codec.tested = true; // Assume software codecs work
        }
      }
    }

    // Sort by priority (working hardware codecs first, then software)
    this.availableCodecs = codecs
      .filter(c => c.available && c.tested)
      .sort((a, b) => a.priority - b.priority);

    logger.info('🔍 Codec detection results:');
    this.availableCodecs.forEach(codec => {
      logger.info(`  ✅ ${codec.name} (${codec.type})`);
    });

    if (this.availableCodecs.length === 0) {
      throw new Error('No working video codecs found');
    }
  }

  private async testCodec(codecName: string): Promise<boolean> {
    return new Promise((resolve) => {
      const testFile = join(this.tempDir, `test-${codecName}-${randomUUID()}.mp4`);
      
      logger.info(`🧪 Testing codec: ${codecName}`);
      
      const command = ffmpeg()
        .input('testsrc=duration=0.1:size=320x240:rate=1')
        .inputFormat('lavfi')
        .videoCodec(codecName)
        .duration(0.1)
        .output(testFile)
        .on('end', async () => {
          try {
            await fs.unlink(testFile);
            logger.info(`✅ ${codecName} test passed`);
            resolve(true);
          } catch {
            resolve(true); // File might not exist, but codec worked
          }
        })
        .on('error', (err) => {
          logger.warn(`❌ ${codecName} test failed: ${err.message}`);
          resolve(false);
        });

      // Set timeout for codec test
      setTimeout(() => {
        command.kill('SIGKILL');
        logger.warn(`⏰ ${codecName} test timeout`);
        resolve(false);
      }, 10000);

      command.run();
    });
  }

  async processVideo(
    job: VideoJob,
    progressCallback?: (progress: EncodingProgress) => void,
    onPinFailed?: (hash: string, error: Error) => void
  ): Promise<EncodedOutput[]> {
    const jobId = job.id;
    const workDir = join(this.tempDir, jobId);
    
    try {
      // Create work directory
      await fs.mkdir(workDir, { recursive: true });
      
      // Download source video
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
          workDir,
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
      
      // Create master playlist (manifest.m3u8) that references all profiles
      await this.createMasterPlaylist(outputs, workDir);
      
      // Upload the entire HLS structure to IPFS as a single directory
      logger.info(`📤 Uploading complete HLS structure to IPFS for job ${jobId}`);
      const ipfsHash = await this.ipfsService.uploadDirectory(workDir, true, onPinFailed);
      
      // Create final outputs with master playlist
      const masterPlaylistUri = `ipfs://${ipfsHash}/manifest.m3u8`;
      const uploadedOutputs: EncodedOutput[] = [{
        profile: 'master',
        path: join(workDir, 'manifest.m3u8'),
        size: 0, // Will be calculated
        duration: 0,
        segments: [],
        playlist: join(workDir, 'manifest.m3u8'),
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
      
    } else {
      // For non-IPFS URLs, use direct HTTP download
      await this.downloadFromHTTP(uri, outputPath);
    }
  }
  
  /**
   * Download from 3Speak IPFS gateway (Tier 1 - Direct Access)
   */
  private async downloadFromGateway(gateway: string, ipfsHash: string, outputPath: string): Promise<void> {
    const axios = await import('axios');
    const gatewayUrl = `${gateway}/ipfs/${ipfsHash}`;
    
    const response = await axios.default.get(gatewayUrl, {
      responseType: 'stream',
      timeout: 90000, // 1.5 minutes - gateway should be fast
      maxRedirects: 5,
      headers: {
        'User-Agent': '3SpeakEncoder/1.0'
      }
    });
    
    await this.streamToFile(response.data, outputPath, `gateway ${gateway}`);
  }
  
  /**
   * Download from local IPFS daemon (Tier 2 - P2P Network)
   */
  private async downloadFromLocalIPFS(ipfsHash: string, outputPath: string): Promise<void> {
    const axios = await import('axios');
    
    const response = await axios.default.post(
      `http://127.0.0.1:5001/api/v0/cat?arg=${ipfsHash}`,
      null,
      {
        responseType: 'stream',
        timeout: 300000, // 5 minutes - P2P discovery can take time
        maxRedirects: 0
      }
    );
    
    await this.streamToFile(response.data, outputPath, 'local IPFS daemon');
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
    
    await this.streamToFile(response.data, outputPath, `HTTP ${uri}`);
  }
  
  /**
   * 🚨 MEMORY SAFE: Stream data to file with proper cleanup
   */
  private async streamToFile(dataStream: any, outputPath: string, source: string): Promise<void> {
    const writer = createWriteStream(outputPath);
    dataStream.pipe(writer);
    
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
        logger.info(`✅ Successfully downloaded from ${source}`);
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