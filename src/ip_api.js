/**
 * Copyright (C) 2022 to 2025
 * Nikolai Tschacher - ipapi.is
 * 
 * Usage of this source code without written consent 
 * of Nikolai Tschacher is not permitted.
 */
const fs = require('fs');
const { performance } = require("perf_hooks");
const { isSpecial } = require('is-in-subnet');
const { isIP, isASN, abbreviateIPv6 } = require('ip_address_tools');
const { IPtoASN } = require('./ip_to_asn');
const { IPtoLocation } = require('./geolocation');
const { round, load, getDistanceFromLatLonInKm } = require('./utils');
const { FastLut } = require('./fast_lut');
const { IPv4 } = require("ip-num");
const { IPtoDatacenter } = require('./datacenter');
const { IPtoCompany } = require('./company');
const { IPtoBlacklist } = require('./blacklist');
const { IPtoMobile } = require('./mobile');
const { IPtoClean, CLEAN_ALL } = require('./ip_to_clean');
const { CrawlerAndBots } = require('./crawlers_and_bots');
const { IPtoSatellite } = require('./ip_to_satellite');
const { IPtoWhois } = require('./whois_lookup');
const { log, delta, loadText } = require('./utils');
const { APIEndpoint } = require('./constants');
const { performEnvironmentChecks } = require('./environment_check');
const { API_ERROR_CODE } = require('./ipapi_is_worker_utils');

class MainIpApi {
  constructor(enableASN = true, enableGeolocation = true, preventLutLoading = false, apiConfig = {}) {
    this.loadedLuts = {};
    this.enableASN = enableASN;
    this.enableGeolocation = enableGeolocation;
    this.verbose = true;
    this.apiLoaded = false;
    this.preventLutLoading = preventLutLoading;
    this.apiConfig = apiConfig;
    this.customLists = apiConfig.customLists || [];
    this.companyLutLoaded = false;
    this.apiReloading = false;
    this.ramDbVersion = null;
  }

  reloadApi() {
    if (!this.apiReloading) {
      this.apiReloading = true;
      this.apiLoaded = false;
      for (const lutName in this.loadedLuts) {
        const lutObj = this.loadedLuts[lutName];
        if (lutObj) {
          lutObj.loadPersistedLut();
        }
      }
      this.apiReloading = false;
      return 'reloaded';
    } else {
      return 'currentlyReloading';
    }
  }

