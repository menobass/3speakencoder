#!/usr/bin/env node

/**
 * Configuration validation script
 * Run: npm run validate-config
 */

import { config } from 'dotenv';
import { loadConfig } from '../dist/config/ConfigLoader.js';

// Load environment variables (priority: .env.local > .env)
config({ path: '.env.local' });
config({ path: '.env' });

async function validateConfig() {
  try {
    console.log('🔍 Validating configuration...\n');
    
    // Check if .env file exists
    const fs = await import('fs');
    if (!fs.existsSync('.env')) {
      console.log('⚠️  No .env file found. Copy .env.example to .env first.');
      console.log('   Run: cp .env.example .env\n');
      process.exit(1);
    }
    
    // Check required environment variables
    const required = ['HIVE_USERNAME'];
    const missing = required.filter(key => !process.env[key] || process.env[key].startsWith('your-'));
    
    if (missing.length > 0) {
      console.log('❌ Missing required configuration:');
      missing.forEach(key => console.log(`   - ${key}`));
      console.log('\nPlease edit your .env file with real values.\n');
      process.exit(1);
    }
    
    // Check optional authentication
    const hasPrivateKey = process.env.ENCODER_PRIVATE_KEY && !process.env.ENCODER_PRIVATE_KEY.startsWith('your-');
    if (!hasPrivateKey) {
      console.log('⚠️  No encoder private key configured - will auto-generate one on startup');
      console.log('    💡 This is NOT your Hive key - it\'s for encoder-gateway authentication');
    }
    
    // Load and validate configuration
    const encoderConfig = await loadConfig();
    console.log('✅ Configuration is valid!');
    console.log(`   Node name: ${encoderConfig.node.name}`);
    console.log(`   Hive user: ${encoderConfig.node.cryptoAccounts?.hive}`);
    console.log(`   Gateway: ${encoderConfig.gateway_client?.gateway_url}`);
    console.log(`   IPFS: ${encoderConfig.ipfs?.apiAddr}`);
    console.log(`   Hardware acceleration: ${encoderConfig.encoder?.hardware_acceleration}`);
    console.log('\n🚀 Ready to start encoding!\n');
    
  } catch (error) {
    console.error('❌ Configuration validation failed:');
    console.error(`   ${error.message}\n`);
    process.exit(1);
  }
}

validateConfig();