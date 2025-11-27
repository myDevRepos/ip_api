const fs = require('fs');
const path = require('path');
const { isASN, isIP } = require('ip_address_tools');
const { FastLut, ON_MULTI_SMALLEST } = require('./fast_lut');
const { WHOIS_DATA_DIR } = require('./constants');
const { API_ERROR_CODE } = require('./ipapi_is_worker_utils');

class IPtoWhois {
  constructor() {
    this.loadedLut = false;
    this.whoisLut = new FastLut('WhoisLut', ON_MULTI_SMALLEST);
    this.basePath = WHOIS_DATA_DIR;
  }

  loadLookupTable() {
    this.whoisLut.loadPersistedLut();
    this.loadedLut = true;
  }

  lookup(whoisQuery, onlyTest = false, returnPath = false) {
    whoisQuery = whoisQuery.toLowerCase().trim();

    // Validate input
    if (!isASN(whoisQuery) && !isIP(whoisQuery)) {
      if (onlyTest) {
        return false;
      }
      return {
        error: `Invalid query: ${whoisQuery} is neither a valid IP address nor a valid ASN`,
        error_code: API_ERROR_CODE.WHOIS_INVALID_QUERY,
      };
    }

    if (isASN(whoisQuery)) {
      const asnPath = path.join(this.basePath, `ASN/${whoisQuery}.txt`);
      if (fs.existsSync(asnPath)) {
        if (onlyTest) {
          return true;
        }
        return fs.readFileSync(asnPath, 'utf8');
      }
    } else if (isIP(whoisQuery)) {
      let netPath = this.whoisLut.fastLookup(whoisQuery);
      if (netPath) {
        netPath = path.join(this.basePath, `${netPath}`);
        if (fs.existsSync(netPath)) {
          if (returnPath) {
            return netPath;
          }

          if (onlyTest) {
            return true;
          }
          return fs.readFileSync(netPath, 'utf8');
        }
      }
    }

    // No whois record found
    if (onlyTest) {
      return false;
    }
    return {
      error: `No whois record found for query: ${whoisQuery}`,
      error_code: API_ERROR_CODE.WHOIS_NOT_FOUND,
    };
  }
}

module.exports = { IPtoWhois };
