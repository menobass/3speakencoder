#!/usr/bin/env node

/**
 * Test script to verify IPFS cluster pinning functionality
 * This tests the cluster API without affecting main daemon load
 */

import axios from 'axios';

async function testClusterAPI() {
  const clusterEndpoint = 'http://65.21.201.94:9094';
  console.log('🔧 Testing IPFS Cluster API functionality...\n');

  try {
    // Test 1: Check cluster identity
    console.log('📋 Test 1: Cluster Identity');
    const idResponse = await axios.get(`${clusterEndpoint}/id`, { timeout: 10000 });
    console.log(`✅ Cluster ID: ${idResponse.data.id}`);
    console.log(`✅ Cluster Version: ${idResponse.data.version}`);
    console.log(`✅ Peername: ${idResponse.data.peername}`);
    console.log(`✅ Active peers: ${idResponse.data.cluster_peers?.length || 0}\n`);

    // Test 2: Test pinning a small hash (directory hash from earlier test)
    console.log('📌 Test 2: Pin Hash');
    const testHash = 'QmYwAPJzv5CZsnA625s3Xf2nemtYgPpHdWEz79ojWnPbdG';
    const pinResponse = await axios.post(`${clusterEndpoint}/pins/${testHash}`, null, {
      timeout: 30000,
      headers: { 'Content-Type': 'application/json' }
    });
    console.log(`✅ Pin request successful for: ${testHash}`);
    console.log(`📊 Pin status: ${pinResponse.data.peer_map ? 'queued/processing' : 'unknown'}\n`);

    // Test 3: Check pin status
    console.log('🔍 Test 3: Check Pin Status');
    const statusResponse = await axios.get(`${clusterEndpoint}/pins/${testHash}`, { timeout: 10000 });
    console.log(`✅ Pin exists in cluster`);
    console.log(`📊 Status: ${statusResponse.data.peer_map ? Object.values(statusResponse.data.peer_map)[0]?.status : 'unknown'}\n`);

    // Test 4: List recent pins (limited)
    console.log('📝 Test 4: List Recent Pins (last 5)');
    const listResponse = await axios.get(`${clusterEndpoint}/pins`, { timeout: 10000 });
    if (typeof listResponse.data === 'string') {
      // Response is NDJSON, split by lines
      const pins = listResponse.data.trim().split('\n')
        .slice(0, 5)
        .map(line => JSON.parse(line));
      
      console.log(`✅ Found ${pins.length} recent pins:`);
      pins.forEach((pin, index) => {
        const status = pin.peer_map ? Object.values(pin.peer_map)[0]?.status : 'unknown';
        console.log(`   ${index + 1}. ${pin.cid} (${status})`);
      });
    } else {
      console.log(`✅ Cluster API response format: object (${typeof listResponse.data})`);
    }

    console.log('\n🎉 All cluster tests passed!');
    console.log('💡 The encoder can now use cluster for pins to reduce main daemon load.');
    console.log('💡 To enable: set USE_CLUSTER_FOR_PINS=true in your .env file');

  } catch (error) {
    console.error('❌ Cluster test failed:', error.message);
    if (error.response) {
      console.error(`   Status: ${error.response.status}`);
      console.error(`   Data:`, error.response.data);
    }
    process.exit(1);
  }
}

// Run the test
testClusterAPI().catch(console.error);