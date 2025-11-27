/**
 * Copyright (C) 2022 to 2025
 * Nikolai Tschacher - ipapi.is
 * 
 * Usage of this source code without written consent 
 * of Nikolai Tschacher is not permitted.
 * 
 * Utility functions for ipapi_is_worker.js
 */

const fs = require('fs');
const path = require('path');
const os = require('os');
const { IPv4ToInt, IntToIPv4, abbreviateIPv6 } = require('ip_address_tools');
const { round, memUsage, executeCommandSync, log } = require('./utils.js');

// Define API Request Type
const API_REQUEST_TYPE = {
  STANDARD: 0x1, // normal single IP or ASN lookup
  STANDARD_CACHED: 0x2, // normal single IP or ASN lookup that was cached
  BULK: 0x3, // bulk lookup of multiple IPs or ASNs
  WHOIS: 0x4, // whois lookup of an IP or ASN
  DISTANCE: 0x5, // distance lookup of two IPs
  ERROR_INVALID_QUERY: 0x6, // this error type is used to indicate that an error occurred because the query was invalid (no IP or ASN)
  ERROR_UNKNOWN: 0x7, // this error type is used to indicate that an error occurred for an unknown reason
  ERROR_INVALID_HTTP_METHOD: 0x8, // this error type is used to indicate that an error occurred because the HTTP method was invalid
  ERROR_BULK: 0x9, // this error type is used to indicate that an error occurred during bulk lookup
};

// Define User API Status
const USER_API_STATUS = {
  ALLOWED: 0x1, // the user is allowed to make API requests
  NOT_ALLOWED: 0x2, // the user is denied to make API requests for whatever reason
  OVER_QUOTA: 0x3, // the user is over their quota and cannot make any more requests
};

// Define API Error Codes
// All API errors must include both 'error' message and 'error_code'
const API_ERROR_CODE = {
  // Input validation errors (1xx)
  INVALID_IP_OR_ASN: 'ERR_INVALID_IP_OR_ASN',
  INVALID_BULK_INPUT_NOT_ARRAY: 'ERR_INVALID_BULK_INPUT_NOT_ARRAY',
  INVALID_BULK_INPUT_EMPTY: 'ERR_INVALID_BULK_INPUT_EMPTY',
  INVALID_BULK_INPUT_NO_VALID_ENTRIES: 'ERR_INVALID_BULK_INPUT_NO_VALID_ENTRIES',
  INVALID_BULK_SIZE_CONFIG: 'ERR_INVALID_BULK_SIZE_CONFIG',
  INVALID_HTTP_METHOD: 'ERR_INVALID_HTTP_METHOD',
  INVALID_CONFIG: 'ERR_INVALID_CONFIG',

  // Quota and rate limit errors (2xx)
  RATE_LIMIT_EXCEEDED: 'ERR_RATE_LIMIT_EXCEEDED',
  QUOTA_EXCEEDED: 'ERR_QUOTA_EXCEEDED',
  BULK_LIMIT_EXCEEDED: 'ERR_BULK_LIMIT_EXCEEDED',

  // Authentication and authorization errors (3xx)
  FORBIDDEN: 'ERR_FORBIDDEN',
  FORBIDDEN_BLACKLISTED: 'ERR_FORBIDDEN_BLACKLISTED',
  FORBIDDEN_INVALID_API_KEY: 'ERR_FORBIDDEN_INVALID_API_KEY',
  FORBIDDEN_API_KEY_REQUIRED: 'ERR_FORBIDDEN_API_KEY_REQUIRED',
  FORBIDDEN_NOT_ALLOWED: 'ERR_FORBIDDEN_NOT_ALLOWED',

  // Feature/service errors (4xx)
  ASN_LOOKUP_DISABLED: 'ERR_ASN_LOOKUP_DISABLED',
  DISTANCE_CALCULATION_FAILED: 'ERR_DISTANCE_CALCULATION_FAILED',
  DISTANCE_INVALID_IP1: 'ERR_DISTANCE_INVALID_IP1',
  DISTANCE_INVALID_IP2: 'ERR_DISTANCE_INVALID_IP2',
  DISTANCE_LOCATION_NOT_FOUND_IP1: 'ERR_DISTANCE_LOCATION_NOT_FOUND_IP1',
  DISTANCE_LOCATION_NOT_FOUND_IP2: 'ERR_DISTANCE_LOCATION_NOT_FOUND_IP2',
  WHOIS_INVALID_QUERY: 'ERR_WHOIS_INVALID_QUERY',
  WHOIS_NOT_FOUND: 'ERR_WHOIS_NOT_FOUND',

  // Server errors (5xx)
  UNEXPECTED_SERVER_ERROR: 'ERR_UNEXPECTED_SERVER_ERROR',
  CONFIG_UPDATE_FAILED: 'ERR_CONFIG_UPDATE_FAILED',
  PM2_LOGS_FAILED: 'ERR_PM2_LOGS_FAILED',
  PM2_STATUS_FAILED: 'ERR_PM2_STATUS_FAILED',
};

