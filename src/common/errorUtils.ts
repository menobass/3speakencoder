/**
 * Utility functions for handling and logging errors cleanly
 * Prevents massive buffer dumps in logs from Node.js internal objects
 */

export interface CleanError {
  message?: string;
  name?: string;
  code?: string | number;
  status?: number;
  statusText?: string;
  hostname?: string;
  syscall?: string;
  errno?: number;
  stack?: string;
}

/**
 * Cleans error objects for logging by removing internal Node.js buffers and circular references
 * @param error - Any error object that might contain internal Node.js data
 * @returns A clean error object safe for JSON serialization and logging
 */
export function cleanErrorForLogging(error: any): CleanError | null {
  if (!error) return null;
  
  // Handle different error types
  const cleaned: CleanError = {};
  
  if (error.message) cleaned.message = error.message;
  if (error.name) cleaned.name = error.name;
  if (error.code) cleaned.code = error.code;
  if (error.status) cleaned.status = error.status;
  if (error.statusText) cleaned.statusText = error.statusText;
  if (error.hostname) cleaned.hostname = error.hostname;
  if (error.syscall) cleaned.syscall = error.syscall;
  if (error.errno) cleaned.errno = error.errno;
  
  // Include stack trace but limit it to prevent huge dumps
  if (error.stack && typeof error.stack === 'string') {
    const stackLines = error.stack.split('\n');
    // Keep first 8 lines of stack trace (error + 7 stack frames)
    cleaned.stack = stackLines.slice(0, 8).join('\n');
  }
  
  return cleaned;
}

/**
 * Formats an error for user-friendly display
 * @param error - The error to format
 * @returns A human-readable error message
 */
export function formatErrorMessage(error: any): string {
  if (!error) return 'Unknown error';
  
  if (error.code === 'ENOTFOUND') {
    return `Network error: Cannot resolve hostname ${error.hostname}`;
  }
  
  if (error.code === 'ECONNREFUSED') {
    return `Connection refused: ${error.hostname || 'server'} is not responding`;
  }
  
  if (error.status === 404) {
    return 'Resource not found (404)';
  }
  
  if (error.status === 500) {
    return 'Server error (500)';
  }
  
  if (error.status === 503) {
    return 'Service unavailable (503)';
  }
  
  return error.message || error.toString() || 'Unknown error';
}

/**
 * Determines if an error is a network/connectivity issue that might be temporary
 * @param error - The error to check
 * @returns True if the error appears to be a temporary network issue
 */
export function isTemporaryNetworkError(error: any): boolean {
  if (!error) return false;
  
  const temporaryCodes = ['ENOTFOUND', 'ECONNREFUSED', 'ETIMEOUT', 'ECONNRESET'];
  const temporaryStatus = [408, 500, 502, 503, 504];
  
  return temporaryCodes.includes(error.code) || 
         temporaryStatus.includes(error.status) ||
         error.message?.includes('timeout') ||
         error.message?.includes('network');
}