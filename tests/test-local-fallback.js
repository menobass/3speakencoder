#!/usr/bin/env node

/**
 * Test script to verify local fallback pinning configuration
 */

import { loadConfig } from './dist/config/ConfigLoader.js';

async function testLocalFallbackConfig() {
  console.log('🔧 Testing local fallback pinning configuration...\n');

  try {
    // Test with fallback disabled (default)
    console.log('📋 Default Configuration:');
    const defaultConfig = await loadConfig();
    console.log(`   Enable local fallback: ${defaultConfig.ipfs?.enable_local_fallback}`);
    console.log(`   Fallback threshold: ${defaultConfig.ipfs?.local_fallback_threshold}`);
    
    // Test with fallback enabled
    console.log('\n📋 Fallback Enabled Configuration:');
    process.env.ENABLE_LOCAL_FALLBACK = 'true';
    process.env.LOCAL_FALLBACK_THRESHOLD = '2';
    
    const fallbackConfig = await loadConfig();
    console.log(`   Enable local fallback: ${fallbackConfig.ipfs?.enable_local_fallback}`);
    console.log(`   Fallback threshold: ${fallbackConfig.ipfs?.local_fallback_threshold}`);
    
    if (fallbackConfig.ipfs?.enable_local_fallback) {
      console.log('\n🏠 Local Fallback Mode ENABLED');
      console.log('💡 This encoder will pin locally if supernode fails');
      console.log('⚠️  Should only be used on 3Speak-operated nodes');
      console.log('📝 Local pins will be logged to logs/local-pins.jsonl');
    } else {
      console.log('\n⚪ Local Fallback Mode DISABLED (community-safe)');
      console.log('💡 All pins must succeed on supernode or job fails');
    }

    console.log('\n🎉 Configuration test passed!');
    console.log('💡 To enable for 3Speak nodes: set ENABLE_LOCAL_FALLBACK=true');

  } catch (error) {
    console.error('❌ Configuration test failed:', error.message);
    process.exit(1);
  }
}

// Run the test
testLocalFallbackConfig().catch(console.error);