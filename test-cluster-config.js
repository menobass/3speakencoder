#!/usr/bin/env node

/**
 * Test script to verify encoder cluster configuration loads correctly
 */

import { loadConfig } from './dist/config/ConfigLoader.js';

async function testClusterConfig() {
  console.log('🔧 Testing encoder cluster configuration...\n');

  try {
    // Load config with cluster settings
    process.env.USE_CLUSTER_FOR_PINS = 'true';
    process.env.IPFS_CLUSTER_ENDPOINT = 'http://65.21.201.94:9094';
    
    const config = await loadConfig();
    
    console.log('📋 IPFS Configuration:');
    console.log(`   Main endpoint: ${config.ipfs?.threespeak_endpoint}`);
    console.log(`   Cluster endpoint: ${config.ipfs?.cluster_endpoint}`);
    console.log(`   Use cluster for pins: ${config.ipfs?.use_cluster_for_pins}`);
    
    if (config.ipfs?.use_cluster_for_pins) {
      console.log('\n✅ Cluster pinning is ENABLED');
      console.log('💡 This will reduce load on the main IPFS daemon');
      console.log('💡 Pins will go to cluster, uploads will still use main daemon');
    } else {
      console.log('\n⚪ Cluster pinning is DISABLED (using main daemon for everything)');
    }

    console.log('\n🎉 Configuration test passed!');
    console.log('💡 To enable cluster pinning in production: set USE_CLUSTER_FOR_PINS=true');

  } catch (error) {
    console.error('❌ Configuration test failed:', error.message);
    process.exit(1);
  }
}

// Run the test
testClusterConfig().catch(console.error);