  async loadAPI() {
    const self = this;
    log('[MainIpApi] Loading ipapi.is from preProcessed data...');

    // Perform environment checks before loading the API
    try {
      performEnvironmentChecks();
    } catch (error) {
      log(`Environment check failed: ${error.message}`, 'ERROR');
      throw new Error(`Environment validation failed: ${error.message}`);
    }

    if (!this.apiLoaded && !this.preventLutLoading) {
      const t0 = performance.now();
      if (this.enableASN) {
        this.asnLut = new IPtoASN();
        this.asnLut.loadLookupTable().then((loaded) => {
          log('Loaded asnLut');
        });
      }
      this.customListsLut = null;
      this.hostingLut = new IPtoDatacenter();
      this.blacklistLut = new IPtoBlacklist();
      this.companyLut = new IPtoCompany();
      this.mobileLut = new IPtoMobile();
      this.crawlerLut = new CrawlerAndBots();
      this.satelliteLut = new IPtoSatellite();
      this.cleanLut = new IPtoClean();
      this.whoisLut = new IPtoWhois();

      this.cleanLut.loadLookupTable();

      await this.crawlerLut.loadLookupTable().then((ok) => {
        log('Loaded crawlerLut');
        self.loadedLuts.crawlerLut = self.crawlerLut.crawlerAndBotsLut;
      });

      await this.companyLut.loadLookupTable().then((ok) => {
        log('Loaded companyLut');
        self.loadedLuts.companyLut = self.companyLut.companyLut;
      });

      await this.mobileLut.loadLookupTable().then((ok) => {
        log('Loaded mobileLut');
        self.loadedLuts.mobileLut = self.mobileLut.mobileLut;
      });

      await this.hostingLut.loadLookupTable().then((ok) => {
        log('Loaded datacenterLut');
        self.loadedLuts.datacenterLut = self.hostingLut.datacenterLut;
      });

      const blackListLoadConfig = { torLut: true, abuserLut: true, proxyLut: true, vpnLut: true, namedVpnLut: true };

      await this.blacklistLut.loadLookupTable(blackListLoadConfig).then((ok) => {
        log('Loaded blacklistLut');
        self.loadedLuts.abuserLut = self.blacklistLut.abuserLut;
        self.loadedLuts.proxyLut = self.blacklistLut.proxyLut;
        self.loadedLuts.torLut = self.blacklistLut.torLut;
        self.loadedLuts.vpnLut = self.blacklistLut.vpnLut;
        self.loadedLuts.namedVpnLut = self.blacklistLut.namedVpnLut;
      });

      if (this.enableGeolocation) {
        this.geolocationLut = new IPtoLocation();
        await this.geolocationLut.loadGeolocation().then((ok) => {
          log('Loaded geolocationLut');
          self.loadedLuts.geolocationLut = self.geolocationLut.finalLut;
        });
      }

      // load custom IP lists
      try {
        await this.loadCustomLists().then((ok) => {
          log('Loaded customListsLut');
          self.loadedLuts.customListsLut = self.customListsLut;
        });
      } catch (error) {
        log(`Failed to load custom lists: ${error.message}`, 'ERROR');
        // Continue loading other components even if custom lists fail
      }

      this.whoisLut.loadLookupTable();
      log('Loaded whoisLut');
      self.loadedLuts.whoisLut = self.whoisLut.whoisLut;

      this.satelliteLut.loadLookupTable();
      this.apiLoaded = true;
      const elapsedSeconds = round((performance.now() - t0) / 1000, 2);
      log(`Loading ipapi.is took ${elapsedSeconds} seconds!`);
    }
  }

  getRamDbVersion(humanStr = false) {
    const versions = {};

    for (const lutName in this.loadedLuts) {
      const lutObj = this.loadedLuts[lutName];
      if (lutObj) {
        versions[lutName] = humanStr ? new Date(lutObj.lutVersion) : lutObj.lutVersion;
      }
    }

    return versions;
  }

  async loadCustomLists() {
    const self = this;
    try {
      if (Array.isArray(this.customLists)) {
        const checkCustomListsFormat = (customLists) => {
          // check format of custom lists
          const allowedProps = ['is_abuser', 'is_tor', 'is_vpn', 'is_proxy', 'is_datacenter'];
          for (let obj of customLists) {
            if (!obj.path) {
              log('custom list object has invalid `path`', 'ERROR');
              return false;
            }
            if (!fs.existsSync(obj.path)) {
              log(`custom list path does not exist: ${obj.path}`, 'ERROR');
              return false;
            }
            if (typeof obj.property !== 'string') {
              log('custom list object has invalid `property`', 'ERROR');
              return false;
            }
            if (!allowedProps.includes(obj.property)) {
              log(`custom list object property must be in ${JSON.stringify(allowedProps)}`, 'ERROR');
              return false;
            }
          }
          return true;
        };

        if (checkCustomListsFormat(this.customLists)) {
          this.customListsLut = new FastLut('CustomListsLut');
          for (let obj of this.customLists) {
            log(`Loading custom list from path ${obj.path} for property ${obj.property}`, 'DEBUG');
            try {
              await loadText(obj.path, (ipOrCidr) => {
                self.customListsLut.addLut(ipOrCidr, obj.property);
              });
            } catch (loadError) {
              log(`Failed to load custom list from ${obj.path}: ${loadError.message}`, 'ERROR');
              // Continue with other files even if one fails
            }
          }
          self.customListsLut.prepareLut();
        } else {
          log(`ignoring custom lists because of format error`, 'ERROR');
        }
      }
    } catch (error) {
      log(`Error in loadCustomLists: ${error.message}`, 'ERROR');
    }
    // Always return a resolved promise to ensure the method returns a Promise
    return Promise.resolve();
  }

