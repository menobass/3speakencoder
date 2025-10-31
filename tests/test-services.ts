#!/usr/bin/env node
import { logger } from './services/Logger.js';

async function testServices() {
  try {
    logger.info('🧪 Testing 3Speak Encoder Services...');
    
    // Test 1: Logger
    logger.info('✅ Logger working');
    logger.warn('⚠️ Warning test');
    logger.error('❌ Error test (this is expected)');
    
    // Test 2: Video Processor (without full init)
    const { VideoProcessor } = await import('./services/VideoProcessor');
    logger.info('✅ VideoProcessor imported successfully');
    
    // Test 3: IPFS Service (without connection)
    const { IPFSService } = await import('./services/IPFSService');
    logger.info('✅ IPFSService imported successfully');
    
    // Test 4: Gateway Client (without connection)
    const { GatewayClient } = await import('./services/GatewayClient');
    logger.info('✅ GatewayClient imported successfully');
    
    // Test 5: Identity Service (without keys)
    const { IdentityService } = await import('./services/IdentityService');
    logger.info('✅ IdentityService imported successfully');
    
    logger.info('🎉 All services imported successfully!');
    logger.info('📝 To run the full encoder, create ~/.spk-encoder/config');
    
  } catch (error) {
    logger.error('💥 Service test failed:', error);
    process.exit(1);
  }
}

testServices().catch((error) => {
  logger.error('💥 Unhandled error in service test:', error);
  process.exit(1);
});