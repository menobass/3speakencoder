#!/usr/bin/env node

import { MongoClient } from 'mongodb';
import dotenv from 'dotenv';

dotenv.config();

async function testMongoDBConnection() {
    console.log('🔍 Testing MongoDB Connection...\n');
    
    const mongoUri = process.env.MONGODB_URI;
    const databaseName = process.env.DATABASE_NAME;
    
    if (!mongoUri) {
        console.log('❌ Error: MONGODB_URI not found in environment variables');
        return false;
    }
    
    if (!databaseName) {
        console.log('❌ Error: DATABASE_NAME not found in environment variables');
        return false;
    }
    
    console.log(`📍 MongoDB URI: ${mongoUri.replace(/\/\/[^@]+@/, '//***:***@')}`);
    console.log(`🗃️  Database: ${databaseName}\n`);
    
    let client;
    try {
        // Create connection
        console.log('🔌 Connecting to MongoDB...');
        client = new MongoClient(mongoUri, {
            connectTimeoutMS: 10000,
            socketTimeoutMS: 30000,
            serverSelectionTimeoutMS: 10000,
            maxPoolSize: 1
        });
        
        await client.connect();
        console.log('✅ Connected to MongoDB successfully!\n');
        
        // Test database access
        console.log('🔍 Testing database access...');
        const db = client.db(databaseName);
        const collections = await db.listCollections().toArray();
        console.log(`✅ Database accessible! Found ${collections.length} collections:`);
        
        collections.forEach(collection => {
            console.log(`   • ${collection.name}`);
        });
        
        // Test jobs collection specifically
        console.log('\n🎯 Testing jobs collection...');
        const jobsCollection = db.collection('jobs');
        
        // Count total jobs
        const totalJobs = await jobsCollection.countDocuments();
        console.log(`📊 Total jobs in database: ${totalJobs}`);
        
        // Count jobs by status
        const statusCounts = await jobsCollection.aggregate([
            { $group: { _id: '$status', count: { $sum: 1 } } },
            { $sort: { count: -1 } }
        ]).toArray();
        
        console.log('📈 Jobs by status:');
        statusCounts.forEach(status => {
            console.log(`   • ${status._id}: ${status.count}`);
        });
        
        // Find a sample job
        console.log('\n🔍 Sample job (for testing):');
        const sampleJob = await jobsCollection.findOne({}, { 
            sort: { _id: -1 },
            limit: 1 
        });
        
        if (sampleJob) {
            console.log(`   • Job ID: ${sampleJob._id}`);
            console.log(`   • Status: ${sampleJob.status}`);
            console.log(`   • Created: ${sampleJob.createdAt || 'Unknown'}`);
            console.log(`   • Owner: ${sampleJob.hive_username || 'Unknown'}`);
        } else {
            console.log('   • No jobs found in database');
        }
        
        console.log('\n🎉 MongoDB connection test completed successfully!');
        console.log('✨ Force processing feature should work with this connection.');
        
        return true;
        
    } catch (error) {
        console.error('\n❌ MongoDB connection failed:');
        console.error(`   Error: ${error.message}`);
        
        if (error.code) {
            console.error(`   Code: ${error.code}`);
        }
        
        // Common error help
        if (error.message.includes('ECONNREFUSED')) {
            console.log('\n💡 Possible solutions:');
            console.log('   • Check if MongoDB server is running');
            console.log('   • Verify the host and port in MONGODB_URI');
            console.log('   • Check firewall settings');
        } else if (error.message.includes('authentication')) {
            console.log('\n💡 Authentication issue:');
            console.log('   • Check username and password in MONGODB_URI');
            console.log('   • Verify database permissions');
        } else if (error.message.includes('timeout')) {
            console.log('\n💡 Connection timeout:');
            console.log('   • Network may be slow or unstable');
            console.log('   • Try increasing timeout values');
        }
        
        return false;
        
    } finally {
        if (client) {
            await client.close();
            console.log('\n🔌 MongoDB connection closed.');
        }
    }
}

// Run the test
testMongoDBConnection()
    .then(success => {
        process.exit(success ? 0 : 1);
    })
    .catch(error => {
        console.error('💥 Unexpected error:', error);
        process.exit(1);
    });

export default testMongoDBConnection;