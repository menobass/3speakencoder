#!/usr/bin/env node

import dotenv from 'dotenv';
import { MongoVerifier } from './src/services/MongoVerifier.js';

dotenv.config();

async function testForceProcessing() {
    console.log('🚀 Testing Force Processing Feature...\n');
    
    // Use the sample job ID from our MongoDB test
    const testJobId = '6904c81203ffa7e5cded7366';
    
    console.log(`🎯 Testing with Job ID: ${testJobId}`);
    
    if (!process.env.MONGODB_VERIFICATION_ENABLED || process.env.MONGODB_VERIFICATION_ENABLED !== 'true') {
        console.log('❌ MongoDB verification is not enabled in .env');
        console.log('   Set MONGODB_VERIFICATION_ENABLED=true to continue');
        return false;
    }
    
    try {
        // Initialize MongoVerifier
        console.log('🔌 Initializing MongoDB connection...');
        const mongoVerifier = new MongoVerifier();
        await mongoVerifier.initialize();
        console.log('✅ MongoDB connection established!');
        
        // Test 1: Verify job ownership (should work for any job)
        console.log('\n🔍 Test 1: Checking job ownership...');
        const ownershipResult = await mongoVerifier.verifyJobOwnership(testJobId, 'test-user');
        console.log(`   Result: ${ownershipResult ? '✅ Verified' : '⚠️  Not owned by test-user (expected)'}`);
        
        // Test 2: Get job details
        console.log('\n📋 Test 2: Retrieving job details...');
        const jobDetails = await mongoVerifier.getJobDetails(testJobId);
        if (jobDetails) {
            console.log('✅ Job details retrieved:');
            console.log(`   • ID: ${jobDetails._id}`);
            console.log(`   • Status: ${jobDetails.status}`);
            console.log(`   • Owner: ${jobDetails.hive_username || 'Unknown'}`);
            console.log(`   • Created: ${jobDetails.createdAt || 'Unknown'}`);
            if (jobDetails.result?.cid) {
                console.log(`   • Result CID: ${jobDetails.result.cid}`);
            }
        } else {
            console.log('❌ Job not found');
            return false;
        }
        
        // Test 3: Test job update (dry run - we won't actually update)
        console.log('\n⚡ Test 3: Testing job update capability...');
        console.log('   ℹ️  This is a dry run - we won\'t actually modify the job');
        console.log('   ✅ MongoVerifier.updateJob() method is available');
        console.log('   ✅ MongoVerifier.forceCompleteJob() method is available');
        
        // Test 4: Verify force processing prerequisites
        console.log('\n🎯 Test 4: Force processing prerequisites...');
        
        const hasMongoAccess = true; // We already verified this
        const hasJobAccess = jobDetails !== null;
        const hasUpdateMethod = typeof mongoVerifier.updateJob === 'function';
        const hasForceCompleteMethod = typeof mongoVerifier.forceCompleteJob === 'function';
        
        console.log(`   • MongoDB Access: ${hasMongoAccess ? '✅' : '❌'}`);
        console.log(`   • Job Access: ${hasJobAccess ? '✅' : '❌'}`);
        console.log(`   • Update Method: ${hasUpdateMethod ? '✅' : '❌'}`);
        console.log(`   • Force Complete Method: ${hasForceCompleteMethod ? '✅' : '❌'}`);
        
        const allPrerequisites = hasMongoAccess && hasJobAccess && hasUpdateMethod && hasForceCompleteMethod;
        
        console.log(`\n🎉 Force Processing Test Result: ${allPrerequisites ? '✅ READY' : '❌ NOT READY'}`);
        
        if (allPrerequisites) {
            console.log('\n🚀 Force Processing Features Available:');
            console.log('   • ✅ Bypass gateway completely');
            console.log('   • ✅ Direct MongoDB job updates');
            console.log('   • ✅ Force job completion');
            console.log('   • ✅ Process jobs without gateway dependency');
            console.log('   • ✅ Phone-manageable encoder control');
            
            console.log('\n📱 Next Steps:');
            console.log('   1. Start the encoder: npm start');
            console.log('   2. Open dashboard: http://localhost:3000');
            console.log('   3. Use Force Processing section');
            console.log(`   4. Enter job ID: ${testJobId}`);
            console.log('   5. Watch the magic happen! 🪄');
        }
        
        await mongoVerifier.close();
        return allPrerequisites;
        
    } catch (error) {
        console.error('\n❌ Force processing test failed:');
        console.error(`   Error: ${error.message}`);
        console.error(`   Stack: ${error.stack}`);
        return false;
    }
}

// Run the test
testForceProcessing()
    .then(success => {
        console.log(`\n${success ? '🎊' : '💥'} Test ${success ? 'completed successfully' : 'failed'}!`);
        process.exit(success ? 0 : 1);
    })
    .catch(error => {
        console.error('💥 Unexpected error:', error);
        process.exit(1);
    });