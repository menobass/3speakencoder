import { LocalPinDatabase, LocalPin } from './LocalPinDatabase';
import { logger } from './Logger';
import { EncoderConfig } from '../config/ConfigLoader';

export class PinSyncService {
  private database: LocalPinDatabase;
  private config: EncoderConfig;
  private isRunning: boolean = false;
  private syncInterval: NodeJS.Timeout | null = null;
  private readonly SYNC_INTERVAL_MS = 30 * 1000; // 30 seconds
  private readonly MAX_CONCURRENT_SYNCS = 3;

  constructor(config: EncoderConfig, database: LocalPinDatabase) {
    this.config = config;
    this.database = database;
  }

  async start(): Promise<void> {
    if (this.isRunning) {
      logger.warn('⚠️ Pin sync service is already running');
      return;
    }

    this.isRunning = true;
    logger.info('🔄 Starting pin sync service...');

    // Initial sync
    await this.performSync();

    // Schedule regular syncs
    this.syncInterval = setInterval(() => {
      this.performSync().catch(error => {
        logger.error('❌ Sync service error:', error);
      });
    }, this.SYNC_INTERVAL_MS);

    logger.info(`✅ Pin sync service started (interval: ${this.SYNC_INTERVAL_MS/1000}s)`);
  }

  async stop(): Promise<void> {
    if (!this.isRunning) return;

    this.isRunning = false;
    
    if (this.syncInterval) {
      clearInterval(this.syncInterval);
      this.syncInterval = null;
    }

    logger.info('⏹️ Pin sync service stopped');
  }

  private async performSync(): Promise<void> {
    try {
      // Get pending pins
      const pendingPins = await this.database.getPendingPins(this.MAX_CONCURRENT_SYNCS);
      
      if (pendingPins.length === 0) {
        // No work to do, but log stats occasionally
        const stats = await this.database.getStats();
        if (stats.total > 0) {
          logger.debug(`📊 Pin sync stats: ${stats.synced}/${stats.total} synced, ${stats.pending} pending`);
        }
        return;
      }

      logger.info(`🔄 Syncing ${pendingPins.length} pending pins to supernode`);

      // Process pins concurrently
      const syncPromises = pendingPins.map(pin => this.syncSinglePin(pin));
      await Promise.allSettled(syncPromises);

      // Cleanup old synced pins
      await this.database.cleanupSynced(7); // Keep for 7 days

    } catch (error) {
      logger.error('❌ Failed to perform sync cycle:', error);
    }
  }

  private async syncSinglePin(pin: LocalPin): Promise<void> {
    try {
      logger.info(`📌 Syncing pin to supernode: ${pin.hash}`);
      
      // Mark as syncing
      await this.database.updateSyncStatus(pin.hash, 'syncing');

      // Check if already pinned on supernode
      const alreadyPinned = await this.checkSupernodePin(pin.hash);
      if (alreadyPinned) {
        logger.info(`✅ Pin ${pin.hash} already exists on supernode`);
        await this.database.markSynced(pin.hash);
        return;
      }

      // Pin to supernode
      await this.pinToSupernode(pin.hash);
      
      // Verify the pin
      const verified = await this.checkSupernodePin(pin.hash);
      if (verified) {
        logger.info(`✅ Successfully synced pin ${pin.hash} to supernode`);
        await this.database.markSynced(pin.hash);
        
        // Optionally remove local pin after successful sync
        if (this.config.ipfs?.remove_local_after_sync) {
          await this.removeLocalPin(pin.hash);
        }
      } else {
        throw new Error('Pin verification failed after sync');
      }

    } catch (error: any) {
      logger.error(`❌ Failed to sync pin ${pin.hash}:`, error.message);
      await this.database.updateSyncStatus(pin.hash, 'failed', error.message);
    }
  }

  private async checkSupernodePin(hash: string): Promise<boolean> {
    try {
      const axios = await import('axios');
      const threeSpeakIPFS = this.config.ipfs?.threespeak_endpoint || 'http://65.21.201.94:5002';
      
      const response = await axios.default.post(
        `${threeSpeakIPFS}/api/v0/pin/ls?arg=${hash}`,
        null,
        { timeout: 10000 }
      );

      // Check if the response indicates the pin exists
      return response.status === 200 && !response.data.includes('not pinned');
      
    } catch (error: any) {
      // If 404 or "not pinned" error, pin doesn't exist
      if (error.response?.status === 404 || error.message.includes('not pinned')) {
        return false;
      }
      throw error;
    }
  }

  private async pinToSupernode(hash: string): Promise<void> {
    try {
      const axios = await import('axios');
      const threeSpeakIPFS = this.config.ipfs?.threespeak_endpoint || 'http://65.21.201.94:5002';
      
      await axios.default.post(
        `${threeSpeakIPFS}/api/v0/pin/add?arg=${hash}&recursive=true`,
        null,
        { 
          timeout: 120000, // 2 minutes for large content
          maxContentLength: 10 * 1024 * 1024
        }
      );

    } catch (error: any) {
      logger.error(`❌ Failed to pin ${hash} to supernode:`, error.message);
      throw error;
    }
  }

  private async removeLocalPin(hash: string): Promise<void> {
    try {
      // This would use the local IPFS client to unpin
      // Implementation depends on how you want to handle this
      logger.info(`🗑️ Would remove local pin: ${hash} (not implemented)`);
      // await this.localIPFS.pin.rm(hash);
    } catch (error: any) {
      logger.warn(`⚠️ Failed to remove local pin ${hash}:`, error.message);
      // Non-critical - don't throw
    }
  }

  async getStats(): Promise<any> {
    return await this.database.getStats();
  }

  async forceSyncPin(hash: string): Promise<boolean> {
    try {
      const pins = await this.database.getPendingPins(1000);
      const pin = pins.find(p => p.hash === hash);
      
      if (!pin) {
        logger.warn(`⚠️ Pin ${hash} not found in local database`);
        return false;
      }

      await this.syncSinglePin(pin);
      return true;
      
    } catch (error) {
      logger.error(`❌ Failed to force sync pin ${hash}:`, error);
      return false;
    }
  }
}