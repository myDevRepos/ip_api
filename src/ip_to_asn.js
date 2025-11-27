const path = require('path');
const { round, log } = require('./utils');
const fs = require('fs');
const { isIPv4, isIPv6, isIP, isASN,
  numHostsInCidrIPv4, numHostsInCidrIPv6, numHostsInNet } = require('ip_address_tools');
const { FastLut, ON_MULTI_SMALLEST } = require('./fast_lut');
const { IP_API_DB_DIR, ASN_USED_AUTNUMS_RAM_DB_FILE,
  ASN_DATA_RAM_DB_FILE, ASN_ABUSER_SCORE_FILE,
  ACTIVE_ASNS_FILE, ACTIVE_IPV4_IP_RANGES_FILE, ASN_META_FILE } = require('./constants');
const { APIEndpoint } = require('./constants');

function getHtmlTagForType(type) {
  if (type === 'hosting') {
    return 'is-dark';
  } else if (type === 'banking') {
    return 'is-primary';
  } else if (type === 'isp') {
    return 'is-link';
  } else if (type === 'business') {
    return 'is-info';
  } else if (type === 'education') {
    return 'is-success';
  } else if (type === 'government') {
    return 'is-warning';
  } else if (type === '-' || !type) {
    return 'is-white';
  }
}

function getHtmlColorForType(type) {
  if (type === 'hosting') {
    return '#32CD32';  // Lime Green for technology
  } else if (type === 'banking') {
    return '#4169E1';  // Royal Blue for banking
  } else if (type === 'isp') {
    return '#1E90FF';  // Dodger Blue for ISP
  } else if (type === 'business') {
    return '#808080';  // Medium Gray for business
  } else if (type === 'education') {
    return '#FFD700';  // Gold for education
  } else if (type === 'government') {
    return '#FF6347';  // Tomato for government
  } else if (type === '-' || !type) {
    return '#FFFFFF';  // White for undefined or null types
  }
}

function getHtmlTagForRir(rir) {
  if (rir) {
    rir = rir.toUpperCase().trim();
  } else {
    rir = '-';
  }
  return `<span class="tag is-dark">${rir}</span>`;
}

function getHtmlCountryFlag(country) {
  if (country) {
    country = country.toLowerCase().trim();
    return `<span class="fi fi-${country}"></span>`;
  }
  return '';
}

class IPtoASN {
  constructor() {
    this.autnums = {};
    this.abuserScore = {};
    this.verbose = true;
    this.debug = false;
    this.lut = new FastLut('AsnLut', ON_MULTI_SMALLEST);
  }

  async loadLookupTable() {
    this.metaASN = JSON.parse(fs.readFileSync(ASN_DATA_RAM_DB_FILE, 'utf-8'));
    this.autnums = JSON.parse(fs.readFileSync(ASN_USED_AUTNUMS_RAM_DB_FILE, 'utf-8'));
    this.abuserScore = JSON.parse(fs.readFileSync(ASN_ABUSER_SCORE_FILE, 'utf-8'));
    this.lut.loadPersistedLut();
  }

  getPrefixesForAsn(asn) {
    if (asn in this.autnums) {
      return {
        ipv4: this.autnums[asn].p || [],
        ipv6: this.autnums[asn].p6 || [],
      };
    }
    return {
      ipv4: [],
      ipv6: [],
    };
  }

  /**
   * Print AS statistics.
   */
  asSummary(returnActiveIPRanges = false) {
    let numActive = 0;
    let numInactive = 0;
    let numTotalIPv4 = 0;
    let numTotalIPv6 = 0;
    let numTotalIPv4Prefixes = 0;
    let numTotalIPv6Prefixes = 0;
    let maxPrefixes = 0;
    let distIpv4IPRanges = {};
    let ipv4IPRanges = {};
    let activeASNs = [];

    for (let asn in this.autnums) {
      let obj = this.autnums[asn];
      if (obj.a) {
        activeASNs.push(asn);
        numActive++;
      } else {
        numInactive++;
      }

      let numPrefixes = 0;

      if (Array.isArray(obj.p)) {
        numTotalIPv4Prefixes += obj.p.length;
        numPrefixes += obj.p.length;
        for (let prefix of obj.p) {
          numTotalIPv4 += numHostsInCidrIPv4(prefix);
          let [startAddr, netBits] = prefix.split('/');
          if (!distIpv4IPRanges[netBits]) {
            distIpv4IPRanges[netBits] = 1;
          } else {
            distIpv4IPRanges[netBits]++;
          }
          if (!ipv4IPRanges[netBits]) {
            ipv4IPRanges[netBits] = [prefix];
          } else {
            ipv4IPRanges[netBits].push(prefix);
          }
        }
      }
      if (Array.isArray(obj.p6)) {
        numTotalIPv6Prefixes += obj.p6.length;
        numPrefixes += obj.p6.length;
        for (let prefix of obj.p6) {
          numTotalIPv6 += numHostsInCidrIPv6(prefix);
        }
      }

      maxPrefixes = Math.max(numPrefixes, maxPrefixes);
    }

    log(`numActive=${numActive}, numInactive=${numInactive}`);
    log(`numTotalIPv4=${numTotalIPv4}, numTotalIPv6=${numTotalIPv6}`);
    log(`numTotalIPv4Ranges=${numTotalIPv4Prefixes}, numTotalIPv6Ranges=${numTotalIPv6Prefixes}`);
    log(`AS with most prefixes=${maxPrefixes}`);
    log(`Distribution of netBits in the Internet: ${JSON.stringify(distIpv4IPRanges, null, 2)}`);

    return {
      activeASNs: activeASNs,
      ipv4IPRanges: returnActiveIPRanges ? ipv4IPRanges : undefined,
      numActiveASNs: numActive,
      numInactiveASNs: numInactive,
      numTotalIPv4Prefixes: numTotalIPv4Prefixes,
      numTotalIPv6Prefixes: numTotalIPv6Prefixes,
      numTotalIPv4: numTotalIPv4,
      numTotalIPv6: numTotalIPv6,
      asnWithMostPrefixes: maxPrefixes,
      ipv4PrefixDistribution: distIpv4IPRanges,
    };
  }

