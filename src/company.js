const fs = require('fs');
const { getInetnumStartIP, isIPv4Cidr, isIPv4Inetnum, isLastResortOrg,
  networkToStr, getNetworkType, getCidrFromInet6num, numHostsInNet } = require('ip_address_tools');
const { IPv6 } = require('ip-num');
const { FastLut, ON_MULTI_ALL } = require('./fast_lut');
const { decodeRir, decodeType } = require('./types');
const { APIEndpoint, COMPANY_LUT_FILE, COMPANY_ORG_ABUSER_SCORE_FILE } = require('./constants');
const { log } = require('./utils');

// 'telecom', 'telekom', ' mobile', ' net ', 'internet', 'residential', 
const priorityNames = ['kreistag', 'landtag', 'ordinariat', 'stadtverwaltung', 'kreisverwaltung',
  'gemeinde', 'studenten', 'verwaltungsgericht', 'rathaus', 'gemeinde',
  'bundes', 'landes', ' federal ', 'medical center', 'e.v.', 'hospital', 'schotterwerke'].map(e => e.toLowerCase());

const isPriorityName = (orgName) => {
  if (typeof orgName === 'string') {
    for (const priorityName of priorityNames) {
      if (orgName.includes(priorityName)) {
        return true;
      }
    }
  }
  return false;
};

const getNetworkStr = (network, ipVersion) => {
  let networkStr = null;

  if (ipVersion === 6) {
    networkStr = getCidrFromInet6num(
      IPv6.fromBigInt(network[0]).toString(),
      IPv6.fromBigInt(network[1]).toString()
    );
  } else {
    networkStr = networkToStr(network, ipVersion);
  }

  return networkStr;
};

class IPtoCompany {
  constructor(includeIgnoredNets = false, minIPv4Net = null) {
    this.includeIgnoredNets = includeIgnoredNets;
    this.companyLutLoaded = false;
    this.minIPv4Net = minIPv4Net;
    this.companyLut = new FastLut('CompanyLut', ON_MULTI_ALL);
    this.companyIdLut = JSON.parse(fs.readFileSync(COMPANY_LUT_FILE, 'utf-8'));
    this.abuserScore = {};
  }

  async loadLookupTable() {
    this.companyLut.loadPersistedLut();
    this.abuserScore = JSON.parse(fs.readFileSync(COMPANY_ORG_ABUSER_SCORE_FILE, 'utf-8'));
    this.companyLutLoaded = true;
    return Promise.resolve();
  }

  getAbuserScore(network) {
    let abuserScore = "0 (Very Low)";
    let abuserScoreData = this.abuserScore[network];
    if (abuserScoreData) {
      abuserScore = `${abuserScoreData[0]} (${abuserScoreData[1]})`;
    }
    return abuserScore;
  }

  decode(orgId) {
    const orgdata = this.companyIdLut[orgId];
    if (orgdata) {
      const parts = orgdata.split('\t');
      const orgName = parts[0];
      const domain = parts[1];
      const encoded = parts[2];
      const name = parts[3];
      const address = parts[4];
      const email = parts[5];
      const phone = parts[6];
      const [encodedType, encodedRir] = encoded.split('');
      const type = decodeType(encodedType);
      const rir = decodeRir(encodedRir);
      return { orgName, domain, type, rir, name, address, email, phone };
    } else {
      log(`[decode] orgdata is: ${orgdata} for`, orgId);
    }
  }

  handleLookupResult(res, ipType) {
    const orgId = res.obj;
    const network = res.network;
    const networkStr = getNetworkStr(network, ipType);

    const { orgName, domain, type, rir, name, address, email, phone } = this.decode(orgId) || {};
    const retVal = {
      name: orgName,
      abuser_score: this.getAbuserScore(networkStr),
      domain: domain,
      type: type,
      network: networkStr,
      rir: rir,
      abuse: {
        name, address, email, phone
      },
    };

    let startIP = getInetnumStartIP(networkStr);
    if (startIP) {
      retVal.whois = `${APIEndpoint}?whois=${startIP}`;
    }
    if (retVal.domain === '' || retVal.domain === 'null' || !retVal.domain) {
      delete retVal.domain;
    }
    return retVal;
  }

  lookup(ip, returnAllNets = false) {
    if (!this.companyLut || !this.companyLutLoaded) {
      return null;
    }

    const res = this.companyLut.fastLookup(ip, true);
    if (!Array.isArray(res)) {
      return null;
    }

    const ipType = getNetworkType(ip);
    const results = res.map(obj => this.handleLookupResult(obj, ipType));

    // sort so that smallest net comes first
    results.sort((a, b) => numHostsInNet(a.network) - numHostsInNet(b.network));

    return returnAllNets ? results : results[0] || null;
  }

