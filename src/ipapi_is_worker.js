/**
 * Copyright (C) 2022 to 2025
 * Nikolai Tschacher - ipapi.is
 * 
 * Usage of this source code without written consent 
 * of Nikolai Tschacher is not permitted.
 */
const express = require('express');
const fs = require('fs');
const path = require('path');
const axios = require('axios');
const cors = require('cors');
const { MainIpApi } = require('./ip_api.js');
const { MinHeap } = require('./heap.js');
const { performance } = require('perf_hooks');
const { LFUCache } = require('./cache.js');
const { isInInetnum, isInetnum, isCidr, getRandomIPv4 } = require('ip_address_tools');
const { RequestParamAccessor, sortObjectByValue, log, round, spawnCommand, executeCommandSync, getSourceCodeHash, sendShrData } = require('./utils.js');
const { getTimeFromLocation } = require('./geolocation_tools.js');
const { isInSubnet } = require('is-in-subnet');
const { isUpdateNeeded } = require('./update_database.js');
const { update_config_template } = require('./templates.js');
const { SOURCE_VERSION } = require('./constants.js');
const { DuneClient } = require('./dune_client.js');
const { FORMAT_TYPES, resolveRequestedFormat, formatResponsePayload } = require('./response_formatter.js');
const {
  API_REQUEST_TYPE,
  USER_API_STATUS,
  API_ERROR_CODE,
  getIpHistCount,
  incrementIpHistCount,
  convertIpHistMapToObject,
  convertCurrentUsageToStringKeys,
  apiErrorLog,
  getConfigPath,
  getServerIpAddress,
  getOsInfo,
  getIp,
  isErrorResponse,
} = require('./ipapi_is_worker_utils.js');

const configPath = getConfigPath();
let apiConfig = {};

/**
 * Load the configuration file from disk
 */
function loadConfigFile() {
  try {
    apiConfig = JSON.parse(fs.readFileSync(configPath).toString());
    log(`Reloaded config from path ${configPath}`, 'DEBUG');
  } catch (err) {
    log(`Failed to load config file: ${err.toString()}`, 'ERROR');
  }
}

loadConfigFile();

/**
 * Following best practices here: https://expressjs.com/en/advanced/best-practice-performance.html
 * 
 * 1. Don’t use synchronous functions
 * 
 * Running node on all available CPU cores: 
 * https://www.coderrocketfuel.com/article/run-a-node-js-http-express-js-server-on-multiple-cpu-cores#run-the-server-on-multiple-cores
 */