  getHtmlInfoTable(limit = 5000) {
    let json = {};
    let html = '';
    let i = 0;
    for (let asn in this.autnums) {
      if (limit && i > limit) {
        break;
      }
      let obj = { asn: asn };
      Object.assign(obj, this.autnums[asn]);
      obj.descr = obj.d;
      delete obj.d;
      obj.country = obj.c;
      delete obj.c;
      obj.active = obj.a;
      delete obj.a;

      if (obj.active) {
        Object.assign(obj, this.metaASN[asn]);
        html += `<tr>
  <td><a href="/asn/${asn}.html">${asn}</a></td>
  <td><a href="/asn/${asn}.html">${obj.org || obj.descr}</a></td>
  <td>${getHtmlCountryFlag(obj.country)}${obj.country || '-'}</td>
  <td>${obj.domain ? `<a href="https://${obj.domain}">${obj.domain}</a>` : '-'}</td>
  <td><span class="tag ${getHtmlTagForType(obj.type)}">${obj.type || '-'}</span></td>
  <td>${getHtmlTagForRir(obj.rir)}</td>
</tr>`;
        obj.prefixes = obj.p;
        delete obj.p;
        obj.prefixesIPv6 = obj.p6;
        delete obj.p6;
      }
      json[asn] = obj;
      i++;
    }
    return [json, html];
  }

  getASNOrgsByNumRoutes(limit = 300) {
    let orgsWithPrefixCount = {};
    for (let asn in this.autnums) {
      let obj = { asn: asn };
      Object.assign(obj, this.autnums[asn]);
      if (obj.a) {
        Object.assign(obj, this.metaASN[asn]);
        if (Array.isArray(obj.p) && obj.p.length > 0 && obj.org) {
          let totalHostsInASN = 0;
          for (let net of obj.p) {
            totalHostsInASN += numHostsInNet(net);
          }
          if (!orgsWithPrefixCount[obj.org]) {
            orgsWithPrefixCount[obj.org] = 0;
          }
          orgsWithPrefixCount[obj.org] += totalHostsInASN;
        }
      }
    }
    let entries = Object.entries(orgsWithPrefixCount);
    entries.sort((a, b) => b[1] - a[1]);
    return entries.slice(0, limit);
  }

  getAbuserScore(asn) {
    let abuserScore = "0 (Very Low)";
    const abuserScoreData = this.abuserScore[`as${asn}`];
    if (abuserScoreData) {
      abuserScore = `${abuserScoreData[0]} (${abuserScoreData[1]})`;
    }
    return abuserScore;
  }