  lookupDeprecated(ip, returnAllNets = false, asnData = null) {
    let retVal = null;
    // lookup to which organization the IP address belongs
    if (this.companyLut && this.companyLutLoaded) {
      const res = this.companyLut.fastLookup(ip, true);
      if (Array.isArray(res)) {
        const ipType = getNetworkType(ip);
        retVal = [];

        for (const obj of res) {
          retVal.push(this.handleLookupResult(obj, ipType));
        }

        // sort so that smallest net comes first
        retVal.sort((a, b) => {
          return numHostsInNet(a.network) - numHostsInNet(b.network);
        });

        const baseline = [];
        const hasPriorityType = [];
        const hasPriorityName = [];
        const matchesAsnName = [];
        const highAbuserScore = [];
        const hasIspType = [];

        if (returnAllNets) {
          return retVal;
        } else {
          for (const val of retVal) {
            if (typeof val.rir === 'string') {
              // first give ARIN_CUST a shot
              if (val?.rir?.toUpperCase() === 'ARIN_CUST') {
                return val;
              }

              // then give RWHOIS a shot
              if (val?.rir?.toUpperCase() === 'RWHOIS') {
                return val;
              }
            }

            if (!isLastResortOrg(val.name)) {
              baseline.push(val);

              if (['education', 'government', 'banking'].includes(val.type)) {
                hasPriorityType.push(val);
              }

              // always return the smallest `isp` type
              if (val.type === 'isp') {
                hasIspType.push(val);
              }

              if (isPriorityName(val.name)) {
                hasPriorityName.push(val);
              }

              if (val.abuser_score.includes('High') || val.abuser_score.includes('Elevated')) {
                highAbuserScore.push(val);
              }

              // if the org has the same name as the ASN org, return that one
              if (asnData && typeof asnData?.org === 'string' && val.type !== 'business') {
                const asnNormOrg = asnData?.org.toLowerCase().trim();
                const normVal = val.name.toLowerCase().trim();
                if (asnNormOrg === normVal) {
                  matchesAsnName.push(val);
                }
              }
            }
          }

          if (highAbuserScore.length > 0) {
            return highAbuserScore[0];
          } else if (hasPriorityType.length > 0) {
            return hasPriorityType[0];
          } else if (hasPriorityName.length > 0) {
            return hasPriorityName[0];
          } else if (hasIspType.length > 1) {
            return hasIspType[0];
          } else if (matchesAsnName.length) {
            return matchesAsnName[0];
          } else if (baseline.length > 0) {
            return baseline[0];
          } else if (retVal.length > 0) {
            return retVal[0];
          }
        }
        retVal = null;
      }
    }
    return retVal;
  }

  async getOrgNamesByIpCount(limit = 500) {
    let nameNumIps = {};
    const netsFileName = 'organisation_data/allNets.tsv';
    await new Promise((resolve) => {
      let reader = load(netsFileName, { lr: true });
      reader.on('line', function (line) {
        const [name, network, domain, type] = line.split('\t');
        if (isIPv4Cidr(network) || isIPv4Inetnum(network)) {
          const totalHosts = numHostsInNet(network);
          if (!nameNumIps[name]) {
            nameNumIps[name] = 0;
          }
          nameNumIps[name] += totalHosts;
        }
      });
      reader.on('end', function () {
        resolve(true);
      });
    });

    let entries = Object.entries(nameNumIps);
    entries.sort((a, b) => b[1] - a[1]);
    return entries.slice(0, limit);
  }
}

class IPtoCompanyIgnored {
  constructor() {
    this.companyLutIgnored = new FastLut('CompanyLutIgnored', ON_MULTI_ALL);
  }

  async loadLookupTable() {
    this.companyLutIgnored.loadPersistedLut();
    return Promise.resolve();
  }
}

/**
 * Tests that the lookup function picks the correct organization for a given IP address.
 * 
 * @param {*} APIRequest 
 */
