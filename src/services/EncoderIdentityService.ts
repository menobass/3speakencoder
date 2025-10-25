import * as fs from 'fs';
import * as path from 'path';
import { logger } from './Logger';
import { EncoderConfig } from '../config/ConfigLoader';

export interface EncoderIdentity {
  encoderId: string;
  displayName: string;
  createdAt: string;
  totalJobsCompleted: number;
  lastActive: string;
}

export class EncoderIdentityService {
  private config: EncoderConfig;
  private identityFile: string;
  private identity: EncoderIdentity | null = null;

  constructor(config: EncoderConfig) {
    this.config = config;
    this.identityFile = path.join(process.cwd(), 'data', 'encoder-identity.json');
  }

  async initialize(): Promise<void> {
    try {
      // Ensure data directory exists
      const dataDir = path.dirname(this.identityFile);
      if (!fs.existsSync(dataDir)) {
        fs.mkdirSync(dataDir, { recursive: true });
      }

      // Load existing identity or create new one
      if (fs.existsSync(this.identityFile)) {
        await this.loadExistingIdentity();
      } else {
        await this.createNewIdentity();
      }

      // Update last active timestamp
      this.updateLastActive();
      logger.info(`🆔 Encoder Identity: ${this.identity?.encoderId} (${this.identity?.displayName})`);
    } catch (error) {
      logger.error('❌ Failed to initialize encoder identity:', error);
      throw error;
    }
  }

  private async loadExistingIdentity(): Promise<void> {
    try {
      const data = fs.readFileSync(this.identityFile, 'utf8');
      this.identity = JSON.parse(data);
      logger.info('📋 Loaded existing encoder identity');
    } catch (error) {
      logger.warn('⚠️ Failed to load encoder identity, creating new one');
      await this.createNewIdentity();
    }
  }

  private async createNewIdentity(): Promise<void> {
    const timestamp = new Date().toISOString();
    
    // Generate a human-readable encoder ID
    const randomSuffix = Math.random().toString(36).substring(2, 8).toUpperCase();
    const encoderId = `ENC-${randomSuffix}`;
    
    this.identity = {
      encoderId,
      displayName: this.config.node?.name || `Encoder-${randomSuffix}`,
      createdAt: timestamp,
      totalJobsCompleted: 0,
      lastActive: timestamp
    };

    await this.saveIdentity();
    logger.info(`🆕 Created new encoder identity: ${encoderId}`);
  }

  private async saveIdentity(): Promise<void> {
    if (!this.identity) return;
    
    try {
      fs.writeFileSync(this.identityFile, JSON.stringify(this.identity, null, 2));
    } catch (error) {
      logger.error('❌ Failed to save encoder identity:', error);
    }
  }

  updateLastActive(): void {
    if (this.identity) {
      this.identity.lastActive = new Date().toISOString();
      this.saveIdentity();
    }
  }

  incrementJobCount(): void {
    if (this.identity) {
      this.identity.totalJobsCompleted++;
      this.updateLastActive();
    }
  }

  getIdentity(): EncoderIdentity | null {
    return this.identity;
  }

  getEncoderId(): string {
    return this.identity?.encoderId || 'UNKNOWN';
  }

  getDisplayName(): string {
    return this.identity?.displayName || 'Unknown Encoder';
  }
}