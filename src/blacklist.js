const fs = require('fs');
const path = require('path');
const { FastLut, ON_MULTI_ALL } = require('./fast_lut');
const { IPtoASN, getHtmlColorForType } = require('./ip_to_asn');
const { IPtoCompany } = require('./company');
const { round, sortObjectByValue, log } = require('./utils');
const { numHostsInNet, firstIpOfNet } = require('ip_address_tools');
const { POS_VAL, RAM_DB_DIR, ASN_ABUSER_SCORE_FILE } = require('./constants');

class IPtoBlacklist {
  constructor() {
    this.loadedLut = false;
    this.torLut = new FastLut('TorLut');
    this.abuserLut = new FastLut('AbuserLut', ON_MULTI_ALL);
    this.proxyLut = new FastLut('ProxyLut');
    this.vpnLut = new FastLut('VpnLut');
    this.namedVpnLut = new FastLut('NamedVpnLut', ON_MULTI_ALL);
    this.interpolatedVpnLut = new FastLut('InterpolatedVpnLut');
    this.posVal = 1;
    this.loaded = false;
  }

  async loadLookupTable() {
    this.abuserLut.loadPersistedLut();
    this.proxyLut.loadPersistedLut();
    this.torLut.loadPersistedLut();
    this.vpnLut.loadPersistedLut();
    this.namedVpnLut.loadPersistedLut();
    this.interpolatedVpnLut.loadPersistedLut();
    this.loaded = true;
    return Promise.resolve();
  }

  lookup(ip) {
    let response = {
      is_tor: false,
      is_abuser: false,
      is_proxy: false,
      is_vpn: false,
    };

    const torRes = this.torLut.fastLookup(ip);
    response.is_tor = (torRes === POS_VAL);

    let abuserRes = this.abuserLut.fastLookup(ip);
    if (abuserRes) {
      response.is_abuser = Array.isArray(abuserRes) ? abuserRes.length > 0 : false;
    }

    const proxyRes = this.proxyLut.fastLookup(ip);
    response.is_proxy = (proxyRes === POS_VAL);

    let vpnResSpecific = this.namedVpnLut.fastLookup(ip);
    if (vpnResSpecific) {
      vpnResSpecific = vpnResSpecific[0];
      if (Array.isArray(vpnResSpecific)) {
        if (vpnResSpecific.length === 0) {
          response.is_vpn = false;
        } else {
          response.is_vpn = true;
        }
      } else {
        response.is_vpn = vpnResSpecific;
      }
    }

    if (!response.is_vpn) {
      const vpnRes = this.interpolatedVpnLut.fastLookup(ip);
      if (vpnRes) {
        response.is_vpn = vpnRes;
      }
    }

    if (!response.is_vpn) {
      const vpnRes = this.vpnLut.fastLookup(ip);
      response.is_vpn = (vpnRes === POS_VAL);
    }

    return response;
  }

