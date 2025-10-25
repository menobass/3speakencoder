#!/usr/bin/env node

/**
 * 3Speak Encoder Setup Script
 * Helps new users understand and configure the encoder
 */

import { config } from 'dotenv';
import * as fs from 'fs';
import * as readline from 'readline';
import * as crypto from 'crypto';

const rl = readline.createInterface({
  input: process.stdin,
  output: process.stdout
});

function ask(question: string): Promise<string> {
  return new Promise((resolve) => {
    rl.question(question, resolve);
  });
}

async function setupEncoder() {
  console.log('🎬 Welcome to 3Speak Modern Video Encoder Setup!\n');
  
  console.log('📋 This setup will create your .env configuration file.\n');
  
  // Check if .env already exists
  if (fs.existsSync('.env')) {
    console.log('⚠️  An .env file already exists.');
    const overwrite = await ask('Do you want to overwrite it? (y/N): ');
    if (overwrite.toLowerCase() !== 'y') {
      console.log('Setup cancelled. Your existing .env file was not modified.');
      rl.close();
      return;
    }
  }
  
  console.log('📝 Let\'s set up your encoder configuration:\n');
  
  // Get Hive username
  const hiveUsername = await ask('🔹 Enter your Hive username (for beneficiaries): ');
  if (!hiveUsername.trim()) {
    console.log('❌ Hive username is required. Exiting.');
    rl.close();
    return;
  }
  
  // Ask about node name
  const defaultNodeName = `${hiveUsername}'s 3Speak Encoder`;
  const nodeName = await ask(`🔹 Enter encoder node name (default: ${defaultNodeName}): `);
  
  // Ask about advanced options
  const showAdvanced = await ask('🔹 Show advanced options? (y/N): ');
  
  let gatewayUrl = 'https://encoder-gateway.infra.3speak.tv';
  if (showAdvanced.toLowerCase() === 'y') {
    const customGateway = await ask(`🔹 Gateway URL (default: ${gatewayUrl}): `);
    if (customGateway.trim()) {
      gatewayUrl = customGateway.trim();
    }
  }
  
  // Generate persistent encoder identity key
  console.log('🔑 Generating persistent encoder identity key...');
  const encoderPrivateKey = crypto.randomBytes(32).toString('base64');
  console.log('✅ Encoder identity key generated successfully!');
  
  // Create .env content
  const envContent = `# 3Speak Encoder Configuration
# Generated on ${new Date().toISOString()}

# Your Hive username (required for beneficiaries)
HIVE_USERNAME=${hiveUsername.trim()}

# Node configuration
NODE_NAME=${nodeName.trim() || defaultNodeName}

# Gateway configuration
GATEWAY_URL=${gatewayUrl}

# 🔑 Persistent Encoder Identity (CRITICAL - keeps same identity across restarts)
ENCODER_PRIVATE_KEY=${encoderPrivateKey}
# ⚠️  This is NOT your Hive key - it's for encoder authentication only
# ✅ Keep this secret and backed up - losing it creates a "new encoder"

# Advanced settings (optional)
# QUEUE_MAX_LENGTH=1
# QUEUE_CONCURRENCY=1
# MAX_CONCURRENT_JOBS=1
# HARDWARE_ACCELERATION=true
`;

  // Write .env file
  fs.writeFileSync('.env', envContent);
  
  console.log('\n✅ Configuration created successfully!\n');
  console.log('📁 Your .env file has been created with the following settings:');
  console.log(`   Hive Username: ${hiveUsername.trim()}`);
  console.log(`   Node Name: ${nodeName.trim() || defaultNodeName}`);
  console.log(`   Gateway: ${gatewayUrl}\n`);
  
  console.log('🔑 Important Notes:');
  console.log('   • ✅ Your persistent encoder identity key has been generated automatically');
  console.log('   • 🛡️  This ensures your encoder keeps the same identity across restarts');
  console.log('   • 📊 Perfect for dashboard tracking and job attribution');
  console.log('   • 🔐 This is NOT your Hive private key - it\'s just for encoder authentication');
  console.log('   • 🔒 Your Hive account remains secure - we only use your username for beneficiaries\n');
  
  console.log('🚀 Next steps:');
  console.log('   1. Run: npm start');
  console.log('   2. Your encoder will use its persistent identity automatically');
  console.log('   3. Start encoding videos for 3Speak!\n');
  console.log('💡 Tip: Back up your .env file to preserve your encoder identity!');
  
  console.log('🎯 Your encoder is ready to use!');
  
  rl.close();
}

setupEncoder().catch(console.error);