#!/usr/bin/env node
import { ThreeSpeakEncoder } from './services/ThreeSpeakEncoder.js';
import { DashboardService } from './services/DashboardService.js';
import { logger, dashboardTransport } from './services/Logger.js';
import { loadConfig } from './config/ConfigLoader.js';

async function main() {
  try {
    logger.info('🚀 Starting 3Speak Modern Video Encoder...');
    
    // Load configuration
    const config = await loadConfig();
    logger.info('✅ Configuration loaded');
    
    // Start dashboard service
    const dashboard = new DashboardService(3001);
    await dashboard.start();
    logger.info(`📊 Dashboard available at: ${dashboard.getUrl()}`);
    
    // Connect logger to dashboard for live log streaming
    dashboardTransport.setDashboard(dashboard);
    logger.info('✅ Live dashboard logs enabled');
    
    // Initialize and start encoder
    const encoder = new ThreeSpeakEncoder(config, dashboard);
    dashboard.setEncoder(encoder); // Connect encoder to dashboard for maintenance operations
    await encoder.start();
    
    logger.info('✅ 3Speak Encoder is ready and running!');
    
    // Graceful shutdown handling
    process.on('SIGINT', async () => {
      logger.info('📴 Shutting down encoder...');
      await encoder.stop();
      process.exit(0);
    });
    
    process.on('SIGTERM', async () => {
      logger.info('📴 Shutting down encoder...');
      await encoder.stop();
      process.exit(0);
    });
    
  } catch (error) {
    logger.error('💥 Failed to start encoder:', error);
    process.exit(1);
  }
}

main().catch((error) => {
  logger.error('💥 Unhandled error:', error);
  process.exit(1);
});