  getWhoisEndpoint() {
    let useApiEndpoint = APIEndpoint;

    const customWhoisEndpoint = this.apiConfig?.customWhoisEndpoint;
    if (typeof customWhoisEndpoint === 'string') {
      useApiEndpoint = customWhoisEndpoint;
    }

    if (typeof useApiEndpoint === 'string') {
      useApiEndpoint = useApiEndpoint.endsWith('/') ? useApiEndpoint : useApiEndpoint + '/';
    }

    return useApiEndpoint;
  }

  /**
   * 
   * @param {*} query 
   * @param {*} mesaurePerformance 
   * @param {*} lut Bitmask for company lut, ASN lut, location lut, datacenter lut, blacklist lut
   * @returns 
   */
  fastLookup(query, mesaurePerformance = false, lutBitmask = '11111', allCompanies = false,
    allDatacenters = false, allLocations = false) {
    const perf = {};
    let t0 = null;
    const inputIsIP = isIP(query);
    const inputIsASN = isASN(query);

    if (!inputIsIP && !inputIsASN) {
      return {
        error: 'Invalid IP Address or AS Number',
        error_code: API_ERROR_CODE.INVALID_IP_OR_ASN,
      }
    }

    if (inputIsASN) {
      if (this.enableASN) {
        return this.asnLut.lookup(query);
      } else {
        return {
          error: 'ASN lookup disabled',
          error_code: API_ERROR_CODE.ASN_LOOKUP_DISABLED,
        };
      }
    }

    const retVal = {
      ip: query,
      rir: null,
      is_bogon: false,
      is_mobile: false,
      is_satellite: false,
      is_crawler: false,
      is_datacenter: false,
      is_tor: false,
      is_proxy: false,
      is_vpn: false,
      is_abuser: false,
      vpn: undefined,
      datacenter: undefined,
      company: undefined,
      abuse: undefined,
      asn: undefined,
      location: undefined,
      elapsed_ms: undefined,
    };

    const inputIsIPv4 = (inputIsIP === 4);
    const inputIsIPv6 = (inputIsIP === 6);

    if (inputIsIPv4) {
      query = (new IPv4(query)).toString();
    } else if (inputIsIPv6) {
      query = abbreviateIPv6(query);
    }

    t0 = performance.now();
    const resIsSpecial = isSpecial(query);
    perf.bogonTest = delta(t0);
    if (resIsSpecial) {
      retVal.is_bogon = true;
      // that's it, we are done
      return retVal;
    }

    let asnData = null;

    // lookup to which ASN the ip address belongs
    if (this.enableASN && this.asnLut && lutBitmask[1] === '1') {
      t0 = performance.now();
      asnData = this.asnLut.lookup(query);
      perf.asnLookup = delta(t0);
    } else {
      asnData = null;
    }

    // lookup to which organization the IP address belongs
    if (this.companyLut.companyLutLoaded && lutBitmask[0] === '1') {
      t0 = performance.now();
      retVal.company = this.companyLut.lookup(query, allCompanies, asnData);
      if (typeof retVal?.company?.rir === 'string') {
        retVal.rir = retVal.company.rir.toUpperCase();
        delete retVal.company.rir;
      }

      if (retVal?.company?.abuse?.name) {
        retVal.abuse = retVal?.company?.abuse;
      }

      if (retVal?.company?.abuse) {
        delete retVal?.company?.abuse;
      }

      perf.companyLookup = delta(t0);
    }

    // lookup datacenter information for this IP
    if (this.hostingLut && lutBitmask[3] === '1') {
      t0 = performance.now();
      let datacenter = this.hostingLut.lookup(query, allDatacenters);
      perf.datacenterLookup = delta(t0);
      if (datacenter) {
        retVal.is_datacenter = true;
        retVal.datacenter = datacenter;
      }
    }

    // lookup mobile information for this IP
    if (this.mobileLut) {
      t0 = performance.now();
      retVal.is_mobile = this.mobileLut.lookup(query);
      perf.mobileLookup = delta(t0);
    }

    // lookup satellite information for this IP
    if (this.satelliteLut) {
      t0 = performance.now();
      retVal.is_satellite = this.satelliteLut.lookup(query);
      perf.satelliteLookup = delta(t0);
    }

    // lookup crawler information for this IP
    if (this.crawlerLut) {
      t0 = performance.now();
      retVal.is_crawler = this.crawlerLut.lookup(query);
      perf.crawlerLookup = delta(t0);
    }

    if (asnData) {
      retVal.asn = asnData;
    }

    // lookup geolocation
    if (this.geolocationLut && this.enableGeolocation && lutBitmask[2] === '1') {
      t0 = performance.now();
      retVal.location = this.geolocationLut.lookup(query, allLocations);
      perf.geolocLookup = delta(t0);
    } else {
      retVal.location = null;
    }

    if (lutBitmask[4] === '1') {
      t0 = performance.now();
      let blacklistRes = this.blacklistLut.lookup(query);
      if (blacklistRes) {
        Object.assign(retVal, blacklistRes);
        if (typeof blacklistRes.is_vpn === 'object' && blacklistRes.is_vpn !== null) {
          retVal.is_vpn = true;
          retVal.vpn = blacklistRes.is_vpn;
        }
      }
      perf.blacklistLookup = delta(t0);
    }

    // custom lists lookup
    if (this.customListsLut) {
      t0 = performance.now();
      const property = this.customListsLut.fastLookup(query);
      if (property) {
        retVal[property] = true;
      }
      perf.customListLookup = delta(t0);
    }

    // lookup clean information for this IP
    if (this.cleanLut) {
      t0 = performance.now();
      const cleanRes = this.cleanLut.lookup(query);
      if (cleanRes === CLEAN_ALL) {
        retVal.is_datacenter = false;
        retVal.is_crawler = false;
        retVal.is_tor = false;
        retVal.is_proxy = false;
        retVal.is_vpn = false;
        retVal.is_abuser = false;
        delete retVal?.datacenter;
        delete retVal?.vpn;
      }
      perf.cleanLookup = delta(t0);
    }

    if (mesaurePerformance) {
      retVal.perf = perf;
    }

    return retVal;
  }

