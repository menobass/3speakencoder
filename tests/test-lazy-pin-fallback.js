#!/usr/bin/env node

/**
 * 🧪 Test script to demonstrate the new lazy pin fallback feature
 * Shows how failed lazy pins get archived locally for batch processing
 */

const { PendingPinService } = await import('./dist/services/PendingPinService.js');
const { ConfigLoader } = await import('./dist/config/ConfigLoader.js');

async function testLazyPinFallback() {
  console.log('🧪 Testing lazy pin fallback feature...\n');

  try {
    // Load configuration with fallback enabled
    process.env.ENABLE_LOCAL_FALLBACK = 'true';
    process.env.LOCAL_FALLBACK_THRESHOLD = '2';
    
    const config = ConfigLoader.load();
    console.log(`🔧 Configuration loaded:`);
    console.log(`   Local fallback enabled: ${config.ipfs?.enable_local_fallback}`);
    console.log(`   Fallback threshold: ${config.ipfs?.local_fallback_threshold}\n`);

    // Create mock IPFS client that always fails
    const mockIPFSClient = {
      pin: {
        add: async (hash) => {
          throw new Error('Simulated remote pin failure');
        }
      }
    };

    // Initialize PendingPinService with fallback config
    const pendingPinService = new PendingPinService('./test-data', config, mockIPFSClient);
    await pendingPinService.initialize();
    
    console.log('📋 Simulating lazy pin failure scenario...');
    
    // Add a pending pin
    const testHash = 'QmTestHash123Simulation';
    const jobId = 'test-job-456';
    await pendingPinService.addPendingPin(testHash, jobId, 25.5, 'directory');
    
    console.log(`   Added ${testHash} to pending pins queue`);
    
    // Simulate 3 failed attempts (will trigger local fallback)
    console.log('\n🔄 Simulating failed lazy pin attempts...');
    
    for (let attempt = 1; attempt <= 3; attempt++) {
      console.log(`   Attempt ${attempt}/3: Remote pin failure`);
      await pendingPinService.markPinFailed(testHash, `Simulated failure ${attempt}`);
      
      if (attempt < 3) {
        console.log(`   Retry scheduled for later...`);
      }
    }
    
    console.log('\n✅ Test completed!');
    console.log('\n📊 Expected behavior:');
    console.log('   1. Hash added to pending pins queue');
    console.log('   2. 3 remote pin attempts failed');
    console.log('   3. Local fallback attempted (would fail in this simulation)');
    console.log('   4. Content logged to local-fallback-pins.jsonl database');
    console.log('   5. Database can be batch processed on permanent server');
    
    console.log('\n💡 In production with IPFS running:');
    console.log('   • Failed lazy pins get pinned locally');
    console.log('   • Creates database for batch supernode pinning');
    console.log('   • Zero content loss even when supernodes fail');
    console.log('   • Perfect for your batch processing workflow!');
    
  } catch (error) {
    console.error('❌ Test error:', error.message);
  }
}

testLazyPinFallback().catch(console.error);