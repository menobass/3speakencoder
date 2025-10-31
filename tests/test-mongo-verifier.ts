#!/usr/bin/env tsx

/**
 * 🧪 MongoDB Verifier Test
 * 
 * Test script to verify MongoDB direct verification functionality
 * This simulates the scenario where gateway APIs fail and we need 
 * to verify job ownership directly from MongoDB.
 */

import { loadConfig } from './src/config/ConfigLoader.js';
import { MongoVerifier } from './src/services/MongoVerifier.js';
import { logger } from './src/services/Logger.js';

async function testMongoVerifier() {
  console.log('🧪 Testing MongoDB Direct Verification...\n');

  try {
    // Load configuration
    const config = await loadConfig();
    
    if (!config.mongodb?.enabled) {
      console.log('❌ MongoDB verification is disabled');
      console.log('💡 To enable: set MONGODB_VERIFICATION_ENABLED=true in .env');
      console.log('💡 Also need: MONGODB_URI and DATABASE_NAME');
      return;
    }

    if (!config.mongodb?.uri || !config.mongodb?.database_name) {
      console.log('❌ MongoDB configuration incomplete');
      console.log('💡 Need MONGODB_URI and DATABASE_NAME in .env');
      return;
    }

    console.log('✅ MongoDB configuration found');
    console.log(`📊 Database: ${config.mongodb.database_name}`);
    console.log('🔌 Connecting to MongoDB...\n');

    // Initialize verifier
    const verifier = new MongoVerifier(config);
    await verifier.initialize();

    if (!verifier.isEnabled()) {
      console.log('❌ MongoDB verifier failed to initialize');
      return;
    }

    console.log('✅ MongoDB verifier connected successfully\n');

    // Test health check
    console.log('🔍 Testing health check...');
    const isHealthy = await verifier.healthCheck();
    console.log(`Health check result: ${isHealthy ? '✅ Healthy' : '❌ Unhealthy'}\n`);

    // Test with a sample job ID (replace with a real one for testing)
    const testJobId = '1594d4fd-10a0-4d78-95a8-7618a17d652a'; // From your example
    const testDID = 'did:key:z6Mkp2NYvtdCXx8DRZ4uyqe6phjqZA9QU2awwZigTYv2kJkJ'; // From your example

    console.log(`🔍 Testing job ownership verification...`);
    console.log(`📄 Job ID: ${testJobId}`);
    console.log(`🔑 Expected DID: ${testDID}\n`);

    try {
      const result = await verifier.verifyJobOwnership(testJobId, testDID);
      
      console.log('📊 Verification Results:');
      console.log(`   Job exists: ${result.jobExists ? '✅ Yes' : '❌ No'}`);
      console.log(`   Is owned by us: ${result.isOwned ? '✅ Yes' : '❌ No'}`);
      if (result.actualOwner) {
        console.log(`   Actual owner: ${result.actualOwner}`);
      }
      if (result.status) {
        console.log(`   Job status: ${result.status}`);
      }

      if (result.rawDocument) {
        console.log('\n📄 Raw MongoDB document:');
        console.log(`   Created: ${result.rawDocument.created_at}`);
        console.log(`   Last pinged: ${result.rawDocument.last_pinged || 'Never'}`);
        console.log(`   Attempt count: ${result.rawDocument.attempt_count || 0}`);
        console.log(`   Video: ${result.rawDocument.metadata?.video_owner}/${result.rawDocument.metadata?.video_permlink}`);
      }

    } catch (error) {
      console.log(`❌ Verification failed: ${error}`);
    }

    // Test getting raw job details
    console.log('\n🔍 Testing raw job details retrieval...');
    try {
      const jobDetails = await verifier.getJobDetails(testJobId);
      if (jobDetails) {
        console.log('✅ Retrieved job details from MongoDB');
        console.log(`   Job ID: ${jobDetails.id}`);
        console.log(`   Status: ${jobDetails.status}`);
        console.log(`   Input size: ${(jobDetails.input.size / 1024 / 1024).toFixed(2)} MB`);
      } else {
        console.log('❌ Job not found in MongoDB');
      }
    } catch (error) {
      console.log(`❌ Failed to get job details: ${error}`);
    }

    // Get verifier status
    console.log('\n📊 Verifier Status:');
    const status = verifier.getStatus();
    console.log(`   Enabled: ${status.enabled ? '✅' : '❌'}`);
    console.log(`   Connected: ${status.connected ? '✅' : '❌'}`);
    console.log(`   Connection attempts: ${status.connectionAttempts}`);
    if (status.databaseName) {
      console.log(`   Database: ${status.databaseName}`);
    }

    // Cleanup
    console.log('\n🧹 Cleaning up...');
    await verifier.cleanup();
    console.log('✅ MongoDB verifier test completed');

  } catch (error) {
    console.error('❌ Test failed:', error);
  }
}

// Run the test if this script is executed directly
if (import.meta.url === `file://${process.argv[1]}`) {
  testMongoVerifier().catch(console.error);
}

export { testMongoVerifier };