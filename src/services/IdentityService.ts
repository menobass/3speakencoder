import { EncoderConfig } from '../config/ConfigLoader.js';
import { Ed25519Provider } from 'key-did-provider-ed25519';
import KeyResolver from 'key-did-resolver';
import { DID, DagJWS } from 'dids';
import * as crypto from 'crypto';
import { logger } from './Logger.js';

export interface JWSPayload {
  [key: string]: any;
}

export class IdentityService {
  private config: EncoderConfig;
  private identity: DID | null = null;

  constructor(config: EncoderConfig) {
    this.config = config;
  }

  async initialize(): Promise<void> {
    try {
      let privateKey: Buffer | null = null;
      
      if (this.config.node.privateKey) {
        // Use provided private key (base64 encoded)
        privateKey = Buffer.from(this.config.node.privateKey, 'base64');
      } else {
        // Generate new private key if none provided
        logger.warn('⚠️ No encoder private key configured - generating new one');
        privateKey = crypto.randomBytes(32);
        const base64Key = privateKey.toString('base64');
        logger.info('🔑 Generated encoder authentication key (save this to your .env):');
        logger.info('   Add to .env: ENCODER_PRIVATE_KEY=' + base64Key);
        logger.info('   📝 Note: This is NOT your Hive key - it\'s for encoder-gateway authentication');
      }

      // Create Ed25519 provider and DID (matching old encoder exactly)
      const provider = new Ed25519Provider(privateKey);
      const did = new DID({ 
        provider: provider, 
        resolver: KeyResolver.getResolver() 
      });
      
      await did.authenticate();
      this.identity = did;
      
      logger.info(`🔐 Identity initialized: ${did.id}`);
    } catch (error) {
      logger.error('❌ Failed to initialize identity:', error);
      throw error;
    }
  }

  async createJWS(payload: JWSPayload): Promise<DagJWS> {
    try {
      if (!this.identity) {
        throw new Error('Identity not initialized - cannot create JWS without private key');
      }
      
      // Use the DID library's createJWS method (exactly like old encoder)
      return await this.identity.createJWS(payload);
    } catch (error) {
      logger.error('❌ Failed to create JWS:', error);
      throw error;
    }
  }

  getDIDKey(): string {
    return this.identity?.id || 'no-identity';
  }

  getIdentity(): DID | null {
    return this.identity;
  }
}