const testPicksTheCorrectOrganization = async (APIRequest = null) => {
  let obj = null;
  let asnObj = null;
  const stats = {
    correct: 0,
    wrong: 0,
  };

  if (!APIRequest) {
    obj = new IPtoCompany();
    await obj.loadLookupTable();

    const { IPtoASN } = require('./ip_to_asn');
    asnObj = new IPtoASN();
    await asnObj.loadLookupTable();
  }

  const picksCorrectOrgTestCases = {
    '46.99.35.242': {
      "name": "IPKO Telecommunications LLC",
      "type": "isp",
    },
    "185.67.178.225": {
      "name": "Universiteti i Prishtines - /29 each for different branches",
      "type": "education",
    },
    "197.189.147.85": {
      "name": 'Mobile subscribers.',
      "type": "isp",
    },
    "201.168.204.78": {
      "name": "COORDINADORA DE CARRIER'S, S.A. DE C.V.",
      "type": "isp",
    },
    '87.103.144.5': {
      "name": "OJSC Sibirtelecom",
      "type": "isp",
    },
    '103.178.153.222': {
      "name": "PT Herza Digital Indonesia",
      "type": "hosting",
    },
    '45.233.117.75': {
      "name": "RBA CATV SA DE CV",
      "type": "isp",
    },
    '72.28.20.188': {
      "name": 'Adams CATV, Inc.',
      "type": "isp",
    },
    '212.104.116.222': {
      "name": "A1 Bulgaria EAD",
      "type": "isp",
    },
    "2601:152:4c80:3b60:a969:7583:3c43:9c94": {
      "name": "Comcast Cable Communications, LLC",
      "type": "isp",
    },
    '192.158.226.22': {
      "name": "H4Y Technologies LLC",
      "type": "hosting",
    },
    '119.236.49.17': {
      "name": "Hong Kong Telecommunications (HKT) Limited Mass Internet",
      "type": "isp",
    },
    '31.18.30.85': {
      "name": "Vodafone Kabel Deutschland GmbH",
      "type": "isp",
    },
    // new test cases
    '95.221.31.212': {
      "name": "Net By Net Holding LLC",
      "type": "isp",
    },
    '86.127.171.6': {
      "name": "RCS & RDS Residential",
      "type": "isp",
    },
    '5.14.147.65': {
      "name": "RCS & RDS Mobile",
      "type": "isp",
    },
    '185.11.231.16': {
      "name": "Motivtelecom LTE/GPRS NAT block",
      "type": "isp",
    },
    '82.100.183.227': {
      "name": "DSL Pool5",
      "type": "isp",
    },
    '95.178.180.192': {
      "name": "OT - Optima Telekom d.d.",
      "type": "isp",
    },
    '195.243.107.86': {
      "name": "Bayerischer Landkreistag",
      "type": "business",
    },
    '193.175.5.165': {
      "name": "Studentenwerk Leipzig",
      "type": "business",
    },
    '2003:d7:a021::': {
      "name": "Verbandsgemeinde Hunsrueck-Mittelrhein",
      "type": "business",
    },
    // add 10 new examples
    '62.95.42.0': {
      "name": "Hisingens Franska Bilcenter",
      "type": "business",
    },
    // https://api.ipapi.is/?q=31.28.70.0&all_companies=1
    '31.28.70.0': {
      "name": "Blackpool Pleasure Beach Ltd",
      "type": "business",
    },
    // https://api.ipapi.is/?q=89.186.192.0&all_companies=1
    '89.186.192.0': {
      "name": "EJOT Schweiz AG",
      "type": "business",
    },
    // https://api.ipapi.is/?q=195.10.160.0&all_companies=1
    '195.10.160.0': {
      "name": "EPV Energia Oy",
      "type": "business",
    },
    // https://api.ipapi.is/?q=178.159.0.0&all_companies=1
    '178.159.0.0': {
      "name": "24xservice.com",
      "type": "business",
    },
    // https://api.ipapi.is/?q=185.119.92.0&all_companies=1
    '185.119.92.0': {
      "name": "Stern-Center Regensburg GmbH & Co. KG",
      "type": "business",
    },
    // https://api.ipapi.is/?q=103.21.236.0&all_companies=1
    '103.21.236.0': {
      "name": "Krankenhaus GmbH Landkreis Weilheim-Schongau",
      "type": "business",
    },
    // baseline tests
    '94.139.29.30': {
      "name": "Tele Columbus AG",
      "type": "isp",
    },
    "164.68.179.141": {
      "name": "Hotwire Communications",
      "type": "isp",
    },
  };

  for (const orgIp in picksCorrectOrgTestCases) {
    let orgRes = null;

    if (APIRequest) {
      orgRes = await APIRequest(orgIp);
      orgRes = orgRes.company;
    } else {
      const asnData = asnObj.lookup(orgIp);
      orgRes = obj.lookup(orgIp, false, asnData);
    }

    if (orgRes && orgRes.name === picksCorrectOrgTestCases[orgIp].name &&
      orgRes.type === picksCorrectOrgTestCases[orgIp].type) {
      console.log(`[picksCorrectOrgTestCases] test passed`);
      stats.correct++;
    } else {
      console.log(`[picksCorrectOrgTestCases][fail] test failed.`, orgIp);
      console.log(`Expected:`, picksCorrectOrgTestCases[orgIp]);
      console.log(`Got:`, orgRes);
      stats.wrong++;
    }
  }

  console.log(`[picksCorrectOrgTestCases] stats: ${JSON.stringify(stats)}`);
};

module.exports = {
  testPicksTheCorrectOrganization,
  IPtoCompany,
  IPtoCompanyIgnored
};

if (require.main === module) {
  if (process.argv.includes('testPicksTheCorrectOrganization')) {
    process.env.LOG_LEVEL = 3;
    testPicksTheCorrectOrganization();
  }
}