  getVpnStats() {
    if (!this.loaded) {
      this.loadLookupTable();
    }
    // how many type "exit_node" and "server" are in the namedVpnLut
    const stats = {
      exit_node: 0,
      vpn_server: 0,
      // Track VPN services enumerated in the past periods
      exit_node_last_12_days: 0,
      exit_node_last_3_days: 0,
      exit_node_last_7_days: 0,
    };
    const providerHistogram = {};
    const providerTimeHistogram = {
      last_12_days: {},
      last_3_days: {},
      last_7_days: {}
    };

    const now = Date.now();
    const day_ms = 24 * 60 * 60 * 1000;
    const days_12_ago = now - (12 * day_ms);
    const days_3_ago = now - (3 * day_ms);
    const days_7_ago = now - (7 * day_ms);

    this.namedVpnLut.iterLut((network, obj, ipVersion) => {
      if (obj.type === 'exit_node') {
        stats.exit_node++;

        // Check if the exit node was seen in the specified time periods
        if (obj.last_seen) {
          const timestamp = obj.last_seen;
          if (timestamp >= days_12_ago) stats.exit_node_last_12_days++;
          if (timestamp >= days_3_ago) stats.exit_node_last_3_days++;
          if (timestamp >= days_7_ago) stats.exit_node_last_7_days++;

          // Track by provider for each time period
          if (obj.service && obj.type === 'exit_node') {
            // Last 12 days
            if (timestamp >= days_12_ago) {
              if (!providerTimeHistogram.last_12_days[obj.service]) {
                providerTimeHistogram.last_12_days[obj.service] = 0;
              }
              providerTimeHistogram.last_12_days[obj.service]++;
            }

            // Last 3 days
            if (timestamp >= days_3_ago) {
              if (!providerTimeHistogram.last_3_days[obj.service]) {
                providerTimeHistogram.last_3_days[obj.service] = 0;
              }
              providerTimeHistogram.last_3_days[obj.service]++;
            }

            // Last 7 days
            if (timestamp >= days_7_ago) {
              if (!providerTimeHistogram.last_7_days[obj.service]) {
                providerTimeHistogram.last_7_days[obj.service] = 0;
              }
              providerTimeHistogram.last_7_days[obj.service]++;
            }
          }
        }
      }

      if (obj.type === 'vpn_server') stats.vpn_server++;

      // Count IPs per provider
      if (obj.service) {
        const service = obj.service;
        if (!providerHistogram[service]) {
          providerHistogram[service] = 0;
        }
        providerHistogram[service] += numHostsInNet(network);
      }
    }, 'both', true);

    // Sort the provider histogram by count in descending order
    stats.providerHistogram = sortObjectByValue(providerHistogram, 15);

    // Add time-based provider histograms
    stats.providerTimeHistogram = {
      last_3_days: sortObjectByValue(providerTimeHistogram.last_3_days),
      last_7_days: sortObjectByValue(providerTimeHistogram.last_7_days),
      last_12_days: sortObjectByValue(providerTimeHistogram.last_12_days),
    };

    return stats;
  }

  getTorStats() {
    if (!this.loaded) {
      this.loadLookupTable();
    }
    const stats = {
      numUniqueTorIps: 0,
      numUniqueTorIpsIPv4: 0,
      numUniqueTorIpsIPv6: 0,
    };
    this.torLut.iterLut((network, obj, ipVersion) => {
      stats.numUniqueTorIps++;
      if (ipVersion === 4) {
        stats.numUniqueTorIpsIPv4++;
      } else {
        stats.numUniqueTorIpsIPv6++;
      }
    }, 'both', true);
    return stats;
  }

