import winston from 'winston';
import Transport from 'winston-transport';
import { DashboardService } from './DashboardService.js';

// Custom Winston transport that forwards logs to dashboard
class DashboardTransport extends Transport {
  private dashboard?: DashboardService;

  constructor(options: any = {}) {
    super(options);
  }

  setDashboard(dashboard: DashboardService): void {
    this.dashboard = dashboard;
  }

  override log(info: any, callback: () => void): void {
    if (this.dashboard) {
      // Forward log to dashboard - extract clean message and metadata
      const message = info.message || '';
      const meta = { ...info };
      delete meta.message;
      delete meta.level;
      delete meta.timestamp;
      
      this.dashboard.sendLog(info.level, message, Object.keys(meta).length > 0 ? meta : undefined);
    }
    callback();
  }
}

// Create dashboard transport instance
export const dashboardTransport = new DashboardTransport();

// Create logger instance
export const logger = winston.createLogger({
  level: 'info',
  format: winston.format.combine(
    winston.format.timestamp(),
    winston.format.errors({ stack: true }),
    winston.format.json()
  ),
  transports: [
    new winston.transports.Console({
      format: winston.format.combine(
        winston.format.colorize(),
        winston.format.simple()
      )
    }),
    new winston.transports.File({
      filename: 'encoder-error.log',
      level: 'error'
    }),
    new winston.transports.File({
      filename: 'encoder.log'
    }),
    dashboardTransport  // Add dashboard transport for live logs
  ]
});

// Add console formatting for development
if (process.env.NODE_ENV !== 'production') {
  logger.add(new winston.transports.Console({
    format: winston.format.combine(
      winston.format.colorize(),
      winston.format.timestamp({ format: 'HH:mm:ss' }),
      winston.format.printf(({ timestamp, level, message, ...meta }) => {
        let metaString = '';
        if (Object.keys(meta).length > 0) {
          try {
            metaString = ' ' + JSON.stringify(meta, (key, value) => {
              // Avoid circular references and large objects
              if (key === 'config' || key === 'request' || key === 'response') {
                return '[Object]';
              }
              if (typeof value === 'object' && value !== null) {
                if (value.constructor && value.constructor.name === 'AxiosError') {
                  return `AxiosError: ${value.message} (status: ${value.status || 'unknown'})`;
                }
                if (value.constructor && value.constructor.name === 'ClientRequest') {
                  return '[ClientRequest]';
                }
                if (value.constructor && value.constructor.name === 'IncomingMessage') {
                  return '[IncomingMessage]';
                }
              }
              return value;
            });
          } catch (err) {
            metaString = ' [Logging Error: Cannot serialize object]';
          }
        }
        return `${timestamp} ${level}: ${message}${metaString}`;
      })
    )
  }));
}