/**
 * Compact IP representation for memory efficiency
 * - IPv4: convert to integer (saves ~70% memory)
 * - IPv6: abbreviate (saves ~30-70% memory)
 */
const compactIP = (ip) => {
  if (!ip) return 'unknown';
  try {
    return ip.includes(':') ? abbreviateIPv6(ip) : IPv4ToInt(ip);
  } catch (err) {
    return ip; // fallback to original
  }
};

/**
 * Get the count of requests for a specific request type and client IP
 * 
 * @param {Map} ipHistMap - The IP history map
 * @param {number} requestType - The type of request
 * @param {string} clientIP - The client IP address
 * @returns {number} - The count of requests
 */
const getIpHistCount = (ipHistMap, requestType, clientIP) => {
  const typeMap = ipHistMap.get(requestType);
  if (!typeMap) return 0;
  return typeMap.get(compactIP(clientIP)) || 0;
};

/**
 * Increment the request count for a specific request type and client IP
 * 
 * @param {Map} ipHistMap - The IP history map
 * @param {number} requestType - The type of request
 * @param {string} clientIP - The client IP address
 */
const incrementIpHistCount = (ipHistMap, requestType, clientIP) => {
  if (!ipHistMap.has(requestType)) {
    ipHistMap.set(requestType, new Map());
  }
  const typeMap = ipHistMap.get(requestType);
  const key = compactIP(clientIP);
  typeMap.set(key, (typeMap.get(key) || 0) + 1);
};

/**
 * Reverse mapping from request type values to their string names
 * 
 * @param {number} requestType - The numeric request type
 * @returns {string} - The string name of the request type
 */
const getRequestTypeName = (requestType) => {
  const typeNames = {
    [API_REQUEST_TYPE.STANDARD]: 'STANDARD',
    [API_REQUEST_TYPE.STANDARD_CACHED]: 'STANDARD_CACHED',
    [API_REQUEST_TYPE.BULK]: 'BULK',
    [API_REQUEST_TYPE.WHOIS]: 'WHOIS',
    [API_REQUEST_TYPE.DISTANCE]: 'DISTANCE',
    [API_REQUEST_TYPE.ERROR_INVALID_QUERY]: 'ERROR_INVALID_QUERY',
    [API_REQUEST_TYPE.ERROR_UNKNOWN]: 'ERROR_UNKNOWN',
    [API_REQUEST_TYPE.ERROR_INVALID_HTTP_METHOD]: 'ERROR_INVALID_HTTP_METHOD',
    [API_REQUEST_TYPE.ERROR_BULK]: 'ERROR_BULK',
  };
  return typeNames[requestType] || `UNKNOWN_${requestType}`;
};

/**
 * Convert IP history map to object with string request type keys
 * 
 * @param {Map} ipHistMap - The IP history map
 * @param {number} limit - The maximum number of IPs to include per request type
 * @returns {object} - Object with request type strings as keys
 */
const convertIpHistMapToObject = (ipHistMap, limit = 10) => {
  const result = {};

  for (const [requestType, typeMap] of ipHistMap.entries()) {
    const requestTypeName = getRequestTypeName(requestType);
    result[requestTypeName] = {};
    let entries = Array.from(typeMap.entries());

    // Always sort by count (descending) and limit to top entries
    entries.sort((a, b) => b[1] - a[1]);
    if (limit > 0) {
      entries = entries.slice(0, limit);
    }

    // Convert compact IPs back to readable format
    for (const [compactIp, count] of entries) {
      const ipStr = typeof compactIp === 'number' ? IntToIPv4(compactIp) : compactIp;
      result[requestTypeName][ipStr] = count;
    }
  }

  return result;
};

/**
 * Convert current usage object to use string request type keys
 * 
 * @param {object} currentUsage - The current usage object
 * @returns {object} - Object with request type strings as keys
 */
const convertCurrentUsageToStringKeys = (currentUsage) => {
  const result = {};

  for (const [apiKey, usageMap] of Object.entries(currentUsage)) {
    result[apiKey] = {};
    for (const [requestType, count] of Object.entries(usageMap)) {
      const requestTypeName = getRequestTypeName(parseInt(requestType, 10));
      result[apiKey][requestTypeName] = count;
    }
  }

  return result;
};