  getLutStats() {
    if (!this.loaded) {
      this.loadLookupTable();
    }

    const MAX_SAFE = BigInt(Number.MAX_SAFE_INTEGER);
    const normalizeHostCount = (val) => {
      if (typeof val === 'number') {
        return BigInt(val);
      }
      if (typeof val === 'bigint') {
        return val;
      }
      if (val && typeof val === 'object') {
        if (typeof val.value === 'bigint') {
          return val.value;
        }
        if (typeof val.toString === 'function') {
          try {
            return BigInt(val.toString());
          } catch (error) {
            log('Failed to convert host count to BigInt', val, error.message, 'ERROR');
          }
        }
      }
      return 0n;
    };

    const formatHostCount = (value) => {
      return value <= MAX_SAFE ? Number(value) : value.toString();
    };

    const formatHosts = (hosts) => ({
      ipv4: formatHostCount(hosts.ipv4),
      ipv6: formatHostCount(hosts.ipv6),
      total: formatHostCount(hosts.ipv4 + hosts.ipv6),
    });

    const sumCounts = (target, source) => {
      if (!source) {
        return;
      }
      for (const key of Object.keys(source)) {
        target[key] = (target[key] || 0) + source[key];
      }
    };

    const buildStats = (lut) => {
      const info = typeof lut.lutInfo === 'function' ? lut.lutInfo() : { name: lut.name };
      const hosts = { ipv4: 0n, ipv6: 0n };
      const networks = { ipv4: 0, ipv6: 0 };

      lut.iterLut((network, _obj, ipVersion) => {
        const key = ipVersion === 4 ? 'ipv4' : 'ipv6';
        networks[key]++;
        try {
          hosts[key] += normalizeHostCount(numHostsInNet(network));
        } catch (error) {
          log(`Failed to compute host count for ${network} in ${lut.name}`, error.message, 'ERROR');
        }
      }, 'both', false);

      const directKeys = Object.keys(lut.directLut || {});
      let directIPv4 = 0;
      let directIPv6 = 0;
      for (const key of directKeys) {
        if (key.includes(':')) {
          directIPv6++;
        } else {
          directIPv4++;
        }
      }
      hosts.ipv4 += BigInt(directIPv4);
      hosts.ipv6 += BigInt(directIPv6);

      const directEntries = {
        ipv4: directIPv4,
        ipv6: directIPv6,
        total: directKeys.length,
      };
      const networkStats = {
        ipv4: networks.ipv4,
        ipv6: networks.ipv6,
        total: networks.ipv4 + networks.ipv6,
      };

      const stats = {
        name: info.name || lut.name,
        networks: networkStats,
        hosts: formatHosts(hosts),
        directEntries,
      };

      if (info.netsAdded) {
        stats.netsAdded = { ...info.netsAdded };
      }
      if (info.notAdded) {
        stats.notAdded = { ...info.notAdded };
      }

      return { stats, hosts, netsAdded: info.netsAdded, notAdded: info.notAdded };
    };

    const luts = [
      ['tor', this.torLut],
      ['abuser', this.abuserLut],
      ['proxy', this.proxyLut],
      ['vpn', this.vpnLut],
      ['namedVpn', this.namedVpnLut],
      ['interpolatedVpn', this.interpolatedVpnLut],
    ];

    const aggregate = {
      networks: { ipv4: 0, ipv6: 0 },
      hosts: { ipv4: 0n, ipv6: 0n },
      directEntries: { ipv4: 0, ipv6: 0 },
      netsAdded: {},
      notAdded: {},
    };

    const results = {};

    for (const [key, lut] of luts) {
      const { stats, hosts, netsAdded, notAdded } = buildStats(lut);
      results[key] = stats;

      aggregate.networks.ipv4 += stats.networks.ipv4;
      aggregate.networks.ipv6 += stats.networks.ipv6;
      aggregate.directEntries.ipv4 += stats.directEntries.ipv4;
      aggregate.directEntries.ipv6 += stats.directEntries.ipv6;
      aggregate.hosts.ipv4 += hosts.ipv4;
      aggregate.hosts.ipv6 += hosts.ipv6;
      sumCounts(aggregate.netsAdded, netsAdded);
      sumCounts(aggregate.notAdded, notAdded);
    }

    results.overall = {
      networks: {
        ipv4: aggregate.networks.ipv4,
        ipv6: aggregate.networks.ipv6,
        total: aggregate.networks.ipv4 + aggregate.networks.ipv6,
      },
      hosts: formatHosts(aggregate.hosts),
      directEntries: {
        ipv4: aggregate.directEntries.ipv4,
        ipv6: aggregate.directEntries.ipv6,
        total: aggregate.directEntries.ipv4 + aggregate.directEntries.ipv6,
      },
      netsAdded: aggregate.netsAdded,
      notAdded: aggregate.notAdded,
    };

    return results;
  }
}

const computeScore = (data) => {
  let scoreRanking = {};

  for (const key in data) {
    const val = data[key];
    const score = round(val.abuserCount / val.count, 4);
    let strScore = '';

    if (score > 0.2) {
      // More than 20% of all IP's of the ASN are abusive
      strScore = 'Very High';
    } else if (score <= 0.2 && score > 0.03) {
      // Between 3% to 20% of all IP's of the ASN are abusive
      strScore = 'High';
    } else if (score <= 0.03 && score > 0.0085) {
      // Between 0.85% to 3% of all IP's of the ASN are abusive
      strScore = 'Elevated';
    } else if (score <= 0.0085 && score > 0.0005) {
      // Between 0.85% to 0.05% of all IP's of the ASN are abusive
      strScore = 'Low';
    } else {
      // Less than 0.05% of all IP's of the ASN are abusive
      strScore = 'Very Low';
    }

    scoreRanking[key] = [Math.min(score, 1), strScore, ...val.extra];
  }

  let items = Object.entries(scoreRanking);
  items = items.sort((a, b) => b[1][0] - a[1][0]);
  return items;
};