  getDistance(ip1, ip2, useOnlyIfSourcesMatch) {
    // Validate ip1
    if (!ip1 || typeof ip1 !== 'string' || !isIP(ip1.trim())) {
      return {
        error: `Invalid IP address for ip1: ${ip1}`,
        error_code: API_ERROR_CODE.DISTANCE_INVALID_IP1,
        ip1: ip1,
        ip2: ip2,
        distance: null,
      };
    }

    // Validate ip2
    if (!ip2 || typeof ip2 !== 'string' || !isIP(ip2.trim())) {
      return {
        error: `Invalid IP address for ip2: ${ip2}`,
        error_code: API_ERROR_CODE.DISTANCE_INVALID_IP2,
        ip1: ip1,
        ip2: ip2,
        distance: null,
      };
    }

    let loc1 = this.geolocationLut.lookup(ip1, true);
    let loc2 = this.geolocationLut.lookup(ip2, true);

    let apiResponse = {
      ip1: ip1,
      ip2: ip2,
      distance: null,
    };

    // Check if location data was found for ip1
    if (!loc1) {
      return {
        ...apiResponse,
        error: `Location not found for ip1: ${ip1}`,
        error_code: API_ERROR_CODE.DISTANCE_LOCATION_NOT_FOUND_IP1,
      };
    }

    // Check if location data was found for ip2
    if (!loc2) {
      return {
        ...apiResponse,
        error: `Location not found for ip2: ${ip2}`,
        error_code: API_ERROR_CODE.DISTANCE_LOCATION_NOT_FOUND_IP2,
      };
    }

    if (loc1 && loc2) {
      let [lat1, lon1] = [parseFloat(loc1.latitude), parseFloat(loc1.longitude)];
      let [lat2, lon2] = [parseFloat(loc2.latitude), parseFloat(loc2.longitude)];
      let distance = getDistanceFromLatLonInKm(lat1, lon1, lat2, lon2);
      apiResponse.distance = distance;

      if (useOnlyIfSourcesMatch && loc1.alt && loc2.alt) {
        let distanceAlt = getDistanceFromLatLonInKm(
          parseFloat(loc1.alt.latitude),
          parseFloat(loc1.alt.longitude),
          parseFloat(loc2.alt.latitude),
          parseFloat(loc2.alt.longitude),
        );
        let diff = Math.abs(distanceAlt - distance);
        if (diff > 300) {
          apiResponse.distance = null;
          apiResponse.error = `Distances are too much apart: distance=${distance}, distanceAlt=${distanceAlt}`;
          apiResponse.error_code = API_ERROR_CODE.DISTANCE_CALCULATION_FAILED;
        }
      }
    }

    return apiResponse;
  }