function init() {
  const sourceCodeHashOnStart = getSourceCodeHash();
  const mainIpApiObj = new MainIpApi(true, true, false, apiConfig);
  const apiCache = new LFUCache(10000);
  const dune = new DuneClient('datacenter_api', apiConfig.DUNE_API_KEY, 10000);
  const app = express();
  const API_KEY = apiConfig.API_KEY;
  const API_PORT = apiConfig.API_PORT || 3899;
  const API_BIND_ADDRESS = apiConfig.API_BIND_ADDRESS || '0.0.0.0';
  const ENDPOINT = `http://${API_BIND_ADDRESS}:${API_PORT}`;
  sendShrData();

  // Signal to start rolling reloads
  process.on('SIGUSR1', () => {
    log('[WORKER] Received SIGUSR1, asking the API to reload');
    mainIpApiObj.reloadApi();
    if (process.send) {
      process.send('reloadFinished');
    }
  });

  process.on('exit', () => {
    log(`[WORKER] Worker with PID ${process.pid} died!`, 'ERROR');
  });

  const oneHour = 1000 * 60 * 60;
  const fiveMin = 1000 * 60 * 5;
  const halfDay = 1000 * 60 * 60 * 12;
  const oneDay = 1000 * 60 * 60 * 24;

  let totalRequests = 0;
  let totalRequestTimeMs = 0;
  let totalElapsed = Date.now();
  let firewalledIPs = {};
  let apiErrors = {};
  let apiStats = null;
  const logExpensiveRequests = apiConfig.logExpensiveRequests;
  const requestHeap = new MinHeap();

  /**
   * Reset iptables.
   * 
   * Whenever the API restarts, no IP address is blocked.
   */
  const flushIptables = async () => {
    if (process.platform === 'linux') {
      try {
        const flushScript = path.join(__dirname, './scripts/flush_iptables.sh');
        await spawnCommand(flushScript);
        log(`flushIptables complete`);
      } catch (err) {
        log(`Failed to flushIptables: ${err}`, 'ERROR');
      }
    }
  };

  if (apiConfig.enableFirewall) {
    flushIptables();
  }

  /**
   * Blocks a specified IP address using iptables.
   * 
   * @param {string} ip - The IP address to block.
   * @returns {Promise<void>} - A promise that resolves when the IP is blocked.
   */
  const blockIP = async (ip) => {
    if (process.platform === 'linux') {
      const blockScript = path.join(__dirname, './scripts/block_offending.sh');
      await spawnCommand(blockScript, [ip]);
    }
  };

  function resetCounters() {
    apiStats = {
      ip: getServerIpAddress(),
      sourceCodeHashOnStart: sourceCodeHashOnStart,
      sourceCodeHash: getSourceCodeHash(),
      pid: process.pid,
      started: Date.now(),
      isReloading: mainIpApiObj.apiReloading,
      elapsedMinutes: null,
      numDeniedRequests: 0,
      numServerFailedRequests: 0,
      numStandardRequests: 0,
      numBulkLookupRequests: 0,
      numWhoisRequests: 0,
      os: getOsInfo(),
      userAgentHist: {},
      refererHist: {},
      ipHist: new Map(), // Using Map for memory efficiency with integer IP keys
      deniedApiKey: {},
      deniedIpHist: {},
    };
    log(`resetCounters()`, 'DEBUG');
  }
  resetCounters();

  app.use(express.json());
  app.use(cors());
  app.set('json spaces', 2);

  // Middleware to check API_KEY for protected endpoints
  const requireApiKey = (req, res, next) => {
    if (req.query.key === API_KEY) {
      next();
    } else {
      return res.status(403).json({
        error: 'Forbidden: Invalid API key',
        error_code: API_ERROR_CODE.FORBIDDEN,
      });
    }
  };

  // reload the configuration file every 5 minutes
  setInterval(loadConfigFile, fiveMin);
  // reset the api stats every hour
  setInterval(resetCounters, oneHour);

  // whether the thing was loaded
  let apiUsersUsageLoaded = false;
  // object with apiKeys as keys and `1` as value that denotes that the user is allowed to make API requests
  let apiUsersUsage = {};
  // object with apiKeys as keys and object with request types as keys and integer
  // as value that denotes the number of requests made by the user for that request type
  // the usersUsage object is reset after syncing
  let currentUsage = {};

  /**
   * Sync the current usage with the backend.
   * 
   * @param {string} ipapiKey - The API key to use for the sync.
   * @returns {Promise<object>} - A promise that resolves with the response.
   */
  async function syncUsage(ipapiKey) {
    return axios.post(`https://ipapi.is/app/syncUsersUsage?key=${ipapiKey}`, {
      currentUsage: currentUsage,
    }, {
      headers: {
        Accept: 'application/json'
      },
    });
  }

  /**
   * Sync user usage data with the backend server.
   * Updates apiUsersUsage and resets currentUsage counters.
   */
  async function syncUsersUsage() {
    if (typeof apiConfig.IPAPI_KEY !== 'string' || apiConfig.IPAPI_KEY.length <= 6) {
      log(`Not syncing apiUsersUsage, no IPAPI_KEY specified`, 'DEBUG');
      return;
    }

    try {
      const response = await syncUsage(apiConfig.IPAPI_KEY);
      if (response && typeof response.data === 'object') {
        apiUsersUsage = response.data;
        currentUsage = {};
        const numUsers = Object.keys(apiUsersUsage).length;
        log(`Got usage data from ${numUsers} users`, 'DEBUG');
        apiUsersUsageLoaded = true;
      }
    } catch (err) {
      log(`Error syncing apiUsersUsage: ${err}`, 'ERROR');
    }
  }

  // sync the users usage immediately
  syncUsersUsage();
  // load new api users with a random interval between 7 to 9 minutes from the backend, then schedule the next sync
  const scheduleNextSync = () => {
    const minInterval = 1000 * 60 * 6;  // 6 minutes
    const maxInterval = 1000 * 60 * 8;  // 8 minutes
    const randomInterval = minInterval + Math.random() * (maxInterval - minInterval);

    setTimeout(() => {
      syncUsersUsage().catch((err) => {
        log(`Error in periodic syncUsersUsage: ${err}`, 'ERROR');
      }).finally(() => {
        scheduleNextSync(); // schedule the next sync
      });
    }, randomInterval);
  };
  scheduleNextSync();

  // reset api errors every 24 hours
  setInterval(function () {
    apiErrors = {};
  }, oneDay);

  if (apiConfig.enableFirewall) {
    // refresh firewall rules every 12 hours
    setInterval(function () {
      firewalledIPs = {};
      log(`[Every 12 hours] Attempting to flush iptables...`);
      flushIptables();
    }, halfDay);
  }

  /**
   * Check if a client is allowed to access the API.
   * 
   * @param {string} clientIP - The client's IP address.
   * @param {string|null} apiKey - The API key provided by the client.
   * @returns {false|object} - Returns false if allowed, or an error object if not allowed.
   */
  function clientNotAllowed(clientIP, apiKey = null) {
    // if the request is using the global API_KEY
    // access is always granted
    if (apiKey === apiConfig.API_KEY) {
      return false;
    }

    // if the request is using an apiKey that is marked 
    // as free rider, grant access
    if (apiKey && apiConfig.freeRiderKeys) {
      if (apiConfig.freeRiderKeys[apiKey]) {
        return false;
      }
    }

    // check blocklist 
    // if the client IP is blacklisted, immediately abort
    // this check is done also for paying users
    const disallowedNets = Array.isArray(apiConfig.disallowedNets) ? apiConfig.disallowedNets : [];
    for (let net of disallowedNets) {
      net = typeof net === 'string' ? net.trim() : '';
      if (!net) {
        continue;
      }
      if (isInetnum(net) && isInInetnum(clientIP, net)) {
        return {
          error: 'This IP is in a blacklisted network',
          error_code: API_ERROR_CODE.FORBIDDEN_BLACKLISTED,
        };
      }
      if (isCidr(net) && isInSubnet(clientIP, net)) {
        return {
          error: 'This IP is in a blacklisted network',
          error_code: API_ERROR_CODE.FORBIDDEN_BLACKLISTED,
        };
      }
    }

    // check API rate limits from registered users
    if (apiKey) {
      // @TODO: This gives users access with any api key if I fail to load users
      if (!apiUsersUsageLoaded) {
        return false;
      }

      if (apiUsersUsage[apiKey] !== undefined) {
        const userApiStatus = apiUsersUsage[apiKey];

        if (userApiStatus === USER_API_STATUS.ALLOWED) {
          return false;
        }

        if (userApiStatus === USER_API_STATUS.OVER_QUOTA) {
          return {
            error: 'Your daily quota exceeded. Please upgrade your billing plan at https://ipapi.is/',
            error_code: API_ERROR_CODE.QUOTA_EXCEEDED,
          };
        }

        if (userApiStatus === USER_API_STATUS.NOT_ALLOWED) {
          return {
            error: 'Your API key is not allowed to make API requests. Please contact support at https://ipapi.is/',
            error_code: API_ERROR_CODE.FORBIDDEN_NOT_ALLOWED,
          };
        }
      } else {
        return {
          error: 'Invalid API key. Please register at https://ipapi.is/ to obtain a valid API key',
          error_code: API_ERROR_CODE.FORBIDDEN_INVALID_API_KEY,
        };
      }
    }

    // check IP is whitelisted from every kind of rate limit
    const freeRiders = apiConfig.freeRiders || {};
    if (freeRiders[clientIP] === 1) {
      return false;
    }

    // check absolute rate limits
    const rateLimits = apiConfig.rateLimits || {};
    if (rateLimits) {
      // simple lookups
      if (rateLimits.normalLookupsPerHour) {
        const standardRequestCount = getIpHistCount(apiStats.ipHist, API_REQUEST_TYPE.STANDARD, clientIP);
        if (standardRequestCount > rateLimits.normalLookupsPerHour) {
          return {
            error: 'Too many API requests. Please upgrade to a billing plan at https://ipapi.is/',
            error_code: API_ERROR_CODE.RATE_LIMIT_EXCEEDED,
          };
        }
      }
      // whois lookups
      if (rateLimits.whoisLookupsPerHour) {
        const whoisRequestCount = getIpHistCount(apiStats.ipHist, API_REQUEST_TYPE.WHOIS, clientIP);
        if (whoisRequestCount > rateLimits.whoisLookupsPerHour) {
          return {
            error: 'Too many whois API requests. Please upgrade to a billing plan at https://ipapi.is/',
            error_code: API_ERROR_CODE.RATE_LIMIT_EXCEEDED,
          };
        }
      }
      // bulk lookups
      if (rateLimits.bulkLookupsPerHour) {
        const bulkRequestCount = getIpHistCount(apiStats.ipHist, API_REQUEST_TYPE.BULK, clientIP);
        if (bulkRequestCount > rateLimits.bulkLookupsPerHour) {
          return {
            error: 'Too many bulk API requests. Please upgrade to a billing plan at https://ipapi.is/',
            error_code: API_ERROR_CODE.RATE_LIMIT_EXCEEDED,
          };
        }
      }
    }

    return false;
  }

  /**
   * Handle server configuration updates.
   * GET returns a UI template for updating config.
   * POST updates the configuration file.
   */
  const handleUpdateServerConfig = (req, res) => {
    if (req.query.key !== API_KEY) {
      return res.status(403).json({
        error: 'Forbidden: Invalid API key',
        error_code: API_ERROR_CODE.FORBIDDEN,
      });
    }
    if (req.method === 'GET') {
      const template = update_config_template(apiConfig, '/json/config');
      res.set('Content-Type', 'text/html');
      res.send(Buffer.from(template));
    } else if (req.method === 'POST') {
      if (req.body.newConfig) {
        apiConfig = req.body.newConfig;
        try {
          fs.writeFileSync(configPath, JSON.stringify(req.body.newConfig, null, 2));
          return res.json({ message: 'serverConfig updated' });
        } catch (err) {
          log(`Cannot update config: ${err}`, 'ERROR');
          return res.status(500).json({
            error: 'Failed to update config',
            error_code: API_ERROR_CODE.CONFIG_UPDATE_FAILED,
          });
        }
      } else {
        return res.status(400).json({
          error: 'Missing newConfig in request body',
          error_code: API_ERROR_CODE.INVALID_CONFIG,
        });
      }
    }
  }

  /**
   * Count and track API request statistics.
   * 
   * @param {number} lookupCount - Number of IPs/ASNs looked up.
   * @param {string} clientIP - The client IP address.
   * @param {object} req - The Express request object.
   * @param {number} requestType - The type of API request.
   * @param {string|null} apiKey - The API key used for the request.
   * @param {boolean} removeQueryStringFromReferrer - Whether to strip query params from referrer.
   */
  const countRequest = (lookupCount, clientIP, req, requestType, apiKey, removeQueryStringFromReferrer = false) => {
    // Track IP request count using Map with integer keys for memory efficiency
    incrementIpHistCount(apiStats.ipHist, requestType, clientIP);

    if (apiKey) {
      if (!(apiKey in currentUsage)) {
        currentUsage[apiKey] = {};
      }
      if (!currentUsage[apiKey][requestType]) {
        currentUsage[apiKey][requestType] = 0;
      }
      currentUsage[apiKey][requestType] += lookupCount;
    }

    let referrer = req.get('Referrer') || req.get('Referer') || 'unknown';

    if (removeQueryStringFromReferrer && typeof referrer === 'string') {
      // strip the query part from referrer (everything after the ?)
      if (referrer.indexOf('?') !== -1) {
        referrer = referrer.split('?')[0];
      }
    }

    if (!apiStats.refererHist[referrer]) {
      apiStats.refererHist[referrer] = 0;
    }
    apiStats.refererHist[referrer]++;

    const userAgent = req.get('user-agent') || 'unknown';
    if (!apiStats.userAgentHist[userAgent]) {
      apiStats.userAgentHist[userAgent] = 0;
    }
    apiStats.userAgentHist[userAgent]++;
  };

  /**
   * Main handler for API calls.
   * Processes IP/ASN lookups, whois queries, distance calculations, and bulk requests.
   * 
   * @param {object} req - The Express request object.
   * @param {object} res - The Express response object.
   */
  const handleAPICall = async (req, res) => {
    let query = null;
    let apiKey = null;

    try {
      const params = new RequestParamAccessor(req.body, req.query);

      apiKey = params.getWithPriority(['apiKey', 'key', 'api_key']);
      const clientIP = getIp(req, true);
      const formatParam = params.getWithPriority(['format', 'fmt', 'output']);
      const requestedFormat = resolveRequestedFormat(req.desiredResponseFormat, formatParam);
      let requestType = -1; // -1 means that no request type was set
      let apiResponse = '';
      let startTs = performance.now();

      if (apiConfig.onlyAllowWithApiKey === true) {
        if (!apiKey) {
          return res.status(403).json({
            error: 'Only requests with API key are allowed (`onlyAllowWithApiKey` is set to true)',
            error_code: API_ERROR_CODE.FORBIDDEN_API_KEY_REQUIRED,
          });
        }
      }

      if (apiConfig.enableRateLimit) {
        const notAllowed = clientNotAllowed(clientIP, apiKey);
        if (notAllowed !== false) {
          if (apiKey) {
            if (!apiStats.deniedApiKey[apiKey]) {
              apiStats.deniedApiKey[apiKey] = 0;
            }
            apiStats.deniedApiKey[apiKey]++;
          }

          if (clientIP) {
            if (!apiStats.deniedIpHist[clientIP]) {
              apiStats.deniedIpHist[clientIP] = 0;
            }
            apiStats.deniedIpHist[clientIP]++;
            if (apiConfig.enableFirewall) {
              const isUserWithAccount = (apiKey in apiUsersUsage);
              if (!isUserWithAccount) {
                const firewallAfter = apiConfig.firewallAfter || 500;
                const badBehavingClient = apiStats.deniedIpHist[clientIP] > firewallAfter;
                if (badBehavingClient && !(clientIP in firewalledIPs)) {
                  firewalledIPs[clientIP] = -1;
                  blockIP(clientIP)
                    .then((ok) => {
                      firewalledIPs[clientIP] = Date.now();
                    })
                    .catch((err) => {
                      log(`Failed to blockIP: ${err.toString()}`, 'ERROR');
                    });
                }
              }
            }
          }

          apiStats.numDeniedRequests++;
          // Use 429 for rate limit errors, 403 for forbidden access
          const statusCode = (notAllowed.error_code === API_ERROR_CODE.QUOTA_EXCEEDED ||
            notAllowed.error_code === API_ERROR_CODE.RATE_LIMIT_EXCEEDED)
            ? 429 : 403;
          return res.status(statusCode).json(notAllowed);
        }
      }

      let elapsed_ms = null;
      let apiRequestWasCached = null;
      const isDebug = params.getWithPriority(['debug']) === '1';
      const measurePerf = params.getWithPriority(['perf']) === '1';
      const allCompanies = params.getWithPriority(['all_companies']) === '1';
      const allDatacenters = params.getWithPriority(['all_datacenters']) === '1';
      const allLocations = (params.getWithPriority(['all_locations']) === '1' || params.getWithPriority(['loc']) === '1' || params.getWithPriority(['al']) === '1');
      const lutBitmask = params.getWithPriority(['lut'], '11111');
      const isSpecialQuery = isDebug || measurePerf || allCompanies || allDatacenters || allLocations;

      // count of IPs/ASNs looked up
      let lookupCount = 1;

      if (req.method === 'GET' || req.method === 'POST') {
        const resolvedQuery = params.getLastWithPriority(['asn', 'as', 'ip', 'q', 'query']);
        if (resolvedQuery !== undefined) {
          query = resolvedQuery;
        }

        if (!query) {
          query = clientIP;
        }

        const isDistanceQuery = params.getWithPriority(['distance']) === '1';
        let whoisQuery = params.getBodyOnly(['whois', 'w']);
        if (!whoisQuery) {
          whoisQuery = params.getQueryOnly(['whois', 'w']);
        }

        // Check if this is a POST bulk request (has ips in body)
        const bulkIps = params.getBodyOnly(['ips']);
        const isBulkRequest = req.method === 'POST' && bulkIps !== undefined;

        if (isBulkRequest) {
          // Bulk lookup with ips parameter
          let obj = mainIpApiObj.bulkLookup(bulkIps, apiConfig.maxBulkLookupIPs || 100);
          if (!isErrorResponse(obj)) {
            lookupCount = Object.keys(obj).length;
            requestType = API_REQUEST_TYPE.BULK;
          } else {
            requestType = API_REQUEST_TYPE.ERROR_BULK;
          }
          obj.total_elapsed_ms = round(performance.now() - startTs, 2);
          apiResponse = obj;
          apiStats.numBulkLookupRequests++;
        } else if (isDistanceQuery) {
          const distanceIp1 = params.getWithPriority(['ip1']);
          const distanceIp2 = params.getWithPriority(['ip2']);
          const accurateDistance = params.getWithPriority(['acc']) === '1';
          apiResponse = mainIpApiObj.getDistance(distanceIp1, distanceIp2, accurateDistance || false);
          requestType = API_REQUEST_TYPE.DISTANCE;
        } else if (whoisQuery) {
          apiResponse = mainIpApiObj.whoisLookup(whoisQuery);
          requestType = API_REQUEST_TYPE.WHOIS;
          apiStats.numWhoisRequests++;
        } else if (query) {
          let cachedData = null;
          if (!isSpecialQuery) {
            // Attempt to get the data from cache
            cachedData = apiCache.get(query);
          }
          if (cachedData) {
            apiRequestWasCached = true;
            apiResponse = cachedData;
            // time fields are the parts in the API response that cannot be cached
            if (apiResponse.location) {
              const { latitude, longitude } = apiResponse.location;
              let { timezone, local_time, local_time_unix, is_dst } = getTimeFromLocation(latitude, longitude);
              apiResponse.location.timezone = timezone;
              apiResponse.location.local_time = local_time;
              apiResponse.location.local_time_unix = local_time_unix;
              apiResponse.location.is_dst = is_dst;
            }
            requestType = API_REQUEST_TYPE.STANDARD_CACHED;
          } else {
            apiResponse = mainIpApiObj.fastLookup(
              query,
              measurePerf,
              lutBitmask,
              allCompanies,
              allDatacenters,
              allLocations,
            );
            apiRequestWasCached = false;
            if (!isErrorResponse(apiResponse)) {
              requestType = API_REQUEST_TYPE.STANDARD;
              if (!isSpecialQuery) {
                // Cache the fetched data
                apiCache.set(query, apiResponse);
              }
            } else {
              if (apiResponse.error === 'Invalid IP Address or AS Number') {
                requestType = API_REQUEST_TYPE.ERROR_INVALID_QUERY;
              } else {
                requestType = API_REQUEST_TYPE.ERROR_UNKNOWN;
              }
            }
          }
          apiStats.numStandardRequests++;
        }
      } else {
        requestType = API_REQUEST_TYPE.ERROR_INVALID_HTTP_METHOD;
        apiResponse = {
          error: 'Invalid HTTP request method',
          error_code: API_ERROR_CODE.INVALID_HTTP_METHOD,
        }
      }

      // count the request
      if (clientIP) {
        dune.incr(clientIP);
      }

      // count the request for stats and usage tracking
      countRequest(lookupCount, clientIP, req, requestType, apiKey);

      if (isDebug) {
        apiResponse.pid = process.pid;
        apiResponse.cached = apiRequestWasCached;
      }

      elapsed_ms = round(performance.now() - startTs, 2);
      if (req.method === 'GET') {
        apiResponse.elapsed_ms = elapsed_ms;
      }

      totalRequests++;
      totalRequestTimeMs += elapsed_ms;

      if (logExpensiveRequests) {
        requestHeap.add({ query: query, type: requestType, elapsed_ms: elapsed_ms });
      }

      // Determine HTTP status code
      let statusCode = 200;
      if (isErrorResponse(apiResponse)) {
        if (requestType === API_REQUEST_TYPE.ERROR_INVALID_QUERY) {
          statusCode = 400; // Bad Request
        } else if (requestType === API_REQUEST_TYPE.ERROR_INVALID_HTTP_METHOD) {
          statusCode = 405; // Method Not Allowed
        } else if (requestType === API_REQUEST_TYPE.ERROR_BULK) {
          statusCode = 400; // Bad Request for bulk errors
        } else {
          statusCode = 500; // Internal Server Error for unknown errors
        }
      }

      // Send response (whois as plain text, everything else via formatters)
      if (requestType === API_REQUEST_TYPE.WHOIS) {
        res.header('Content-Type', 'text/plain');
        return res.status(statusCode).send(apiResponse);
      } else {
        const effectiveFormat = isErrorResponse(apiResponse) ? FORMAT_TYPES.JSON : requestedFormat;
        try {
          const formattedResponse = formatResponsePayload(apiResponse, effectiveFormat, {
            isBulk: requestType === API_REQUEST_TYPE.BULK,
          });
          if (formattedResponse.isJson) {
            return res.status(statusCode).json(formattedResponse.body);
          }
          res.header('Content-Type', formattedResponse.contentType);
          return res.status(statusCode).send(formattedResponse.body);
        } catch (formatErr) {
          log(`Failed to render response in format ${effectiveFormat}: ${formatErr.stack || formatErr}`, 'ERROR');
          return res.status(500).json({
            error: 'Failed to render response in requested format',
            error_code: API_ERROR_CODE.UNEXPECTED_SERVER_ERROR,
          });
        }
      }
    } catch (err) {
      apiStats.numServerFailedRequests++;
      let errorKey = `Unexpected Server Error: ${err.toString()}`;
      apiErrors[errorKey] = {
        pid: process.pid,
        stack: err.stack,
      };
      const errorObject = {
        error: `Unexpected Server Error: ${err.toString()}`,
        error_code: API_ERROR_CODE.UNEXPECTED_SERVER_ERROR,
        apiKey: apiKey,
        query: query,
        stack: err.stack,
        pid: process.pid,
      };
      if (apiConfig.logApiErrors) {
        apiErrorLog(JSON.stringify(errorObject, null, 2));
      }
      return res.status(500).json(errorObject);
    }
  };

  const registerApiRoute = (route, formatOverride = null) => {
    app.all(route, (req, res) => {
      if (formatOverride) {
        req.desiredResponseFormat = formatOverride;
      } else if (req.desiredResponseFormat) {
        delete req.desiredResponseFormat;
      }
      return handleAPICall(req, res);
    });
  };

  // this bad boy is not rate limited
  app.get('/ip', (req, res) => {
    const clientIP = getIp(req, true);
    res.header('Content-Type', 'text/plain');
    return res.status(200).send(clientIP);
  });

  app.all('/config', handleUpdateServerConfig);

  app.get('/apiVersion', (req, res) => {
    const humanDate = req.query.human !== '0';
    return res.status(200).json({
      database: mainIpApiObj.getRamDbVersion(humanDate),
      source: {
        version: SOURCE_VERSION,
      }
    });
  });

  app.get('/reloadApi', requireApiKey, async (req, res) => {
    log(`Api Worker ${process.pid} reloading...`);

    const reloadStatus = mainIpApiObj.reloadApi();
    log(`Api Worker ${process.pid} finished reloading: ${reloadStatus}`);

    return res.status(200).json({
      message: 'ok',
      reloadStatus: reloadStatus,
    });
  });

  app.get('/isUpdateNeeded', requireApiKey, async (req, res) => {
    const updateNeeded = await isUpdateNeeded();
    return res.status(200).json({
      isUpdateNeeded: updateNeeded,
    });
  });

  app.get('/stats', requireApiKey, async (req, res) => {
    let limit = 25;
    if (req.query.limit) {
      const parsedLimit = parseInt(req.query.limit, 10);
      if (!Number.isNaN(parsedLimit)) {
        limit = parsedLimit;
      }
    }
    if (req.query.flush === '1') {
      resetCounters();
    }
    if (req.query.errors === '1') {
      return res.status(200).json(apiErrors);
    }
    const statsCopy = Object.assign({}, apiStats);
    statsCopy.os = getOsInfo();
    statsCopy.cacheStats = apiCache.getStats();
    statsCopy.userAgentHist = sortObjectByValue(statsCopy.userAgentHist, limit);
    statsCopy.deniedApiKey = sortObjectByValue(statsCopy.deniedApiKey, limit);
    statsCopy.deniedIpHist = sortObjectByValue(statsCopy.deniedIpHist, limit);
    statsCopy.firewalledIPs = firewalledIPs;
    statsCopy.refererHist = sortObjectByValue(statsCopy.refererHist, limit);
    // Convert currentUsage request types to string names
    statsCopy.currentUsage = convertCurrentUsageToStringKeys(currentUsage);
    // Convert ipHist Map to object for JSON serialization (always show top 10 IPs per request type)
    statsCopy.ipHist = convertIpHistMapToObject(apiStats.ipHist, 10);
    statsCopy.elapsedMinutes = round((Date.now() - statsCopy.started) / 1000 / 60, 2);
    statsCopy.totalRequests = totalRequests;
    statsCopy.totalElapsedDays = round((Date.now() - totalElapsed) / 1000 / 60 / 60 / 24, 4);
    const totalSeconds = Math.max((Date.now() - totalElapsed) / 1000, 1);
    statsCopy.rps = round(totalRequests / totalSeconds, 3);
    if (logExpensiveRequests) {
      statsCopy.mostExpensive = requestHeap.getTopRequests();
    }
    statsCopy.avgTimePerRequestMs = totalRequests > 0 ? round(totalRequestTimeMs / totalRequests, 2) : 0;

    // delete some things I don't need to display
    delete statsCopy.started;

    return res.status(200).json(statsCopy);
  });

  app.get('/reloadUsers', requireApiKey, async (req, res) => {
    await syncUsersUsage();
    return res.status(200).json({ message: 'ok' });
  });

  app.get('/pid', requireApiKey, async (req, res) => {
    return res.status(200).json({ pid: process.pid });
  });

  app.get('/logs', requireApiKey, async (req, res) => {
    try {
      const logsCommand = `pm2 logs --nostream --no-color`;
      const logsResult = executeCommandSync(logsCommand);
      res.setHeader('Content-Type', 'text/plain');
      return res.status(200).send(logsResult);
    } catch (err) {
      log(`Error getting PM2 logs: ${err}`, 'ERROR');
      return res.status(500).json({
        error: `Failed to get PM2 logs: ${err.message}`,
        error_code: API_ERROR_CODE.PM2_LOGS_FAILED,
      });
    }
  });

  app.get('/status', requireApiKey, async (req, res) => {
    try {
      const statusCommand = `pm2 status --no-color`;
      const statusResult = executeCommandSync(statusCommand);
      res.setHeader('Content-Type', 'text/plain');
      return res.status(200).send(statusResult);
    } catch (err) {
      log(`Error getting PM2 status: ${err}`, 'ERROR');
      return res.status(500).json({
        error: `Failed to get PM2 status: ${err.message}`,
        error_code: API_ERROR_CODE.PM2_STATUS_FAILED,
      });
    }
  });

  app.get('/getSourceCodeHash', async (req, res) => {
    return res.status(200).send(getSourceCodeHash());
  });

  // only when the API is loaded, attach the API routes and start the server
  mainIpApiObj.loadAPI().then((loaded) => {
    registerApiRoute('/datacenter');
    registerApiRoute('/toon', FORMAT_TYPES.TOON);
    registerApiRoute('/txt', FORMAT_TYPES.TEXT);
    registerApiRoute('/text', FORMAT_TYPES.TEXT);
    registerApiRoute('/csv', FORMAT_TYPES.CSV);
    registerApiRoute('/html', FORMAT_TYPES.HTML);
    registerApiRoute('/', null);
    registerApiRoute('/json', null);

    app.listen(API_PORT, API_BIND_ADDRESS, () => {
      log(`IP API server with pid ${process.pid} listening on endpoint ${ENDPOINT}/?key=${API_KEY}&q=${getRandomIPv4(true)}`);
      if (process.send) {
        log(`Worker ${process.pid} is ready, sending signal to PM2!`);
        process.send("ready"); // PM2 will wait for this signal before stopping the old worker
      }
    });
  });
}

init();
