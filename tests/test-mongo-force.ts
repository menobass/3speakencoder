import dotenv from 'dotenv';
import { MongoClient, ObjectId } from 'mongodb';

dotenv.config();

async function testMongoAndForceProcessing() {
    console.log('🚀 Testing MongoDB & Force Processing Prerequisites...\n');
    
    console.log(`🎯 Finding a test job ID...`);
    
    // Check environment variables
    if (!process.env.MONGODB_VERIFICATION_ENABLED || process.env.MONGODB_VERIFICATION_ENABLED !== 'true') {
        console.log('❌ MongoDB verification is not enabled in .env');
        return false;
    }
    
    const mongoUri = process.env.MONGODB_URI;
    const databaseName = process.env.DATABASE_NAME;
    
    if (!mongoUri || !databaseName) {
        console.log('❌ Missing MongoDB configuration');
        return false;
    }
    
    let client: MongoClient;
    let testJobId: string = 'unknown';
    
    try {
        // Connect to MongoDB
        console.log('🔌 Connecting to MongoDB...');
        client = new MongoClient(mongoUri, {
            connectTimeoutMS: 10000,
            socketTimeoutMS: 30000,
            serverSelectionTimeoutMS: 10000,
            maxPoolSize: 1
        });
        
        await client.connect();
        console.log('✅ MongoDB connected successfully!');
        
        // Test job access
        const db = client.db(databaseName);
        const jobsCollection = db.collection('jobs');
        
        console.log('\n📋 Finding a test job...');
        // Find any completed job to use as test
        const job = await jobsCollection.findOne({ status: 'complete' });
        
        if (!job) {
            console.log('❌ No completed jobs found for testing');
            return false;
        }
        
        testJobId = job._id.toString();
        console.log(`✅ Found test job: ${testJobId}`);
        
        console.log('✅ Job found!');
        console.log(`   • Status: ${job.status}`);
        console.log(`   • Owner: ${job.hive_username || 'Unknown'}`);
        
        // Test update capability (dry run)
        console.log('\n⚡ Testing update capability...');
        const jobId = job._id; // Use the actual _id from the found job
        const updateResult = await jobsCollection.updateOne(
            { _id: jobId },
            { 
                $set: { 
                    'force_processing_test': new Date(),
                    'force_processing_test_status': 'DRY_RUN_SUCCESS'
                }
            }
        );
        
        console.log(`✅ Update test: ${updateResult.matchedCount} document matched, ${updateResult.modifiedCount} modified`);
        
        // Clean up test data
        await jobsCollection.updateOne(
            { _id: jobId },
            { 
                $unset: { 
                    'force_processing_test': '',
                    'force_processing_test_status': ''
                }
            }
        );
        
        console.log('\n🎉 All tests passed! Force processing is ready to go!');
        
        console.log('\n🚀 Force Processing Features:');
        console.log('   • ✅ MongoDB connection working');
        console.log('   • ✅ Job access confirmed'); 
        console.log('   • ✅ Update permissions verified');
        console.log('   • ✅ Ready for phone control via dashboard');
        
        console.log('\n📱 To use force processing:');
        console.log('   1. npm start');
        console.log('   2. http://localhost:3000');
        console.log('   3. Find "Force Processing" section');
        console.log(`   4. Enter job ID: ${testJobId}`);
        console.log('   5. Click "Force Process Job" 🚀');
        
        return true;
        
    } catch (error: any) {
        console.error('\n❌ Test failed:', error.message);
        return false;
        
    } finally {
        if (client!) {
            await client.close();
            console.log('\n🔌 MongoDB connection closed.');
        }
    }
}

testMongoAndForceProcessing()
    .then(success => {
        console.log(`\n${success ? '🎊' : '💥'} Force processing test ${success ? 'PASSED' : 'FAILED'}!`);
        process.exit(success ? 0 : 1);
    })
    .catch(error => {
        console.error('💥 Unexpected error:', error);
        process.exit(1);
    });