const computeAsnAbuserScore = async () => {
  const obj = new IPtoBlacklist();
  await obj.loadLookupTable();

  const asn = new IPtoASN();
  await asn.loadLookupTable();

  let asnThreatScoreData = {};
  let abuserStats = {
    IPv4: 0,
    IPv6: 0,
  };

  const handleEntry = (netOrIp, obj, type) => {
    if (type === 4) {
      abuserStats.IPv4++;
      const asRes = asn.lookup(netOrIp, true);
      if (asRes?.active) {
        const key = `as${asRes.asn}`;
        if (!(key in asnThreatScoreData)) {
          let prefixesIPv4Count = 0;
          if (Array.isArray(asRes.prefixes)) {
            for (const route of asRes.prefixes) {
              prefixesIPv4Count += numHostsInNet(route);
            }
          }
          asnThreatScoreData[key] = {
            count: prefixesIPv4Count,
            abuserCount: 0,
            extra: [asRes?.org, asRes?.domain, asRes?.type, prefixesIPv4Count, asRes?.prefixes?.length],
          };
        }
        asnThreatScoreData[key].abuserCount++;
      }
    } else {
      abuserStats.IPv6++;
    }
  };

  obj.abuserLut.iterLut(handleEntry);
  obj.torLut.iterLut(handleEntry);

  const spamhausMarker = 'Spamhaus ASN-DROP';
  try {
    const spamhausLines = load('blocklist_data/asndrop.json', { split: true });
    for (const rawLine of spamhausLines) {
      const line = rawLine.trim();
      if (!line) {
        continue;
      }
      let entry;
      try {
        entry = JSON.parse(line);
      } catch (error) {
        log('Failed to parse Spamhaus ASN entry', line, error.message, 'ERROR');
        continue;
      }
      const asnNumber = entry?.asn;
      if (!Number.isInteger(asnNumber)) {
        continue;
      }
      const key = `as${asnNumber}`;
      const asRes = asn.lookup(`AS${asnNumber}`, true);
      let prefixesIPv4Count = 0;
      let prefixCount = 0;
      if (asRes && Array.isArray(asRes.prefixes)) {
        prefixCount = asRes.prefixes.length;
        for (const route of asRes.prefixes) {
          try {
            prefixesIPv4Count += numHostsInNet(route);
          } catch (error) {
            log('Failed to count hosts for ASN route', route, error.message, 'ERROR');
          }
        }
      }
      if (!(key in asnThreatScoreData)) {
        const count = prefixesIPv4Count || 1;
        const extra = [
          asRes?.org || entry?.domain || entry?.asname || '-',
          asRes?.domain || entry?.domain || '-',
          spamhausMarker,
          count,
          prefixCount
        ];
        asnThreatScoreData[key] = {
          count,
          abuserCount: count,
          extra
        };
      } else {
        const record = asnThreatScoreData[key];
        const newCount = prefixesIPv4Count || record.count || 1;
        if (!record.count || record.count < newCount) {
          record.count = newCount;
          if (Array.isArray(record.extra) && record.extra.length >= 4) {
            record.extra[3] = record.count;
          }
        } else if (!record.count) {
          record.count = 1;
        }
        record.abuserCount = Math.max(record.abuserCount || 0, record.count || 1);
        if (Array.isArray(record.extra)) {
          if (record.extra.length >= 1 && !record.extra[0] && (asRes?.org || entry?.asname)) {
            record.extra[0] = asRes?.org || entry?.asname;
          }
          if (record.extra.length >= 2 && !record.extra[1] && (asRes?.domain || entry?.domain)) {
            record.extra[1] = asRes?.domain || entry?.domain;
          }
          if (record.extra.length >= 3) {
            record.extra[2] = spamhausMarker;
          }
          if (record.extra.length >= 5 && prefixCount) {
            record.extra[4] = prefixCount;
          }
        }
      }
    }
  } catch (error) {
    log('Failed to process Spamhaus ASN-DROP data', error.message, 'ERROR');
  }

  log(abuserStats);
  let items = computeScore(asnThreatScoreData);
  fs.writeFileSync(ASN_ABUSER_SCORE_FILE, JSON.stringify(Object.fromEntries(items), null, 2));
};

const computeCompanyAbuserScore = async () => {
  const obj = new IPtoBlacklist();
  await obj.loadLookupTable();

  const company = new IPtoCompany();
  await company.loadLookupTable();

  let companyThreatScoreData = {};
  let abuserStats = {
    IPv4: 0,
    IPv6: 0,
  };

  const handleEntry = (netOrIp, obj, type) => {
    if (type === 4) {
      abuserStats.IPv4++;
      const coRes = company.lookup(netOrIp);
      if (coRes?.network) {
        if (!(coRes?.network in companyThreatScoreData)) {
          companyThreatScoreData[coRes?.network] = {
            count: numHostsInNet(coRes?.network),
            abuserCount: 0,
            extra: [coRes?.name, coRes?.domain, coRes?.type],
          };
        }
        companyThreatScoreData[coRes?.network].abuserCount++;
      }
    } else {
      abuserStats.IPv6++;
    }
  };

  obj.abuserLut.iterLut(handleEntry);
  obj.torLut.iterLut(handleEntry);

  log(abuserStats);
  let items = computeScore(companyThreatScoreData);
  fs.writeFileSync(path.join(RAM_DB_DIR, 'CompanyLut/orgAbuserScore.json'), JSON.stringify(Object.fromEntries(items), null, 2));
};