  /**
   * Lookup either an IP address or ASN number.
   * 
   * If an IP address is specified, the API returns the ASN that `owns` this IP address
   * If an AS number is supplied, the API returns the ASN information and all IP ranges for this ASN.
   * 
   * @param {*} ipOrASN 
   * @returns 
   */
  lookup(ipOrASN, addRoutesToOutput = false, addNumIPv4ToOutput = false) {
    if (isIP(ipOrASN)) {
      let asn_lookup = null;
      let retval;
      let asn;
      let cidr;
      let t0 = performance.now();

      // lookup to which ASN the IPv4 belongs
      if (isIPv4(ipOrASN)) {
        retval = this.lut.fastLookup(ipOrASN);
        if (retval && Array.isArray(retval)) {
          [asn, cidr] = retval;
        }
      } else if (isIPv6(ipOrASN)) {
        retval = this.lut.fastLookup(ipOrASN);
      }

      if (retval && Array.isArray(retval)) {
        [asn, cidr] = retval;
      }

      if (asn === undefined) {
        asn_lookup = null;
      } else {
        let { d, c, p, p6, a } = this.autnums[asn];
        if (c) {
          c = c.toLowerCase();
        }

        asn_lookup = {
          asn: asn,
          abuser_score: this.getAbuserScore(asn),
          route: cidr,
          descr: d,
          country: c,
          active: a,
          prefixes: addRoutesToOutput ? p : undefined,
          prefixesIPv6: addRoutesToOutput ? p6 : undefined,
        };

        if (addNumIPv4ToOutput) {
          let prefixesIPv4Count = 0;
          if (Array.isArray(p)) {
            for (const route of p) {
              prefixesIPv4Count += numHostsInNet(route);
            }
          }
          asn_lookup.prefixesIPv4Count = prefixesIPv4Count;
        }

        Object.assign(asn_lookup, this.metaASN[asn]);
        asn_lookup.whois = `${APIEndpoint}?whois=AS${asn}`;
      }

      let t1 = performance.now();
      if (asn_lookup && this.debug) {
        asn_lookup.elapsed_ms = round(t1 - t0, 2);
      }
      return asn_lookup;
    } else if (isASN(ipOrASN)) {
      const asn = parseInt(ipOrASN.toLowerCase().trim().replace('as', ''));
      if (asn in this.autnums) {
        const asnData = this.autnums[asn];
        let { d, c, p, p6, a } = asnData;
        if (c) {
          c = c.toLowerCase();
        }
        let obj = {
          asn: asn,
          abuser_score: this.getAbuserScore(asn),
          descr: d,
          country: c,
          active: a,
        };
        Object.assign(obj, this.metaASN[asn]);
        obj.whois = `${APIEndpoint}?whois=AS${asn}`;
        obj.prefixes = p;
        obj.prefixesIPv6 = p6;
        return obj;
      } else {
        return {
          'error': `No data for ASN ${asn}`
        };
      }
    } else {
      return {
        'error': 'Neither an AS number or valid IP address'
      };
    }
  }

  toJson() {
    const json = {};

    for (const [asn, data] of Object.entries(this.autnums)) {
      const {
        d: descr,
        c: country,
        a: active,
        p: prefixes,
        p6: prefixesIPv6,
        ...rest
      } = data;

      const obj = {
        asn,
        descr,
        abuser_score: this.getAbuserScore(asn),
        country,
        active,
        ...rest
      };

      if (active) {
        Object.assign(obj, this.metaASN[asn], { prefixes, prefixesIPv6 });
      }

      json[asn] = obj;
    }

    return json;
  }
}

const regenerateAsnData = async () => {
  const { persistAsnLut } = require('../parseSources/ip_to_asn');
  persistAsnLut({ regenerateAutnums: true });

  const asnObj = new IPtoASN();
  await asnObj.loadLookupTable();
  let asInfo = asnObj.asSummary(true);
  fs.writeFileSync(ACTIVE_ASNS_FILE, JSON.stringify(asInfo.activeASNs));
  delete asInfo.activeASNs;
  fs.writeFileSync(ACTIVE_IPV4_IP_RANGES_FILE, JSON.stringify(asInfo.ipv4IPRanges, null, 2));
  delete asInfo.ipv4IPRanges;
  fs.writeFileSync(ASN_META_FILE, JSON.stringify(asInfo, null, 2));
};

async function getASNDataAsHtmlTable(limit = 5000) {
  const obj = new IPtoASN();
  await obj.loadLookupTable();
  let summary = obj.asSummary();
  delete summary.activeASNs
  let [json, html] = obj.getHtmlInfoTable(limit);
  return [json, html, summary];
}

async function createAsnJson() {
  const obj = new IPtoASN();
  await obj.loadLookupTable();

  const outFile = path.join(IP_API_DB_DIR, `./json/asn.json`);
  fs.writeFileSync(outFile, JSON.stringify(obj.toJson(), null, 2));
}

async function dumpASNDatabaseSample(asnSamplePath, size = 500) {
  const obj = new IPtoASN();
  await obj.loadLookupTable();
  const asnData = obj.toJson();
  let sample = {};
  let count = 0;
  for (const asn in asnData) {
    sample[asn] = asnData[asn];
    if (count >= size) {
      break;
    }
    count++;
  }
  fs.writeFileSync(asnSamplePath, JSON.stringify(sample, null, 2));
}

module.exports = {
  getHtmlColorForType,
  IPtoASN,
  regenerateAsnData,
  createAsnJson,
  dumpASNDatabaseSample,
  getASNDataAsHtmlTable,
  getHtmlTagForType,
  getHtmlTagForRir,
  getHtmlCountryFlag,
};
