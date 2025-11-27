const { FastLut, ON_MULTI_ALL } = require('./fast_lut');
const { normalizeName, log } = require('./utils');
const { isIPv4Cidr,
  isIPv6Cidr, isIPv4Inetnum, isIPv6Inetnum, numHostsInNet } = require('ip_address_tools');
const bigInt = require("big-integer");

class IPtoDatacenter {
  constructor() {
    this.normNames = new Set();
    this.hostingLut = new FastLut('HostingLut', ON_MULTI_ALL);
    this.hostingLut.verbose = false;
  }

  async loadLookupTable() {
    this.hostingLut.loadPersistedLut();
    return Promise.resolve();
  }

  handleLookupResult(resValue) {
    if (Array.isArray(resValue)) {
      let [company, network, domain] = resValue;
      let obj = {
        datacenter: company,
        domain: domain ? domain : undefined,
        network: network,
      };
      if (!obj.domain) {
        delete obj.domain;
      }
      return obj;
    } else if (resValue !== null && typeof resValue === 'object') {
      return resValue;
    }
  }

  lookup(ip, returnAllNets = false) {
    // lookup datacenter information for this IP
    let datacenterLookup = this.hostingLut.fastLookup(ip);
    if (Array.isArray(datacenterLookup)) {
      let retval = [];
      for (let obj of datacenterLookup) {
        retval.push(this.handleLookupResult(obj));
      }
      if (returnAllNets) {
        // return all nets
        return retval;
      } else {
        // return smallest
        if (retval.length > 0) {
          return retval[0];
        }
      }
    } else if (datacenterLookup) {
      log(`datacenterLookup does not return an array for query: ${ip}: ${datacenterLookup}`, 'ERROR');
    }
  }

  /**
   * Print IPv4 / IPv6 statistics for all datacenters in the database.
   */
  ipSpaceSummary(print = true, summary = false, markdownSummary = false, addNetworks = false) {
    if (this.dcStats && summary === false && markdownSummary === false) {
      return this.dcStats
    }
    let self = this;
    let dcStats = {};

    this.hostingLut.iterLut((network, obj) => {
      let company = null;
      let domain = null;
      if (Array.isArray(obj)) {
        company = obj[0];
        domain = obj[2];
      } else if (obj) {
        company = obj.datacenter;
      }
      if (company && network) {
        self.addDatacenter(dcStats, company, network, domain, addNetworks);
      }
    });

    if (print) {
      log(JSON.stringify(dcStats, null, 2))
    }

    if (summary) {
      let summary = {
        total_ipv4: 0,
        total_ipv6: 0,
        num_ipv4_nets: 0,
        num_ipv6_nets: 0,
      };

      for (let key in dcStats) {
        summary.total_ipv4 += dcStats[key].total_ipv4;
        summary.total_ipv6 += dcStats[key].total_ipv6;
        summary.num_ipv4_nets += dcStats[key].num_ipv4_nets;
        summary.num_ipv6_nets += dcStats[key].num_ipv6_nets;
      }

      if (markdownSummary) {
        let md = '';

        md += `| **Total Tracked Hosting Providers**         |    **[${Object.keys(dcStats).length} hosting providers]({filename}/pages/datacenters.md)**      |\n`;
        md += `| **Number of Ipv4 Addresses**         |    **${summary.num_ipv4_nets.toLocaleString('en-US')}** IPv4 CIDR ranges (${summary.total_ipv4.toLocaleString('en-US')} Addresses in total)      |\n`
        md += `| **Number of Ipv6 Addresses**         |    **${summary.num_ipv6_nets.toLocaleString('en-US')}** IPv6 CIDR ranges (${summary.total_ipv6} Addresses in total)      |`

        return md;
      }

      return summary;
    }

    this.dcStats = dcStats;
    return dcStats;
  }

  addDatacenter(stats, company, network, domain, addNetworks = false) {
    // clean
    if (company.startsWith('The activity you have detected originates from a dynamic hosting environment.')) {
      company = 'Amazon AWS';
    }

    if (!stats[company]) {
      let normName = normalizeName(company);
      if (this.normNames.has(normName.toLowerCase().trim())) {
        normName = normName + '-2';
      } else {
        this.normNames.add(normName.toLowerCase().trim());
      }
      stats[company] = {
        company: company,
        name: normName,
        total_ipv4: 0,
        total_ipv6: bigInt(0),
        num_ipv4_nets: 0,
        num_ipv6_nets: 0,
        domain: domain,
        url: this.getDatacenterUrl(company, false, domain),
      };
    }

    if (isIPv4Cidr(network)) {
      stats[company].total_ipv4 += numHostsInNet(network);
      stats[company].num_ipv4_nets++;
      if (addNetworks) {
        if (!stats[company].ipv4_networks) {
          stats[company].ipv4_networks = [];
        }
        stats[company].ipv4_networks.push(network);
      }
    } else if (isIPv6Cidr(network)) {
      let numHosts = numHostsInNet(network);
      if (typeof numHosts === 'object') {
        stats[company].total_ipv6 = stats[company].total_ipv6.plus(numHosts);
      }
      stats[company].num_ipv6_nets++;
      if (addNetworks) {
        if (!stats[company].ipv6_networks) {
          stats[company].ipv6_networks = [];
        }
        stats[company].ipv6_networks.push(network);
      }
    } else if (isIPv4Inetnum(network)) {
      stats[company].total_ipv4 += numHostsInNet(network);
      stats[company].num_ipv4_nets++;
      if (addNetworks) {
        if (!stats[company].ipv4_networks) {
          stats[company].ipv4_networks = [];
        }
        stats[company].ipv4_networks.push(network);
      }
    } else if (isIPv6Inetnum(network)) {
      let numHosts = numHostsInNet(network);
      if (typeof numHosts === 'object') {
        stats[company].total_ipv6 = stats[company].total_ipv6.plus(numHosts);
      }
      stats[company].num_ipv6_nets++;
      if (addNetworks) {
        if (!stats[company].ipv6_networks) {
          stats[company].ipv6_networks = [];
        }
        stats[company].ipv6_networks.push(network);
      }
    }
  }