const tagForScore = (score) => {
  const template = `<span class="tag is-success">${score}</span>`;

  if (score === 'Very High') {
    return template.replace('is-success', 'is-danger');
  } else if (score === 'High') {
    return template.replace('is-success', 'is-warning');
  } else if (score === 'High') {
    return template.replace('is-success', 'is-warning');
  } else if (score === 'Elevated') {
    return template.replace('is-success', 'is-warning');
  }

  return template;
};

const getCompanyAbuserHtml = (numNetworks = 5000, minRequiredHostsInNetwork = 16) => {
  let htmlTable = '';
  const abuseData = JSON.parse(fs.readFileSync(path.join(RAM_DB_DIR, 'CompanyLut/orgAbuserScore.json'), 'utf-8'));
  let i = 1;
  for (const network in abuseData) {
    const [score, tag, org, domain, type] = abuseData[network];
    const url = domain ? `<a href="https://${domain}">${org.slice(0, 40)}</a>` : org.slice(0, 45);
    const scoreStr = round(score * 100, 2) + '% abusive';
    const numHosts = numHostsInNet(network);
    if (numHosts < minRequiredHostsInNetwork) {
      continue;
    }
    htmlTable += `<tr>  
      <td>${i}</td>
      <td><a href="https://api.ipapi.is/?q=${firstIpOfNet(network)}">${network}</a></td>
      <td>${numHostsInNet(network)}</td>
      <td>${tagForScore(tag)}</td>
      <td>${scoreStr}</td>
      <td>${url}</td>
      <td><span class="tag" style="color: #fff; background-color: ${getHtmlColorForType(type)}!important">${type || '-'}</span></td>
      </tr>`;
    if (i >= numNetworks) {
      break;
    }
    i++;
  }
  return htmlTable;
};

const getASNAbuserHtml = (numASNs = 1000) => {
  let htmlTable = '';
  const abuseData = JSON.parse(fs.readFileSync(path.join(RAM_DB_DIR, 'AsnLut/asnAbuserScore.json'), 'utf-8'));
  let i = 1;
  for (const asn in abuseData) {
    const [score, tag, org, domain, type, prefixesIPv4Count, prefixesCount] = abuseData[asn];
    const orgName = org || '-';
    const url = domain ? `<a href="https://${domain}">${orgName.slice(0, 40)}</a>` : orgName.slice(0, 35);
    const scoreStr = round(score * 100, 2) + '% abusive';
    htmlTable += `<tr>  
      <td>${i}</td>
      <td><a href="https://api.ipapi.is/?q=${asn}">${asn}</a></td>
      <td>${prefixesIPv4Count} IPs (${prefixesCount} Routes)</td>
      <td>${tagForScore(tag)}</td>
      <td>${scoreStr}</td>
      <td>${url}</td>
      <td><span class="tag" style="color: #fff; background-color: ${getHtmlColorForType(type)}!important">${type || '-'}</span></td>
      </tr>`;
    if (i >= numASNs) {
      break;
    }
    i++;
  }
  return htmlTable;
};

const testNamedVpnLut = async () => {
  const obj = new IPtoBlacklist();
  await obj.loadLookupTable();

  // Test the following IPs (one from each listed network above)
  const lookupIps = [
    '136.23.48.170',
    '136.23.48.172',
    '136.23.50.176',
    '162.120.193.217',
  ];

  for (const ip of lookupIps) {
    const res = obj.lookup(ip);
    console.log(`Lookup for ${ip}:`, res, '| namedVpnLut:', obj.namedVpnLut.fastLookup(ip));
  }
};

module.exports = {
  getASNAbuserHtml,
  getCompanyAbuserHtml,
  computeCompanyAbuserScore,
  computeAsnAbuserScore,
  IPtoBlacklist
};

if (require.main === module && process.argv[2] === 'testNamedVpnLut') {
  testNamedVpnLut();
}