/**
 * Log API errors to file
 * 
 * @param {string|object} msg - The error message to log
 */
async function apiErrorLog(msg) {
  const ts = (new Date()).toLocaleString();
  const stringified = typeof msg === 'object' ? JSON.stringify(msg, null, 2) : msg;
  const logMessage = `[${process.pid}][${ts}] - API_ERROR - ${stringified}\n`;
  const logFilePath = path.join(__dirname, '../log/ipapi_api_errors.err');

  try {
    await fs.promises.appendFile(logFilePath, logMessage);
  } catch (err) {
    log(`Failed to append to log file: ${err}`, 'ERROR');
  }
}

/**
 * Get the configuration file path
 * 
 * @returns {string} - The path to the configuration file
 */
function getConfigPath() {
  let configPath = null;

  if (process.argv.length >= 3) {
    const configFromCommandLineArg = process.argv[2];
    if (fs.existsSync(configFromCommandLineArg)) {
      configPath = configFromCommandLineArg;
    }
  }

  if (!configPath) {
    const configAttempts = [
      'config.json',
      './../config.json',
      './../config/config.json',
    ];
    for (const fileName of configAttempts) {
      const cfgPath = path.join(__dirname, fileName);
      if (fs.existsSync(cfgPath)) {
        configPath = cfgPath;
        break;
      }
    }
  }

  if (!configPath || !fs.existsSync(configPath)) {
    log(`Invalid configuration file: ${configPath}`, 'ERROR');
    process.exit(1);
  }

  log(`Config used: ${configPath}`);

  return configPath;
}

let cachedServerIp = null;

/**
 * Get the currently used remote address (public IP)
 * 
 * @returns {string|null} - The server's public IP address
 */
const getServerIpAddress = () => {
  if (cachedServerIp) {
    return cachedServerIp;
  }
  try {
    cachedServerIp = executeCommandSync('curl -s https://api.ipapi.is/ip').toString().trim();
    if (typeof cachedServerIp === 'string' && cachedServerIp.includes('Error')) {
      cachedServerIp = null;
    }
    return cachedServerIp;
  } catch (err) {
    log(`Failed to get server IP address: ${err.message}`, 'ERROR');
    return null;
  }
};

/**
 * Get OS and system information
 * 
 * @returns {object} - Object containing OS and system info
 */
const getOsInfo = () => {
  const uptimeInDays = round(os.uptime() / 60 / 60 / 24, 2);
  return {
    platform: process.platform,
    userInfo: os.userInfo(),
    arch: process.arch,
    totalMem: os.totalmem() / (1024 * 1024),
    freeMem: os.freemem() / (1024 * 1024),
    numCPUs: os.cpus().length,
    uptime: `${uptimeInDays} days`,
    memory: memUsage(),
  };
};

/**
 * Get the client IP address from the request.
 * 
 * @param {object} req - The Express request object.
 * @param {boolean} forceHeader - Whether to prefer the x-real-ip header.
 * @returns {string|null} - The client IP address.
 */
function getIp(req, forceHeader = true) {
  const ipForwardHeader = 'x-real-ip';
  const socket = req.socket || req.connection;
  let clientIP = socket ? socket.remoteAddress : null;

  if (forceHeader && req.headers[ipForwardHeader] !== undefined) {
    clientIP = req.headers[ipForwardHeader];
  }

  return clientIP;
}

/**
 * Check if an API response is an error response.
 * 
 * Standardized way to check for errors across all API functions:
 * - fastLookup() returns objects with 'error' property
 * - bulkLookup() returns objects with 'error' property
 * - getDistance() returns objects with 'error' property
 * 
 * A valid error response must have both 'error' message and 'error_code' properties.
 * 
 * @param {any} response - The API response to check
 * @returns {boolean} - True if the response contains an error, false otherwise
 */
function isErrorResponse(response) {
  return response && typeof response === 'object' && 'error' in response && 'error_code' in response;
}

module.exports = {
  API_REQUEST_TYPE,
  USER_API_STATUS,
  API_ERROR_CODE,
  compactIP,
  getIpHistCount,
  incrementIpHistCount,
  getRequestTypeName,
  convertIpHistMapToObject,
  convertCurrentUsageToStringKeys,
  apiErrorLog,
  getConfigPath,
  getServerIpAddress,
  getOsInfo,
  getIp,
  isErrorResponse,
};