  getDatacenterUrl(dc, markdown = false, domain = null) {
    if (!this.datacenters) {
      this.datacenters = require('../datacenterList/finalMerged.json');
    }
    let url = null;
    if (this.datacenters[dc] && this.datacenters[dc].website) {
      url = this.datacenters[dc].website;
    }

    if (domain) {
      if (domain.startsWith('http')) {
        url = domain;
      } else {
        url = `https://${domain}`;
      }
    }

    if (markdown) {
      return `[${dc}](${url})`
    } else {
      return url;
    }
  }

  getHtmlDataCenterInfoTable(minIPv4Hosts = 256, limit = null, addNetworks = false, overviewTable = false) {
    let data = this.ipSpaceSummary(false, false, false, addNetworks);
    let filteredData = [];
    let newData = [];

    for (let dc in data) {
      if (data[dc].total_ipv4 > minIPv4Hosts) {
        filteredData.push([dc, data[dc].total_ipv4]);
      }
    }

    // Sort the array based on total_ipv4
    filteredData.sort(function (first, second) {
      return second[1] - first[1];
    });

    if (Number.isInteger(limit)) {
      filteredData = filteredData.slice(0, limit);
    }

    let num = 0;
    let html = '';
    let rank = 1;
    for (let item of filteredData) {
      let cop = data[item[0]];
      cop.hostingRank = rank++;
      newData.push(cop);

      num++;
      let providerName = item[0];
      const detailUrl = `/hosting/${normalizeName(providerName)}.html`;
      let urlStr = data[providerName].url ? `<a href="${data[providerName].url}">${providerName}</a>` : providerName;

      if (overviewTable) {
        html += `<tr id="hosting-rank-${num}">
        <td><a href="${detailUrl}">${num}</a></td>
        <td><a href="${detailUrl}">${providerName}</a></td>
        <td>${data[providerName].total_ipv4.toLocaleString()}</td>
        <td>${data[providerName].num_ipv4_nets.toLocaleString()}</td>
        <td>${data[providerName].num_ipv6_nets.toLocaleString()}</td>
      </tr>`;
      } else {
        html += `<tr id="hosting-rank-${num}">
        <td><a href="${detailUrl}">${num}</a></td>
        <td><a href="${detailUrl}">${providerName}</a></td>
        <td>
          <a href="${detailUrl}" class="tag">
            <span class="icon is-small is-dark">
              <i class="fas fa-cloud-arrow-up"></i>
            </span>
            <span>Hosting IP Ranges</span>
          </a>
        </td>
        <td>${data[providerName].total_ipv4.toLocaleString()}</td>
        <td>${data[providerName].num_ipv4_nets.toLocaleString()}</td>
        <td>${data[providerName].num_ipv6_nets.toLocaleString()}</td>
      </tr>`;
      }
    }

    return [html, newData];
  }

  getMarkdownDataCenterInfoTable(minIPv4Hosts = 256) {
    let data = this.ipSpaceSummary(false);
    let items = [];

    for (let dc in data) {
      if (data[dc].total_ipv4 > minIPv4Hosts)
        items.push([dc, data[dc].total_ipv4])
    }

    // Sort the array based on the second element
    items.sort(function (first, second) {
      return second[1] - first[1];
    });

    let table = '| # | Hosting Provider | Number of IPv4 Addresses | Number of IPv4 Ranges | Number of IPv6 Ranges|\n';
    table += '|------------|------------|------------|------------|------------|\n';

    let num = 0;
    for (let item of items) {
      num++;
      let dc = item[0];
      let url = this.getDatacenterUrl(dc, true, data[dc].domain);
      if (url) {
        table += '|' + num + '| ' + url + ' | ' + data[dc].total_ipv4.toLocaleString() + ' | ' + data[dc].num_ipv4_nets.toLocaleString() + ' | ' + data[dc].num_ipv6_nets.toLocaleString() + ' | ' + '\n';
      }
    }

    return table;
  }

}

module.exports = {
  IPtoDatacenter,
};
