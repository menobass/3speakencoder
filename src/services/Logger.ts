import winston from 'winston';

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
    })
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