  whoisLookup(whoisQuery) {
    // Validate input
    if (!whoisQuery || typeof whoisQuery !== 'string' || whoisQuery.trim() === '') {
      return {
        error: 'Invalid query: whois query must be a non-empty string',
        error_code: API_ERROR_CODE.WHOIS_INVALID_QUERY,
      };
    }

    // Perform the lookup - this may return a string (success) or an error object
    const result = this.whoisLut.lookup(whoisQuery);

    // If result is an object with error property, it's an error response
    // Otherwise, it's a successful whois data string
    return result;
  }

  /**
   * Allows to lookup up to `maxBulkSize` queries at once.
   * 
   * @param {Array} queries A non-empty array of IP addresses or ASNs to lookup
   * @param {number} maxBulkSize Maximum number of unique queries allowed after deduplication (default: 100)
   * @returns {Object} Object with query results or error
   */
  bulkLookup(queries, maxBulkSize = 100) {
    // Validate that queries is an array
    if (!Array.isArray(queries)) {
      return {
        error: 'Invalid input: The `ips` parameter must be an array of IP addresses or ASNs',
        error_code: API_ERROR_CODE.INVALID_BULK_INPUT_NOT_ARRAY,
      }
    }

    // Validate that queries is not empty
    if (queries.length === 0) {
      return {
        error: 'Invalid input: The `ips` array cannot be empty. Please provide at least one IP address or ASN',
        error_code: API_ERROR_CODE.INVALID_BULK_INPUT_EMPTY,
      }
    }

    // Validate maxBulkSize parameter
    if (typeof maxBulkSize !== 'number' || maxBulkSize < 1 || !Number.isInteger(maxBulkSize)) {
      return {
        error: 'Invalid configuration: Maximum bulk size must be a positive integer',
        error_code: API_ERROR_CODE.INVALID_BULK_SIZE_CONFIG,
      }
    }

    // Remove duplicates and filter valid IPs and ASNs
    const uniqueQueries = [...new Set(queries)];
    const validQueries = uniqueQueries.filter((query) => isIP(query) || isASN(query));

    // Check if we have at least one valid query after deduplication
    if (validQueries.length === 0) {
      return {
        error: 'Invalid input: The `ips` array must contain at least one valid IP address (IPv4 or IPv6) or ASN (e.g., AS15169)',
        error_code: API_ERROR_CODE.INVALID_BULK_INPUT_NO_VALID_ENTRIES,
      }
    }

    // Check max length after deduplication
    if (validQueries.length > maxBulkSize) {
      return {
        error: `Too many IP addresses: After removing duplicates, you provided ${validQueries.length} unique entries, but the maximum allowed is ${maxBulkSize}`,
        error_code: API_ERROR_CODE.BULK_LIMIT_EXCEEDED,
      }
    }

    let bulkLookupResults = {};

    for (let query of validQueries) {
      let start_ts = performance.now();
      let obj = this.fastLookup(query);
      obj.elapsed_ms = round(performance.now() - start_ts, 2);
      bulkLookupResults[query] = obj;
    }

    return bulkLookupResults;
  }
}

module.exports = {
  MainIpApi,
  load
};
