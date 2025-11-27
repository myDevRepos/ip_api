const { round, absPath, sleep, calculateStatistics, executeCommandSync, log } = require('./utils');
const { getRandomIPs, getRandomIPv6Addresses, getRandomIPv4 } = require('ip_address_tools');
const { testFastLookupTable, simpleLutTests } = require('./test_fast_lookup_table');
const { testPicksTheCorrectOrganization } = require('./company');
const { IPtoLocation } = require('./geolocation');
const { API_ERROR_CODE } = require('./ipapi_is_worker_utils');
const child_process = require("child_process");
const axios = require('axios');
const fs = require('fs');
const path = require('path');
const EventEmitter = require('events');
const testApiKey = 'testKey';
const defaultUserApiKey = 'edff309097c99c2e';

// Set log level
process.env.LOG_LEVEL = 3;

const {
  DATA_ROOT,
  MAX_DYNAMIC_SAMPLES,
  TestReporter,
  isRecentFile,
  getRecentFiles,
  selectRandomItems,
  parseRangeToIPs,
  normalizeTestIP,
  collectIPsFromFile,
  loadVpnEntries,
  formatAxiosError,
  summarizeAxiosResponse,
  logTestFail,
  extractRequestUrl,
} = require('./functional_test_utils');


/**
 * Launch the API over the terminal and wait until we see the string that the API is loaded
 * The reason why the API is started this crude, is that the tests should really target the API 
 * as it is running in production.
 * @returns 
 */
async function launchAPI(configPath) {
  return new Promise((resolve) => {
    try {
      fs.truncateSync(path.join(__dirname, './../log/ipapi_debug.log'), 0);
      fs.truncateSync(path.join(__dirname, './../log/ipapi.log'), 0);
    } catch (err) {
      log(err, 'ERROR');
    }
    const confPath = fs.existsSync(configPath) ? configPath : path.join(__dirname, './../config/test-config-cu.json');
    const apiCommand = `node --max-old-space-size=20000 ipapi_is_worker.js ${confPath}`;
    log(`Launching API with command: ${apiCommand}`);
    const childProc = child_process.exec(apiCommand, { cwd: absPath('./') });

    // listen on child process stdout
    childProc.stdout.on("data", (chunk) => {
      log(chunk.trim())
      if (chunk.includes('Loading ipapi.is took')) {
        return resolve(true);
      }
    });

    childProc.stderr.on("data", (errChunk) => {
      log(errChunk)
    });

    childProc.on("error", (err) => {
      log(err, 'ERROR');
      return resolve(false);
    });

    childProc.on("close", (err) => {
      log('closed process');
      return resolve(false);
    });
  });
}

/**
 * Example url: http://localhost:3899/?q=32.34.3.22
 * 
 * @param {*} query 
 */
async function APIRequest(query, perf = false, debug = false, moreQueryArgs = {}, suppressErrorLog = false) {
  try {
    let url = `http://localhost:3899/?q=${query}&key=${defaultUserApiKey}`;
    if (perf) {
      url += '&perf=1';
    }
    if (debug) {
      url += '&debug=1';
    }
    for (const [key, value] of Object.entries(moreQueryArgs)) {
      url += `&${key}=${value}`;
    }
    const apiOutput = await axios.get(url);
    return apiOutput.data;
  } catch (err) {
    if (!suppressErrorLog) {
      log(`[APIRequest][error] query=${query} ${formatAxiosError(err)}`, 'ERROR');
    }
    return err.response;
  }
}

async function bulkAPIRequest(ips) {
  try {
    const url = `http://localhost:3899/?key=${testApiKey}`;
    const json = JSON.stringify({ ips: ips });
    let apiOutput = await axios.post(url, json, {
      headers: {
        'Content-Type': 'application/json'
      }
    });
    return apiOutput.data;
  } catch (err) {
    log(`[bulkAPIRequest][error] ${formatAxiosError(err)}`, 'ERROR');
    return err.response;
  }
}

/**
 * 
 * @param {*} myTime "2023-03-31T05:52:25-07:00"
 * @param {*} realTime "2023-03-31 05:52:25.989-0700"
 */
function sameTime(myTime, realTime) {
  if (!myTime || !realTime) return false;
  realTime = realTime.replace(/(\.\d+)/g, '');
  myTime = myTime.replace('T', ' ');
  myTime = myTime.split('').reverse().join('').replace(':', '').split('').reverse().join('');

  let parts1 = realTime.split(' ');
  let parts2 = myTime.split(' ');

  // log(parts1[0], parts2[0])

  if (parts1[0] !== parts2[0]) {
    return false;
  }

  let sub1 = parts1[1].split(':').slice(0, 2).join(':');
  let sub2 = parts2[1].split(':').slice(0, 2).join(':');

  // log(sub1, sub2)

  if (sub1 !== sub2) {
    return false;
  }

  return true;
}

async function sameTimeAsCompetition() {
  const geolocObj = new IPtoLocation();
  await geolocObj.loadGeolocation();
  // geolocation time tests
  for (const ip of getRandomIPs(50)) {
    await sleep(500);
    let res = geolocObj.lookup(ip);
    let cres = await competitionAPIRequest(ip);
    if (cres && cres.time_zone && cres.time_zone.current_time_unix && res) {
      let realTime = cres.time_zone.current_time;
      let myTime = res.local_time;
      if (sameTime(myTime, realTime)) {
        log(`[IP Time] test passed`, ip);
      } else {
        log(`[IP Time] test failed, own (${myTime}), competitor (${realTime})`, ip);
        log(`own (${res.country}, ${res.city}), competitor (${cres.country_code2}, ${cres.city})`);
      }
    }
  }
}

const testApiCorrectlyRoutes = async () => {
  const { servers } = require('my-servers');
  const deServer = servers.filter((server) => server.name === 'main_do')[0];
  const usServer = servers.filter((server) => server.name === 'us_ipapi')[0];
  const sgServer = servers.filter((server) => server.name === 'sg_ipapi')[0];

  const serversToCheck = [
    { server: deServer, expectedIp: '162.55.51.87' },
    { server: usServer, expectedIp: '5.161.181.126' },
    { server: sgServer, expectedIp: '15.235.192.243' }
  ];

  for (const { server, expectedIp } of serversToCheck) {
    const command = `ssh -i ${server.key} ${server.user}@${server.host} 'dig a api.ipapi.is'`;
    const commandOutput = executeCommandSync(command).toString();
    const ipMatch = commandOutput.match(/ANSWER SECTION:\napi\.ipapi\.is\.\s+\d+\s+IN\s+A\s+([\d.]+)/);
    if (ipMatch) {
      const ipAddress = ipMatch[1];
      if (ipAddress === expectedIp) {
        log(`[SUCCESS] IP address from dig on ${server.name} matches expected: ${ipAddress}`);
      } else {
        throw new Error(`[FAILURE] IP address from dig on ${server.name} does not match expected. Got: ${ipAddress}, Expected: ${expectedIp}`);
      }
    } else {
      throw new Error(`[FAILURE] Failed to parse IP address from dig output on ${server.name}`);
    }
  }
};

/**
 * https://api.ipgeolocation.io/ipgeo?apiKey=ee1a9196f5ce47998388f04cadbda520&ip=1.2.3.4
 * 
 * @param {*} query 
 * @param {*} perf 
 * @returns 
 */
async function competitionAPIRequest(query) {
  try {
    const key = 'ee1a9196f5ce47998388f04cadbda520';
    let url = `https://api.ipgeolocation.io/ipgeo?apiKey=${key}&ip=${query}`;
    let apiOutput = await axios.get(url);
    return apiOutput.data;
  } catch (err) {
    log(`[competitionAPIRequest][error] query=${query} ${formatAxiosError(err)}`, 'ERROR');
    return false;
  }
}

async function stressTest(N = 150) {
  // Send N API requests at the same time and see what happens
  let manyIPs = JSON.parse(fs.readFileSync(absPath('../test/manyIps.json')).toString());
  let ips = Object.keys(manyIPs).slice(0, 1500);
  let failed = false;
  // test the distribution of PID's
  let pidHist = {};
  for (let i = 0; i < Math.floor(ips.length / N); i++) {
    let promises = [];
    let startIndex = (i * N);
    let stopIndex = ((i + 1) * N);
    for (let j = startIndex; j <= stopIndex; j++) {
      promises.push(APIRequest(ips[j], false, true));
    }
    let results = await Promise.all(promises);
    // sum how much it took in total
    let totalElapsed = results.map((obj) => obj.elapsed_ms).reduce((a, b) => a + b, 0);
    let average = round(totalElapsed / N, 2);
    log(`Stress test over ${promises.length} concurrent API requests took on average ${average}ms`);
    if (average > 10) {
      failed = true;
    }
    results.map((obj) => {
      if (!pidHist[obj.pid]) {
        pidHist[obj.pid] = 0;
      }
      pidHist[obj.pid]++;
    });
  }
  if (failed === false) {
    log(`[StressTest] test passed ${JSON.stringify(pidHist)}`)
  } else {
    log(`[StressTest] test failed ${JSON.stringify(pidHist)}`);
  }
}

/**
 * Test that special options passed to the API are work as intended
 */
async function specialQueryTests() {
  // test specialized API commands
  const normalIp = '204.29.129.57';
  const hasMoreThanOneOrg = '195.243.107.86';
  const hasMoreThanOneHosting = '172.207.101.151';

  // Test for debug=1
  const resDebug = await APIRequest(normalIp, false, false, { debug: 1 });
  if (resDebug.pid && !isNaN(resDebug.pid) && resDebug.cached === false) {
    log(`[query debug=1] test passed`);
  } else {
    logTestFail('query debug=1', {
      input: normalIp,
      url: extractRequestUrl(resDebug, `http://localhost:3899/?q=${normalIp}&key=${testApiKey}&debug=1`),
      details: 'unexpected debug response',
    });
  }

  // Test for perf=1
  const resPerf = await APIRequest(normalIp, false, false, { perf: 1, debug: 1 });
  if (resPerf.perf && typeof resPerf.perf === 'object' && resPerf.cached === false) {
    const expectedKeys = [
      "bogonTest", "asnLookup", "companyLookup", "datacenterLookup",
      "mobileLookup", "crawlerLookup", "geolocLookup",
      "blacklistLookup", "customListLookup"
    ];
    let testPassed = true;
    for (let key of expectedKeys) {
      if (!(key in resPerf.perf) || typeof resPerf.perf[key] !== 'number') {
        testPassed = false;
        break;
      }
    }
    if (testPassed) {
      log(`[query perf=1] test passed`);
    } else {
      logTestFail('query perf=1', {
        input: normalIp,
        url: extractRequestUrl(resPerf, `http://localhost:3899/?q=${normalIp}&key=${testApiKey}&perf=1&debug=1`),
        details: 'perf object missing expected keys',
      });
    }
  } else {
    logTestFail('query perf=1', {
      input: normalIp,
      url: extractRequestUrl(resPerf, `http://localhost:3899/?q=${normalIp}&key=${testApiKey}&perf=1&debug=1`),
      details: 'perf response missing',
    });
  }

  // Test for all_companies=1
  const resAllCompanies = await APIRequest(hasMoreThanOneOrg, false, false, { all_companies: 1, debug: 1 });
  if (resAllCompanies.company && Array.isArray(resAllCompanies.company) && resAllCompanies.company.length >= 2 && resAllCompanies.cached === false) {
    const companyNames = resAllCompanies.company.map(company => company.name);
    const uniqueCompanyNames = new Set(companyNames);
    if (uniqueCompanyNames.size === companyNames.length) {
      log(`[query all_companies=1] test passed`);
    } else {
      logTestFail('query all_companies=1', {
        input: hasMoreThanOneOrg,
        url: extractRequestUrl(resAllCompanies, `http://localhost:3899/?q=${hasMoreThanOneOrg}&key=${testApiKey}&all_companies=1&debug=1`),
        details: 'company names not distinct',
      });
    }
  } else {
    logTestFail('query all_companies=1', {
      input: hasMoreThanOneOrg,
      url: extractRequestUrl(resAllCompanies, `http://localhost:3899/?q=${hasMoreThanOneOrg}&key=${testApiKey}&all_companies=1&debug=1`),
      details: 'unexpected response',
    });
  }

  // Test for all_datacenters=1
  const resAllDatacenters = await APIRequest(hasMoreThanOneHosting, false, false, { all_datacenters: 1, debug: 1 });
  if (resAllDatacenters.datacenter && Array.isArray(resAllDatacenters.datacenter) && resAllDatacenters.datacenter.length >= 2 && resAllDatacenters.cached === false) {
    log(`[query all_datacenters=1] test passed`);
  } else {
    logTestFail('query all_datacenters=1', {
      input: hasMoreThanOneHosting,
      url: extractRequestUrl(resAllDatacenters, `http://localhost:3899/?q=${hasMoreThanOneHosting}&key=${testApiKey}&all_datacenters=1&debug=1`),
      details: 'unexpected response',
    });
  }
}

async function testMobileDataset() {
  const mobileFile = path.join(DATA_ROOT, 'mobile_data', 'mobileNetworks.txt');
  if (!isRecentFile(mobileFile)) {
    log(`[dynamicMobile][skip] mobileNetworks.txt not recent or missing`);
    return;
  }
  const ips = await collectIPsFromFile(mobileFile, MAX_DYNAMIC_SAMPLES * 4);
  if (ips.length === 0) {
    log(`[dynamicMobile][skip] no IPs found in recent dataset`);
    return;
  }
  const sampleIps = selectRandomItems(ips, Math.min(MAX_DYNAMIC_SAMPLES, ips.length));
  for (const ip of sampleIps) {
    const res = await APIRequest(ip, false, false, { debug: 1 });
    if (res && res.is_mobile === true) {
      log(`[dynamicMobile] test passed`, ip);
    } else {
      logTestFail('dynamicMobile', {
        input: ip,
        url: extractRequestUrl(res, `http://localhost:3899/?q=${ip}&key=${testApiKey}&debug=1`),
        details: `is_mobile=${res && res.is_mobile}`,
      });
    }
  }
}

async function testCrawlerDataset() {
  const baseDir = path.join(DATA_ROOT, 'crawler_data');
  const subDirs = ['fromHttpLogs', 'fromUrl'];
  for (const subDir of subDirs) {
    const dirPath = path.join(baseDir, subDir);
    const files = getRecentFiles(dirPath);
    if (files.length === 0) {
      log(`[dynamicCrawler][${subDir}][skip] no recent files`);
      continue;
    }
    const sampleFiles = selectRandomItems(files, Math.min(MAX_DYNAMIC_SAMPLES, files.length));
    for (const filePath of sampleFiles) {
      const expectedCrawler = path.basename(filePath);
      const ips = await collectIPsFromFile(filePath, MAX_DYNAMIC_SAMPLES * 4);
      if (ips.length === 0) {
        log(`[dynamicCrawler][${expectedCrawler}][skip] no IPs`);
        continue;
      }
      const sampleIps = selectRandomItems(ips, Math.min(MAX_DYNAMIC_SAMPLES, ips.length));
      for (const ip of sampleIps) {
        const res = await APIRequest(ip, false, false, { debug: 1 });
        const crawlerValue = res && res.is_crawler;
        const matches = typeof crawlerValue === 'string'
          ? crawlerValue.toLowerCase() === expectedCrawler.toLowerCase()
          : crawlerValue === true;
        if (matches) {
          log(`[dynamicCrawler][${expectedCrawler}] test passed`, ip);
        } else {
          logTestFail(`dynamicCrawler][${expectedCrawler}`, {
            input: ip,
            url: extractRequestUrl(res, `http://localhost:3899/?q=${ip}&key=${testApiKey}&debug=1`),
            details: `is_crawler=${crawlerValue}`,
          });
        }
      }
    }
  }
}

async function testTorDataset() {
  const torDir = path.join(DATA_ROOT, 'tor_data');
  const files = getRecentFiles(torDir);
  if (files.length === 0) {
    log(`[dynamicTor][skip] no recent files`);
    return;
  }
  const sampleFiles = selectRandomItems(files, Math.min(MAX_DYNAMIC_SAMPLES, files.length));
  for (const filePath of sampleFiles) {
    const label = path.basename(filePath);
    const ips = await collectIPsFromFile(filePath, MAX_DYNAMIC_SAMPLES * 4);
    if (ips.length === 0) {
      log(`[dynamicTor][${label}][skip] no IPs`);
      continue;
    }
    const sampleIps = selectRandomItems(ips, Math.min(MAX_DYNAMIC_SAMPLES, ips.length));
    for (const ip of sampleIps) {
      const res = await APIRequest(ip, false, false, { debug: 1 });
      if (res && res.is_tor === true) {
        log(`[dynamicTor][${label}] test passed`, ip);
      } else {
        logTestFail(`dynamicTor][${label}`, {
          input: ip,
          url: extractRequestUrl(res, `http://localhost:3899/?q=${ip}&key=${testApiKey}&debug=1`),
          details: `is_tor=${res && res.is_tor}`,
        });
      }
    }
  }
}

async function testProxyDataset() {
  const proxyFile = path.join(DATA_ROOT, 'proxy_data', 'proxyIpsUs.txt');
  if (!isRecentFile(proxyFile)) {
    log(`[dynamicProxy][skip] proxyIpsUs.txt not recent or missing`);
    return;
  }
  const ips = await collectIPsFromFile(proxyFile, MAX_DYNAMIC_SAMPLES * 4);
  if (ips.length === 0) {
    log(`[dynamicProxy][skip] no IPs available`);
    return;
  }
  const sampleIps = selectRandomItems(ips, Math.min(MAX_DYNAMIC_SAMPLES, ips.length));
  for (const ip of sampleIps) {
    const res = await APIRequest(ip, false, false, { debug: 1 });
    if (res && res.is_proxy === true) {
      log(`[dynamicProxy] test passed`, ip);
    } else {
      logTestFail('dynamicProxy', {
        input: ip,
        url: extractRequestUrl(res, `http://localhost:3899/?q=${ip}&key=${testApiKey}&debug=1`),
        details: `is_proxy=${res && res.is_proxy}`,
      });
    }
  }
}

async function testVpnDataset() {
  const vpnFile = path.join(DATA_ROOT, 'vpn_data', 'allVpnData.json');
  if (!isRecentFile(vpnFile)) {
    log(`[dynamicVPN][skip] allVpnData.json not recent or missing`);
    return;
  }
  const entries = loadVpnEntries(vpnFile, MAX_DYNAMIC_SAMPLES * 4);
  if (entries.length === 0) {
    log(`[dynamicVPN][skip] no VPN entries available`);
    return;
  }
  const sampleEntries = selectRandomItems(entries, Math.min(MAX_DYNAMIC_SAMPLES, entries.length));
  for (const entry of sampleEntries) {
    const res = await APIRequest(entry.ip, false, false, { debug: 1 });
    if (res && res.is_vpn === true) {
      log(`[dynamicVPN][${entry.service}] test passed`, entry.ip);
    } else {
      logTestFail(`dynamicVPN][${entry.service}`, {
        input: entry.ip,
        url: extractRequestUrl(res, `http://localhost:3899/?q=${entry.ip}&key=${testApiKey}&debug=1`),
        details: `is_vpn=${res && res.is_vpn}`,
      });
    }
  }
}

async function testAbuserDataset() {
  const blocklistDir = path.join(DATA_ROOT, 'blocklist_data');
  const files = getRecentFiles(blocklistDir).filter((filePath) => !filePath.endsWith('.zip'));
  if (files.length === 0) {
    log(`[dynamicAbuser][skip] no recent blocklist files`);
    return;
  }
  const sampleFiles = selectRandomItems(files, Math.min(MAX_DYNAMIC_SAMPLES, files.length));
  for (const filePath of sampleFiles) {
    const label = path.basename(filePath);
    const ips = await collectIPsFromFile(filePath, MAX_DYNAMIC_SAMPLES * 4);
    if (ips.length === 0) {
      log(`[dynamicAbuser][${label}][skip] no IPs`);
      continue;
    }
    const sampleIps = selectRandomItems(ips, Math.min(MAX_DYNAMIC_SAMPLES, ips.length));
    for (const ip of sampleIps) {
      const res = await APIRequest(ip, false, false, { debug: 1 });
      if (res && res.is_abuser === true) {
        log(`[dynamicAbuser][${label}] test passed`, ip);
      } else {
        logTestFail(`dynamicAbuser][${label}`, {
          input: ip,
          url: extractRequestUrl(res, `http://localhost:3899/?q=${ip}&key=${testApiKey}&debug=1`),
          details: `is_abuser=${res && res.is_abuser}`,
        });
      }
    }
  }
}

async function testDatacenterDataset() {
  const hostingFile = path.join(DATA_ROOT, 'hosting_data', 'hostingRanges.tsv');
  if (!isRecentFile(hostingFile)) {
    log(`[dynamicDatacenter][skip] hostingRanges.tsv not recent or missing`);
    return;
  }
  let entries = [];
  try {
    const raw = fs.readFileSync(hostingFile, 'utf8');
    const lines = raw.split(/\r?\n/);
    for (const line of lines) {
      if (!line.trim()) {
        continue;
      }
      const parts = line.split('\t');
      if (parts.length < 2) {
        continue;
      }
      const provider = parts[0].trim();
      const range = parts[1].trim();
      const ips = parseRangeToIPs(range);
      if (provider && ips.length > 0) {
        entries.push({ provider, ip: normalizeTestIP(ips[0]) });
      }
    }
  } catch (err) {
    entries = [];
  }
  if (entries.length === 0) {
    log(`[dynamicDatacenter][skip] no entries found`);
    return;
  }
  const sampleEntries = selectRandomItems(entries, Math.min(MAX_DYNAMIC_SAMPLES, entries.length));
  for (const entry of sampleEntries) {
    const res = await APIRequest(entry.ip, false, false, { debug: 1 });
    if (res && res.is_datacenter === true) {
      log(`[dynamicDatacenter][${entry.provider}] test passed`, entry.ip);
    } else {
      logTestFail(`dynamicDatacenter][${entry.provider}`, {
        input: entry.ip,
        url: extractRequestUrl(res, `http://localhost:3899/?q=${entry.ip}&key=${testApiKey}&debug=1`),
        details: `is_datacenter=${res && res.is_datacenter}`,
      });
    }
  }
}

async function testBogonDataset() {
  const bogonIPs = ['10.10.10.10', '172.16.8.1', '192.168.50.10', 'fc00::1234'];
  const samples = selectRandomItems(bogonIPs, Math.min(MAX_DYNAMIC_SAMPLES, bogonIPs.length));
  for (const ip of samples) {
    const res = await APIRequest(ip, false, false, { debug: 1 });
    if (res && res.is_bogon === true) {
      log(`[dynamicBogon] test passed`, ip);
    } else {
      logTestFail('dynamicBogon', {
        input: ip,
        url: extractRequestUrl(res, `http://localhost:3899/?q=${ip}&key=${testApiKey}&debug=1`),
        details: `is_bogon=${res && res.is_bogon}`,
      });
    }
  }
}

async function runDynamicDatasetTests() {
  await testMobileDataset();
  await testCrawlerDataset();
  await testTorDataset();
  await testProxyDataset();
  await testVpnDataset();
  await testAbuserDataset();
  await testDatacenterDataset();
  await testBogonDataset();
}

async function httpVariantTests() {
  const baseIp = '8.8.8.8';
  const baseGetUrl = `http://localhost:3899/?q=${baseIp}&key=${testApiKey}`;
  try {
    const res = await axios.get(baseGetUrl, {
      headers: {
        'X-Strange-Header': 'functional-tests',
        'Accept': 'application/xml',
        'Cache-Control': 'no-store'
      }
    });
    if (res.status === 200 && res.data && res.data.ip === baseIp) {
      log(`[unexpectedHeaders] test passed`);
    } else {
      logTestFail('unexpectedHeaders', {
        input: baseIp,
        url: baseGetUrl,
        details: `response=${summarizeAxiosResponse(res)}`,
      });
    }
  } catch (err) {
    logTestFail('unexpectedHeaders', {
      input: baseIp,
      url: baseGetUrl,
      details: `error=${formatAxiosError(err)}`,
    });
  }

  const formBody = new URLSearchParams({ ips: '1.1.1.1,8.8.8.8' }).toString();
  let formResponse;
  try {
    formResponse = await axios.post(`http://localhost:3899/?key=${testApiKey}`, formBody, {
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded'
      }
    });
  } catch (err) {
    if (err.response) {
      formResponse = err.response;
    } else {
      logTestFail('nonJsonPost', {
        input: '1.1.1.1,8.8.8.8',
        url: `http://localhost:3899/?key=${testApiKey}`,
        details: `error=${formatAxiosError(err)}`,
      });
    }
  }
  if (formResponse) {
    // API now accepts form-encoded data (returns 200 OK)
    if (formResponse.status === 200 || (formResponse.data && formResponse.data.error)) {
      log(`[nonJsonPost] test passed`);
    } else {
      logTestFail('nonJsonPost', {
        input: '1.1.1.1,8.8.8.8',
        url: `http://localhost:3899/?key=${testApiKey}`,
        details: `response=${summarizeAxiosResponse(formResponse)}`,
      });
    }
  }

  try {
    await axios.get('http://localhost:3899/%');
    logTestFail('malformedUrl', {
      input: '%',
      url: 'http://localhost:3899/%',
      details: 'error=unexpected success',
    });
  } catch (err) {
    if (err.response) {
      log(`[malformedUrl] test passed`);
    } else {
      const message = err.message || formatAxiosError(err);
      if (/URI malformed|Invalid URL/i.test(message)) {
        log(`[malformedUrl] test passed`);
      } else {
        logTestFail('malformedUrl', {
          input: '%',
          url: 'http://localhost:3899/%',
          details: `error=${formatAxiosError(err)}`,
        });
      }
    }
  }

  try {
    await axios.get(`http://localhost:3899/?q=1.2.3.4%zz&key=${testApiKey}`);
    logTestFail('encodedQuery', {
      input: '1.2.3.4%zz',
      url: `http://localhost:3899/?q=1.2.3.4%25zz&key=${testApiKey}`,
      details: 'error=unexpected success',
    });
  } catch (err) {
    if (err.response) {
      log(`[encodedQuery] test passed`);
    } else {
      const message = err.message || formatAxiosError(err);
      if (/URI malformed|Invalid URL/i.test(message)) {
        log(`[encodedQuery] test passed`);
      } else {
        logTestFail('encodedQuery', {
          input: '1.2.3.4%zz',
          url: `http://localhost:3899/?q=1.2.3.4%25zz&key=${testApiKey}`,
          details: `error=${formatAxiosError(err)}`,
        });
      }
    }
  }

  try {
    const payload = { ips: ['1.1.1.1'] };
    const res = await axios.post(`http://localhost:3899/?key=${testApiKey}`, JSON.stringify(payload), {
      headers: {
        'Content-Type': 'application/json',
        'X-Unexpected-Header': 'true',
        'Pragma': 'no-cache'
      }
    });
    if (res.status === 200 && res.data && !res.data.error) {
      log(`[unexpectedPostHeaders] test passed`);
    } else {
      logTestFail('unexpectedPostHeaders', {
        input: JSON.stringify(payload),
        url: `http://localhost:3899/?key=${testApiKey}`,
        details: `response=${summarizeAxiosResponse(res)}`,
      });
    }
  } catch (err) {
    logTestFail('unexpectedPostHeaders', {
      input: JSON.stringify(payload),
      url: `http://localhost:3899/?key=${testApiKey}`,
      details: `error=${formatAxiosError(err)}`,
    });
  }

  // Test POST with q parameter in URL and API key in body (no ips param)
  try {
    const testIp = '8.8.8.8';
    const payload = { key: testApiKey };
    const res = await axios.post(`http://localhost:3899/?q=${testIp}`, JSON.stringify(payload), {
      headers: {
        'Content-Type': 'application/json'
      }
    });
    if (res.status === 200 && res.data && res.data.ip === testIp && !res.data.error) {
      log(`[postWithQParamAndKeyInBody] test passed`);
    } else {
      logTestFail('postWithQParamAndKeyInBody', {
        input: testIp,
        url: `http://localhost:3899/?q=${testIp}`,
        details: `response=${summarizeAxiosResponse(res)}`,
      });
    }
  } catch (err) {
    logTestFail('postWithQParamAndKeyInBody', {
      input: '8.8.8.8',
      url: `http://localhost:3899/?q=8.8.8.8`,
      details: `error=${formatAxiosError(err)}`,
    });
  }
}

/**
 * Test API parameter behavior according to API_BEHAVIOR.md
 */
async function testApiParameterBehavior() {
  const testIp = '219.12.61.69';

  // Test 1: Pure POST (both q and key in body)
  try {
    const res = await axios.post('http://localhost:3899/', JSON.stringify({ q: testIp, key: testApiKey }), {
      headers: { 'Content-Type': 'application/json' }
    });
    if (res.status === 200 && res.data && res.data.ip === testIp) {
      log(`[paramBehavior:purePost] test passed`);
    } else {
      logTestFail('paramBehavior:purePost', { input: testIp, url: 'POST /', details: `response=${summarizeAxiosResponse(res)}` });
    }
  } catch (err) {
    logTestFail('paramBehavior:purePost', { input: testIp, url: 'POST /', details: `error=${formatAxiosError(err)}` });
  }

  // Test 2: Pure GET (both q and key in query)
  try {
    const res = await axios.get(`http://localhost:3899/?q=${testIp}&key=${testApiKey}`);
    if (res.status === 200 && res.data && res.data.ip === testIp) {
      log(`[paramBehavior:pureGet] test passed`);
    } else {
      logTestFail('paramBehavior:pureGet', { input: testIp, url: `/?q=${testIp}&key=${testApiKey}`, details: `response=${summarizeAxiosResponse(res)}` });
    }
  } catch (err) {
    logTestFail('paramBehavior:pureGet', { input: testIp, url: `/?q=${testIp}&key=${testApiKey}`, details: `error=${formatAxiosError(err)}` });
  }

  // Test 3: POST q in body, key in query
  try {
    const res = await axios.post(`http://localhost:3899/?key=${testApiKey}`, JSON.stringify({ q: testIp }), {
      headers: { 'Content-Type': 'application/json' }
    });
    if (res.status === 200 && res.data && res.data.ip === testIp) {
      log(`[paramBehavior:postQGetKey] test passed`);
    } else {
      logTestFail('paramBehavior:postQGetKey', { input: testIp, url: `POST /?key=${testApiKey}`, details: `response=${summarizeAxiosResponse(res)}` });
    }
  } catch (err) {
    logTestFail('paramBehavior:postQGetKey', { input: testIp, url: `POST /?key=${testApiKey}`, details: `error=${formatAxiosError(err)}` });
  }

  // Test 4: POST key in body, q in query
  try {
    const res = await axios.post(`http://localhost:3899/?q=${testIp}`, JSON.stringify({ key: testApiKey }), {
      headers: { 'Content-Type': 'application/json' }
    });
    if (res.status === 200 && res.data && res.data.ip === testIp) {
      log(`[paramBehavior:postKeyGetQ] test passed`);
    } else {
      logTestFail('paramBehavior:postKeyGetQ', { input: testIp, url: `POST /?q=${testIp}`, details: `response=${summarizeAxiosResponse(res)}` });
    }
  } catch (err) {
    logTestFail('paramBehavior:postKeyGetQ', { input: testIp, url: `POST /?q=${testIp}`, details: `error=${formatAxiosError(err)}` });
  }

  // Test 5: POST takes precedence - wrong key in POST should fail
  try {
    const res = await axios.post(`http://localhost:3899/?key=${testApiKey}`, JSON.stringify({ q: testIp, key: 'wrongKey' }), {
      headers: { 'Content-Type': 'application/json' }
    });
    const errorCode = res.data && res.data.error_code;
    if (errorCode === API_ERROR_CODE.INVALID_API_KEY || errorCode === API_ERROR_CODE.API_KEY_MISSING) {
      log(`[paramBehavior:postPrecedence] test passed`);
    } else {
      logTestFail('paramBehavior:postPrecedence', { input: 'wrongKey', url: `POST /?key=${testApiKey}`, details: `expected auth error, got response=${summarizeAxiosResponse(res)}` });
    }
  } catch (err) {
    if (err.response) {
      const errorCode = err.response.data && err.response.data.error_code;
      if (errorCode === API_ERROR_CODE.INVALID_API_KEY || errorCode === API_ERROR_CODE.API_KEY_MISSING) {
        log(`[paramBehavior:postPrecedence] test passed`);
      } else {
        logTestFail('paramBehavior:postPrecedence', { input: 'wrongKey', url: `POST /?key=${testApiKey}`, details: `expected auth error, got response=${summarizeAxiosResponse(err.response)}` });
      }
    } else {
      logTestFail('paramBehavior:postPrecedence', { input: 'wrongKey', url: `POST /?key=${testApiKey}`, details: `error=${formatAxiosError(err)}` });
    }
  }

  // Test 6-8: API key variants (apiKey, api_key, key) - case insensitive
  for (const keyParam of ['apiKey', 'APIKEY', 'api_key', 'API_KEY', 'key', 'KEY']) {
    try {
      const res = await axios.get(`http://localhost:3899/?q=${testIp}&${keyParam}=${testApiKey}`);
      if (res.status === 200 && res.data && res.data.ip === testIp) {
        log(`[paramBehavior:keyVariant:${keyParam}] test passed`);
      } else {
        logTestFail(`paramBehavior:keyVariant:${keyParam}`, { input: testIp, url: `/?q=${testIp}&${keyParam}=${testApiKey}`, details: `response=${summarizeAxiosResponse(res)}` });
      }
    } catch (err) {
      logTestFail(`paramBehavior:keyVariant:${keyParam}`, { input: testIp, url: `/?q=${testIp}&${keyParam}=${testApiKey}`, details: `error=${formatAxiosError(err)}` });
    }
  }

  // Test 9: apiKey takes precedence over key
  try {
    const res = await axios.get(`http://localhost:3899/?q=${testIp}&apiKey=${testApiKey}&key=wrongKey`);
    if (res.status === 200 && res.data && res.data.ip === testIp) {
      log(`[paramBehavior:apiKeyPrecedence] test passed`);
    } else {
      logTestFail('paramBehavior:apiKeyPrecedence', { input: testIp, url: `/?q=${testIp}&apiKey=${testApiKey}&key=wrongKey`, details: `response=${summarizeAxiosResponse(res)}` });
    }
  } catch (err) {
    logTestFail('paramBehavior:apiKeyPrecedence', { input: testIp, url: `/?q=${testIp}&apiKey=${testApiKey}&key=wrongKey`, details: `error=${formatAxiosError(err)}` });
  }

  // Test 10: key takes precedence over api_key
  try {
    const res = await axios.get(`http://localhost:3899/?q=${testIp}&key=${testApiKey}&api_key=wrongKey`);
    if (res.status === 200 && res.data && res.data.ip === testIp) {
      log(`[paramBehavior:keyPrecedence] test passed`);
    } else {
      logTestFail('paramBehavior:keyPrecedence', { input: testIp, url: `/?q=${testIp}&key=${testApiKey}&api_key=wrongKey`, details: `response=${summarizeAxiosResponse(res)}` });
    }
  } catch (err) {
    logTestFail('paramBehavior:keyPrecedence', { input: testIp, url: `/?q=${testIp}&key=${testApiKey}&api_key=wrongKey`, details: `error=${formatAxiosError(err)}` });
  }
}

async function runFunctionalTestSuite() {
  testFastLookupTable();
  simpleLutTests();
  const apiLaunched = await launchAPI(process.argv[3]);
  if (!apiLaunched) {
    log('Turning down, unable to launch API', 'ERROR');
    process.exit();
  }

  const datacenterTests = {
    "Amazon AWS": ['15.220.232.0', '15.220.232.255', '15.220.232.122',
      "2600:1ff9:c000:0000:0000:0000:0000:0000",
      "2600:1ff9:c000:0000:0000:0000:0000:0000", "2600:1ff9:c0ff:abc:ffff:def:bbbb:000"],
    "Microsoft Azure": ['20.21.48.0', '20.21.49.255',
      '20.21.48.245', "2603:1030:0c06:0001:0000:0000:0000:02c0", "2603:1030:0c06:0001:0000:0000:0000:02ff",
      "2603:1030:0c06:0001:0000:0000:0000:02cf"],
    "DigitalOcean": ["159.203.32.0", "37.139.9.0", "159.203.47.255", "159.203.47.21", "2604:a880:0000:1011:0000:0000:0000:0000",
      "2604:a880:0000:1011:ffff:ffff:ffff:ffff", "2604:a880:0000:1011:abcd:0000:eeee:ffff"],
    "Google Cloud": ["35.208.0.0", "35.223.255.255", "35.223.44.22",
      "2620:0120:e0ff:ffff:ffff:ffff:ffff:ffff", "2620:0120:e0ff:abcd:0000:eeee:aaaa:bbbb"],
    "Hetzner Online": ['5.161.0.0', '5.161.255.255', '5.161.122.55',
      '2001:067c:192c:ffff:ffff:ffff:ffff:ffff', '2001:067c:192c:abcd:0000:1111:2222:ffff'],
    "OVH": ['192.95.0.0', '192.95.63.255', '192.95.55.32', '2402:1f00:8200:0000:0000:0000:0000:0000',
      '2402:1f00:82ff:ffff:ffff:ffff:ffff:ffff', '2402:1f00:82ff:abcd:ffff:0000:0000:0000'],
    "Linode": ["139.162.239.0", "139.162.239.255", "139.162.239.33", "2400:8902:0000:0000:0000:0000:0000:0000",
      "2400:8902:ffff:ffff:ffff:ffff:ffff:ffff", "2400:8902:ffff:ffff:ffff:ffff:ffff:ffff"],
    "Cloudflare": ['162.158.0.0', '162.159.255.255', '162.159.111.222', '2405:b500:0000:0000:0000:0000:0000:0000',
      '2405:b500:ffff:ffff:ffff:ffff:ffff:ffff', '2405:b500:abcd:0000:1111::'],
    "Oracle Cloud": ['129.151.40.0', '129.151.47.255', '129.151.44.111'],
    "IBM Cloud": ['2a03:8180:1201:18b:aaaa::', '169.53.178.195',],
    "Hostinger": ["213.190.7.22",],
    "Claranet limited": ["2a00:ed0:2200:4000:aaaa:bbbb::"],
    "trueserver.nl": ["2001:9a8:0:bc:0000:aaaa::"],
    "Redstation Limited": ['88.150.129.0', '88.150.129.7', '88.150.129.5', '176.227.192.49'],
    "Myra Security": ['2a00:d70:a83a::', '2a00:d70:a848::'],
    "iomart Hosting Ltd": ['2001:1b40:5700:7000::'],
    "spry servers, llc": ['162.253.212.0', '162.253.215.155'],
    "CloudRoute, LLC": ['64.190.148.20'],
    "IBM Cloud": ['119.81.149.96', '119.81.149.103'],
    "Rackspace, Inc.": ['212.100.230.220', '212.100.230.223'],
    "Akamai Technologies, Inc.": ['2620:118:700F:FFFF:FFFF:FFFF:FFFF:FFFF'],
  };

  const netTests = {
    "DoD Network Information Center": ['33.0.0.0', '30.56.30.2'],
    "Eli Lilly and Company": ['40.56.30.2'],
    "Amazon Technologies Inc.": ['18.56.30.2'],
    "OJSC Sibirtelecom": ['87.103.144.5'],
    "West Wisconsin Telcom Cooperative, Inc": ['2604:BD00::'],
    "F5, Inc.": ['2620:0:C10::'],
    "SOFTBANK Corp.": ['219.61.110.159'],
    "Verizon Business": ['74.106.201.234', '74.111.255.255', '74.96.0.0'],
    'VpsQuan L.L.C.': ['23.251.36.252', '23.251.32.0',],
    "Wayne State University": ['141.217.0.0'],
    "HKBN Enterprise Solutions HK Limited": ['43.251.20.0'],
    "Restaurant Het Seminar Bv": ['2001:41f0:76d8::'],
  };

  const netAndRirTests = {
    "2401:4800:5aac::": ["Honesty Net Solution Pvt Ltd,", 'APNIC'],
    "2003:c5:304f::": ["Deutsche Telekom GmbH", 'RIPE'],
    "103.64.132.0": ['Fuji Eight., Ltd', 'APNIC'],
  };

  const asnOrgTest = {
    'LAM A ARCHITECTURE CONSTRUCTION COMPANY LIMITED': '103.163.218.50',
    "PacketHub S.A.": '185.213.83.115',
    "tal.de GmbH": '212.17.254.189',
  };

  const fromGeofeedHostingRanges = {
    "Zscaler": ['136.226.50.55', '136.226.50.22'],
    "bsonetwork.net": ['89.30.31.248', '31.217.128.128',],
    'Hostinger International Limited': ['45.132.157.0', '45.143.83.0'],
    "Packethub S.A.": ['185.213.83.115'],
    "ipxo.com": ['67.210.115.0', '67.210.122.0']
  };

  const crawlerTests = {
    "GoogleBot": ['66.249.66.206', '66.249.66.39'],
    "TelegramBot": ['91.108.56.0', '2001:b28:f23d::'],
    "GoogleBot": ['66.249.77.163', '66.249.75.99'],
  };

  const rwhoisTests = {
    "149.6.187.80": "Revolut Ltd",
    '38.142.195.128': 'Milwaukee Electric Tool',
    '38.32.61.232': 'Cologix, Inc',
    '38.122.117.168': 'Lion Cave Capital',
  };

  const arinCustNameTests = {
    "130.51.114.0": "Serverion LLC",
    "68.71.80.56": "RemoteTechs",
    "130.250.224.192": "PLUM VOICE",
    "198.235.165.0": "McMillan Bathurst",
  };

  const geofeedDatacenter = ['149.28.224.0', '173.199.104.0', "185.195.58.0", "104.132.54.0",
    "2a00:79e0:47::", "2a04:4e41:0050:00bf::", "45.11.107.212", "181.114.253.0", "5.183.190.0", "37.19.195.0",];

  const customListDatacenter = [
    '64.204.155.215',
    '12.12.12.12',
    '80.18.93.64',
    '53.66.31.252'
  ];

  const customListAbuser = [
    '97.132.88.17',
    '24.207.221.229',
    '65.202.132.125',
    '158.167.205.22'
  ];

  const torTests = [
    '102.130.113.30',
    '102.130.113.42',
    '102.130.119.48',
    '102.130.127.117',
    '87.118.116.103',
    '178.17.171.102',
    '185.243.218.110',
    '192.42.116.208',
    '171.25.193.80',
    '199.195.251.78',
    '195.80.151.30',
  ];
  const abuserTests = [
    '167.71.51.150',
    '45.81.243.193',
    '41.152.190.142',
    '45.180.136.12',
    '101.126.64.240',
    '222.68.155.105',
    '110.186.68.114',
    '129.213.158.123',
    '125.124.167.89',
  ];
  const no_match_tests = ["aaaa:bbbb::", '0.0.0.0']
  const invalid_input_tests = ["abcd", "aaaa:", "444.1.2.3", "1.2.3", 'stuff', 'gggg:aaaa:bbbb::', 'aaaa:bbbb:cccc:g::']
  const bogonTests = ['127.0.0.1', '::1', '127.127.0.127', '192.168.0.23', '192.168.111.33']
  const asnTests = ['185.159.157.0', '128.122.0.0']
  const different_formats_input_tests = [
    "103.250.166.004",
    "103.250.166.04",
    "001.001.001.001",
    "000.000.000.000",
    "00.0000000.00000.000000",
    "001.00000002.000003.0000004",
    "2400:8902:0fff:0:00:000:a:bb",
    '2405:b500:0:f:ff:cc:ddd::',
    '2405:0000:0000::',
    '  103.250.166.004  ',
    '\t001.002.003.004\n',
    '103.250.166.4\r\n',
    '2400:8902:0fff:0:00:000:a:bb   '
  ];

  const ownProxies = [
    '149.248.11.96',
  ];

  const vpnTestCases = {
    NordVPN: [
      '185.203.122.142',
      '194.110.112.163',
    ],
    ExpressVPN: [
      '173.239.196.170',
      '45.67.96.154',
      '98.159.226.5',
      '45.132.224.65',
    ],
    ibVPN: [
      '207.244.100.145',
      '89.46.101.70'
    ],
    IPVanish: [
      '207.204.228.16',
      '207.204.228.15',
      '69.16.157.35',
      '69.16.157.36'
    ],
    "Hide My Ass VPN": [
      '84.17.58.213'
    ]
  };

  const interpolatedVpnTestCases = {
    "NordVPN": ['2.59.157.0', '2.59.157.255'],
    "ExpressVPN": ['2.57.171.255', '2.57.168.0'],
    "MullvadVPN": ['91.90.44.0', '91.90.44.63'],
  };

  await testPicksTheCorrectOrganization();

  // test that own result is taken if commerical source does not have location data
  const ipLocation = '2603:7080:623a:711d:8914:f264:7110:a7cc';
  let locationLookup = await APIRequest(ipLocation);
  if (locationLookup.location && !locationLookup.location.accuracy) {
    log(`[OwnLocationDatabaseIfOtherNotAvailable] test passed`)
  } else {
    logTestFail('OwnLocationDatabaseIfOtherNotAvailable', {
      input: ipLocation,
      url: extractRequestUrl(locationLookup, `http://localhost:3899/?q=${ipLocation}&key=${testApiKey}`),
      details: 'missing fallback location',
    });
  }

  for (let proxyIP of ownProxies) {
    let fast_lookup = await APIRequest(proxyIP);
    if (fast_lookup.is_proxy === true) {
      log(`[ownProxies] test passed`)
    } else {
      logTestFail('ownProxies', {
        input: proxyIP,
        url: extractRequestUrl(fast_lookup, `http://localhost:3899/?q=${proxyIP}&key=${testApiKey}`),
        details: `is_proxy=${fast_lookup && fast_lookup.is_proxy}`,
      });
    }
  }

  for (let dc in datacenterTests) {
    for (let ip of datacenterTests[dc]) {
      let fast_lookup = await APIRequest(ip);
      if (fast_lookup.datacenter && fast_lookup.is_datacenter === true) {
        log(`[datacenter][${dc}] test passed`)
      } else {
        logTestFail(`datacenter][${dc}`, {
          input: ip,
          url: extractRequestUrl(fast_lookup, `http://localhost:3899/?q=${ip}&key=${testApiKey}`),
          details: `actual=${JSON.stringify(fast_lookup && fast_lookup.datacenter)}`,
        });
      }
    }
  }

  for (let torIP of torTests) {
    let fast_lookup = await APIRequest(torIP);
    if (fast_lookup.is_tor === true) {
      log(`[tor] test passed`)
    } else {
      logTestFail('tor', {
        input: torIP,
        url: extractRequestUrl(fast_lookup, `http://localhost:3899/?q=${torIP}&key=${testApiKey}`),
        details: `is_tor=${fast_lookup && fast_lookup.is_tor}`,
      });
    }
  }

  for (const provider in vpnTestCases) {
    for (const vpnIp of vpnTestCases[provider]) {
      let res = await APIRequest(vpnIp);
      if (res.is_vpn === true) {
        if (res.vpn &&
          typeof res.vpn === 'object' &&
          res.vpn.hasOwnProperty('service') &&
          res.vpn.hasOwnProperty('url')) {
          log(`[vpnTestCases][${provider}] VPN object structure test passed`);
        } else {
          logTestFail(`vpnTestCases][${provider}`, {
            input: vpnIp,
            url: extractRequestUrl(res, `http://localhost:3899/?q=${vpnIp}&key=${testApiKey}`),
            details: `vpn=${JSON.stringify(res.vpn)}`,
          });
        }
      } else {
        logTestFail('vpnTestCases', {
          input: vpnIp,
          url: extractRequestUrl(res, `http://localhost:3899/?q=${vpnIp}&key=${testApiKey}`),
          details: `is_vpn=${res && res.is_vpn}`,
        });
      }
    }
  }

  for (const provider in interpolatedVpnTestCases) {
    for (const vpnIp of interpolatedVpnTestCases[provider]) {
      let res = await APIRequest(vpnIp);
      if (res.is_vpn === true) {
        log(`[interpolatedVpnTestCases][${provider}] test passed`);
      } else {
        logTestFail(`interpolatedVpnTestCases][${provider}`, {
          input: vpnIp,
          url: extractRequestUrl(res, `http://localhost:3899/?q=${vpnIp}&key=${testApiKey}`),
          details: `is_vpn=${res && res.is_vpn}`,
        });
      }
    }
  }

  for (let abuserIP of abuserTests) {
    let fast_lookup = await APIRequest(abuserIP);
    if (fast_lookup.is_abuser === true) {
      log(`[abuser] test passed`)
    } else {
      logTestFail('abuser', {
        input: abuserIP,
        url: extractRequestUrl(fast_lookup, `http://localhost:3899/?q=${abuserIP}&key=${testApiKey}`),
        details: `is_abuser=${fast_lookup && fast_lookup.is_abuser}`,
      });
    }
  }

  for (let noMatchIP of no_match_tests) {
    let fast_lookup = await APIRequest(noMatchIP);
    if (fast_lookup.is_datacenter === false) {
      log(`[noMatch] test passed`)
    } else {
      logTestFail('noMatch', {
        input: noMatchIP,
        url: extractRequestUrl(fast_lookup, `http://localhost:3899/?q=${noMatchIP}&key=${testApiKey}`),
        details: `is_datacenter=${fast_lookup && fast_lookup.is_datacenter}`,
      });
    }
  }

  // test that looking up three times the same IP, with one second of waiting time in between requests,
  // does not return the same local_time and local_time_unix
  const ipToTest = '107.174.138.172';
  let res1 = await APIRequest(ipToTest);
  // wait for one second
  await new Promise(resolve => setTimeout(resolve, 1100));
  let res2 = await APIRequest(ipToTest);
  // wait for one second
  await new Promise(resolve => setTimeout(resolve, 1100));
  let res3 = await APIRequest(ipToTest);
  // success if the local_time_unix is different
  if (res1.location.local_time_unix !== res2.location.local_time_unix && res2.location.local_time_unix !== res3.location.local_time_unix) {
    log(`[time_not_cached] test passed`)
  } else {
    logTestFail('time_not_cached', {
      input: ipToTest,
      url: extractRequestUrl(res3, `http://localhost:3899/?q=${ipToTest}&key=${testApiKey}`),
      details: `unix=${res1.location.local_time_unix},${res2.location.local_time_unix},${res3.location.local_time_unix}`,
    });
  }

  // test that the order of the output keys is correct
  const expectedKeysOrder = [
    'ip', 'rir',
    'is_bogon', 'is_mobile', 'is_satellite',
    'is_crawler', 'is_datacenter',
    'is_tor', 'is_proxy',
    'is_vpn', 'is_abuser',
    'datacenter', 'company',
    'abuse', 'asn',
    'location', 'elapsed_ms'
  ];
  const resOrder = await APIRequest('107.174.138.172');
  // expected that the API output is in correct order
  if (Object.keys(resOrder).join(',') === expectedKeysOrder.join(',')) {
    log(`[outputOrder] test passed`)
  } else {
    logTestFail('outputOrder', {
      input: '107.174.138.172',
      url: extractRequestUrl(resOrder, `http://localhost:3899/?q=107.174.138.172&key=${testApiKey}`),
      details: `actual=${Object.keys(resOrder).join(',')}`,
    });
  }

  for (let invalidIP of invalid_input_tests) {
    let fast_lookup = await APIRequest(invalidIP, false, false, {}, true);
    const errorMsg = fast_lookup?.data?.error || fast_lookup?.error;
    if (errorMsg === 'Invalid IP Address or AS Number') {
      log(`[invalidInput] test passed`)
    } else {
      logTestFail('invalidInput', {
        input: invalidIP,
        url: `http://localhost:3899/?q=${invalidIP}&key=${testApiKey}`,
        details: `error=${errorMsg}`,
      });
    }
  }

  for (let name in netTests) {
    for (let ip of netTests[name]) {
      let fast_lookup = await APIRequest(ip);
      if (fast_lookup.company && fast_lookup.company.name === name) {
        log(`[netTests] test passed`)
      } else {
        logTestFail('netTests', {
          input: ip,
          url: extractRequestUrl(fast_lookup, `http://localhost:3899/?q=${ip}&key=${testApiKey}`),
          details: `expected=${name} actual=${fast_lookup && fast_lookup.company && fast_lookup.company.name}`,
        });
      }
    }
  }

  // test that clean IPs are not marked as datacenter, crawler, etc.
  // those are the clean ones
  const cleanIPs = [
    '46.255.29.0',
  ];

  for (let ip of cleanIPs) {
    let fast_lookup = await APIRequest(ip);
    if (fast_lookup.is_datacenter === false && fast_lookup.is_crawler === false && fast_lookup.is_tor === false && fast_lookup.is_proxy === false && fast_lookup.is_vpn === false && fast_lookup.is_abuser === false) {
      log(`[cleanIPs] test passed`)
    } else {
      logTestFail('cleanIPs', {
        input: ip,
        url: extractRequestUrl(fast_lookup, `http://localhost:3899/?q=${ip}&key=${testApiKey}`),
        details: `flags=${JSON.stringify({ datacenter: fast_lookup.is_datacenter, crawler: fast_lookup.is_crawler, tor: fast_lookup.is_tor, proxy: fast_lookup.is_proxy, vpn: fast_lookup.is_vpn, abuser: fast_lookup.is_abuser })}`,
      });
    }
  }

  for (let ip in netAndRirTests) {
    const [companyName, rir] = netAndRirTests[ip];
    let fast_lookup = await APIRequest(ip);
    if (fast_lookup.company && fast_lookup.company.name === companyName && fast_lookup.rir === rir) {
      log(`[netAndRirTests] test passed`)
    } else {
      logTestFail('netAndRirTests', {
        input: ip,
        url: extractRequestUrl(fast_lookup, `http://localhost:3899/?q=${ip}&key=${testApiKey}`),
        details: `expected=${companyName}/${rir} actual=${fast_lookup && fast_lookup.company && fast_lookup.company.name}/${fast_lookup && fast_lookup.rir}`,
      });
    }
  }

  for (let ip in arinCustNameTests) {
    const name = arinCustNameTests[ip];
    let fast_lookup = await APIRequest(ip);
    if (fast_lookup.company && fast_lookup.company.name === name) {
      log(`[arinCustNameTests] test passed`)
    } else {
      logTestFail('arinCustNameTests', {
        input: ip,
        url: extractRequestUrl(fast_lookup, `http://localhost:3899/?q=${ip}&key=${testApiKey}`),
        details: `expected=${name} actual=${fast_lookup && fast_lookup.company && fast_lookup.company.name}`,
      });
    }
  }

  for (let name in asnOrgTest) {
    const ip = asnOrgTest[name];
    let fast_lookup = await APIRequest(ip);
    if (fast_lookup.asn && fast_lookup.asn.org === name) {
      log(`[asnOrgTest] test passed`)
    } else {
      logTestFail('asnOrgTest', {
        input: ip,
        url: extractRequestUrl(fast_lookup, `http://localhost:3899/?q=${ip}&key=${testApiKey}`),
        details: `expected=${name} actual=${fast_lookup && fast_lookup.asn && fast_lookup.asn.org}`,
      });
    }
  }

  for (let name in fromGeofeedHostingRanges) {
    for (let ip of fromGeofeedHostingRanges[name]) {
      let fast_lookup = await APIRequest(ip);
      if (fast_lookup.datacenter && fast_lookup.datacenter.datacenter === name) {
        log(`[fromGeofeedHostingRanges] test passed`)
      } else {
        logTestFail('fromGeofeedHostingRanges', {
          input: ip,
          url: extractRequestUrl(fast_lookup, `http://localhost:3899/?q=${ip}&key=${testApiKey}`),
          details: `expected=${name} actual=${fast_lookup && fast_lookup.datacenter && fast_lookup.datacenter.datacenter}`,
        });
      }
    }
  }

  for (const crawlerName in crawlerTests) {
    for (const ip of crawlerTests[crawlerName]) {
      let fast_lookup = await APIRequest(ip);
      if (fast_lookup.is_crawler && fast_lookup.is_crawler === crawlerName) {
        log(`[crawlerTests] test passed`)
      } else {
        logTestFail('crawlerTests', {
          input: ip,
          url: extractRequestUrl(fast_lookup, `http://localhost:3899/?q=${ip}&key=${testApiKey}`),
          details: `expected=${crawlerName} actual=${fast_lookup && fast_lookup.is_crawler}`,
        });
      }
    }
  }

  for (let ip of geofeedDatacenter) {
    let fast_lookup = await APIRequest(ip);
    if (fast_lookup.is_datacenter === true) {
      log(`[geofeedDatacenter] test passed`)
    } else {
      logTestFail('geofeedDatacenter', {
        input: ip,
        url: extractRequestUrl(fast_lookup, `http://localhost:3899/?q=${ip}&key=${testApiKey}`),
        details: `is_datacenter=${fast_lookup && fast_lookup.is_datacenter}`,
      });
    }
  }

  for (let ip of customListDatacenter) {
    let fast_lookup = await APIRequest(ip);
    if (fast_lookup.is_datacenter === true) {
      log(`[customListDatacenter] test passed`)
    } else {
      logTestFail('customListDatacenter', {
        input: ip,
        url: extractRequestUrl(fast_lookup, `http://localhost:3899/?q=${ip}&key=${testApiKey}`),
        details: `is_datacenter=${fast_lookup && fast_lookup.is_datacenter}`,
      });
    }
  }

  for (let ip of customListAbuser) {
    let fast_lookup = await APIRequest(ip);
    if (fast_lookup.is_abuser === true) {
      log(`[customListAbuser] test passed`)
    } else {
      logTestFail('customListAbuser', {
        input: ip,
        url: extractRequestUrl(fast_lookup, `http://localhost:3899/?q=${ip}&key=${testApiKey}`),
        details: `is_abuser=${fast_lookup && fast_lookup.is_abuser}`,
      });
    }
  }

  for (let ip of bogonTests) {
    let fast_lookup = await APIRequest(ip);
    if (fast_lookup.is_bogon === true) {
      log(`[bogonTests] test passed`)
    } else {
      logTestFail('bogonTests', {
        input: ip,
        url: extractRequestUrl(fast_lookup, `http://localhost:3899/?q=${ip}&key=${testApiKey}`),
        details: `is_bogon=${fast_lookup && fast_lookup.is_bogon}`,
      });
    }
  }

  for (const ip in rwhoisTests) {
    const companyName = rwhoisTests[ip];
    let fast_lookup = await APIRequest(ip);
    if (fast_lookup.company && fast_lookup.company.name === companyName) {
      log(`[rwhoisTests] test passed`)
    } else {
      logTestFail('rwhoisTests', {
        input: ip,
        url: extractRequestUrl(fast_lookup, `http://localhost:3899/?q=${ip}&key=${testApiKey}`),
        details: `expected=${companyName} actual=${fast_lookup && fast_lookup.company && fast_lookup.company.name}`,
      });
    }
  }

  for (let ip of asnTests) {
    let fast_lookup = await APIRequest(ip);
    if (fast_lookup.asn !== null) {
      log(`[asnTests] test passed`)
    } else {
      logTestFail('asnTests', {
        input: ip,
        url: extractRequestUrl(fast_lookup, `http://localhost:3899/?q=${ip}&key=${testApiKey}`),
        details: 'asn missing',
      });
    }
  }

  await runDynamicDatasetTests();

  const locationTests = {
    // ipv4
    "71.114.173.89": "US",
    "159.226.241.238": "CN",
    "174.189.105.76": "US",
    "193.193.11.3": "IT",
  };

  for (const ip in locationTests) {
    const country = locationTests[ip];
    let res = await APIRequest(ip);
    if (res?.location?.country_code === country) {
      log(`[locationTests] test passed`)
    } else {
      logTestFail('locationTests', {
        input: ip,
        url: extractRequestUrl(res, `http://localhost:3899/?q=${ip}&key=${testApiKey}`),
        details: `expected=${country} actual=${res && res.location && res.location.country_code}`,
      });
    }
  }

  for (let formatIP of different_formats_input_tests) {
    let fast_lookup = await APIRequest(formatIP, false, false, {}, true);
    // API may accept or reject different formats, but should not crash
    // Accept both valid responses and error responses with proper error messages
    const errorMsg = fast_lookup?.data?.error || fast_lookup?.error;
    if (fast_lookup && (fast_lookup.ip || errorMsg === 'Invalid IP Address or AS Number')) {
      log(`[differentFormatsInput] test passed`)
    } else {
      logTestFail('differentFormatsInput', {
        input: formatIP,
        url: `http://localhost:3899/?q=${encodeURIComponent(formatIP)}&key=${testApiKey}`,
        details: `error=${errorMsg} ip=${fast_lookup && fast_lookup.ip}`,
      });
    }
  }

  // invalid input tests
  // try to crash the API by 
  // throwing everything inside there
  const invalidInputs = [
    '32.34.3.2211.34.3.22',
    '555.32.33.2',
    'null',
    'undefined',
    null,
    undefined,
    'asdfa'.repeat(100),
    '65435'.repeat(200),
    '%35%3%%%3%00'.repeat(100),
    '300.300.300.300',
    '1.2.3.4/33',
    '1.2.3.4,5.6.7.8',
    '1.2.3.4 5.6.7.8',
    '[1.2.3.4]',
    ':::::::',
    '::ffff:192.0.2.1%eth0',
    '1.2.3.4#fragment',
    '\"1.2.3.4\"',
    "';DROP TABLE ips;--",
    '1.2.3.4\\',
    '1.2.3.4%0a%0d'
  ];
  for (let input of invalidInputs) {
    const url = `http://localhost:3899/?q=${encodeURIComponent(input)}&key=${testApiKey}`;
    let response;
    try {
      response = await axios.get(url);
    } catch (err) {
      if (err.response) {
        response = err.response;
      } else {
        logTestFail('Invalid Input', {
          input,
          url,
          details: `error=${formatAxiosError(err)}`,
        });
        continue;
      }
    }
    const errorCode = response.data && response.data.error_code;
    if (errorCode === API_ERROR_CODE.INVALID_IP_OR_ASN) {
      log(`[Invalid Input] test passed`);
    } else {
      logTestFail('Invalid Input', {
        input,
        url,
        details: `response=${summarizeAxiosResponse(response)}`,
      });
    }
  }

  // Test inputs that should be rejected (no valid IPs at all)
  const invalidPostInputs = [
    '32.34.3.2211.34.3.22',
    '555.32.33.2',
    'notAnArray',
    12345,
    {},
    [],
    ['1,3,4', '1.3332.3.4'],
    [''],
    ['   '],
    [null],
    [undefined],
    undefined,
    null,
    getRandomIPs(0),
    getRandomIPs(101),
    getRandomIPs(1000),
  ];
  for (let input of invalidPostInputs) {
    const url = `http://localhost:3899/?key=${testApiKey}`;
    const payload = { ips: input };
    let response;
    try {
      response = await axios.post(url, JSON.stringify(payload), {
        headers: {
          'Content-Type': 'application/json'
        }
      });
    } catch (err) {
      if (err.response) {
        response = err.response;
      } else {
        logTestFail('Invalid POST Input', {
          input: JSON.stringify(input),
          url,
          details: `error=${formatAxiosError(err)}`,
        });
        continue;
      }
    }
    const errorCode = response.data && response.data.error_code;
    if (errorCode && (
      errorCode === API_ERROR_CODE.INVALID_BULK_INPUT_NOT_ARRAY ||
      errorCode === API_ERROR_CODE.INVALID_BULK_INPUT_EMPTY ||
      errorCode === API_ERROR_CODE.INVALID_BULK_INPUT_NO_VALID_ENTRIES ||
      errorCode === API_ERROR_CODE.BULK_LIMIT_EXCEEDED
    )) {
      log(`[Invalid POST Input] test passed`);
    } else {
      logTestFail('Invalid POST Input', {
        input: JSON.stringify(input),
        url,
        details: `response=${summarizeAxiosResponse(response)}`,
      });
    }
  }

  // Test inputs with valid IPs mixed with invalid ones - should silently filter and succeed
  const mixedValidInvalidInputs = [
    ['1.2.3.4', null],
    ['1.2.3.4', '::gggg'],
    ['8.8.8.8', undefined],
    ['1.1.1.1', 'not-an-ip', null],
  ];
  for (let input of mixedValidInvalidInputs) {
    const url = `http://localhost:3899/?key=${testApiKey}`;
    const payload = { ips: input };
    let response;
    try {
      response = await axios.post(url, JSON.stringify(payload), {
        headers: {
          'Content-Type': 'application/json'
        }
      });
    } catch (err) {
      if (err.response) {
        response = err.response;
      } else {
        logTestFail('Mixed Valid/Invalid POST Input', {
          input: JSON.stringify(input),
          url,
          details: `error=${formatAxiosError(err)}`,
        });
        continue;
      }
    }
    // Should succeed (200 OK) with results for valid IPs only
    if (response.status === 200 && response.data && typeof response.data === 'object' && !response.data.error) {
      log(`[Mixed Valid/Invalid POST Input] test passed`);
    } else {
      logTestFail('Mixed Valid/Invalid POST Input', {
        input: JSON.stringify(input),
        url,
        details: `response=${summarizeAxiosResponse(response)}`,
      });
    }
  }

  await httpVariantTests();
  await testApiParameterBehavior();

  // use invalid API method
  let invalidResponse;
  try {
    invalidResponse = await axios.put(`http://localhost:3899/?key=${testApiKey}`);
  } catch (err) {
    if (err.response) {
      invalidResponse = err.response;
    } else {
      logTestFail('Invalid Input', {
        input: 'PUT',
        url: `http://localhost:3899/?key=${testApiKey}`,
        details: `error=${formatAxiosError(err)}`,
      });
    }
  }
  if (invalidResponse) {
    const errorCode = invalidResponse.data && invalidResponse.data.error_code;
    if (errorCode === API_ERROR_CODE.INVALID_HTTP_METHOD) {
      log(`[Invalid Input] test passed`)
    } else {
      logTestFail('Invalid Input', {
        input: 'PUT',
        url: `http://localhost:3899/?key=${testApiKey}`,
        details: `response=${summarizeAxiosResponse(invalidResponse)}`,
      });
    }
  }

  // performance tests
  const badPerformanceThreshold = 3;
  const numPerfTests = 2000;
  let averageElapsed = 0;
  let measurements4 = {};
  for (let ip of getRandomIPs(numPerfTests)) {
    let res = await APIRequest(ip, true);
    measurements4[ip] = res.elapsed_ms;
    averageElapsed += res.elapsed_ms;
  }
  averageElapsed = round(averageElapsed / numPerfTests, 2);
  if (averageElapsed > badPerformanceThreshold) {
    logTestFail('Performance Test IPv4', {
      input: `count=${numPerfTests}`,
      url: 'multiple requests',
      details: `average_ms=${averageElapsed}`,
    });
  } else {
    log(`[Performance Test IPv4] test passed: average elapsed_ms=${averageElapsed}ms over ${numPerfTests} tests`);
  }
  console.log(`[Performance Test IPv4 Stats]`, calculateStatistics(measurements4));

  const someIPv6IPs = [
    '2804:7944::',
    '2804:7a94::',
    '2804:7bc8::',
    '2804:7c68::',
    '2804:7dbc::',
    '2804:7f58::',
    '2804:80c0::',
    '2804:6c74::',
    '2804:67e0::',
    '2804:5e30::',
  ];
  // IPv6 performance tests
  for (let ip of someIPv6IPs) {
    let res = await APIRequest(ip, true);
    if (res.elapsed_ms > badPerformanceThreshold) {
      logTestFail('IPv6 Performance Test', {
        input: ip,
        url: extractRequestUrl(res, `http://localhost:3899/?q=${ip}&key=${testApiKey}&perf=1`),
        details: `elapsed_ms=${res.elapsed_ms}`,
      });
    }
  }

  const numIPv6Samples = 2000;
  const someRandomIPv6IPs = getRandomIPv6Addresses(numIPv6Samples);
  const reallyBadPerformanceThreshold = 75;
  let averageElapsed6 = 0;
  let ipv6HasLocation = 0;
  let measurements6 = {};
  // More IPv6 performance tests
  for (let ip of someRandomIPv6IPs) {
    let res = await APIRequest(ip, true);
    if (res.location) {
      ipv6HasLocation++;
    }
    averageElapsed6 += res.elapsed_ms;
    measurements6[ip] = res.elapsed_ms;
    if (res.elapsed_ms > reallyBadPerformanceThreshold) {
      logTestFail('IPv6 Really Bad Performance Test', {
        input: ip,
        url: extractRequestUrl(res, `http://localhost:3899/?q=${ip}&key=${testApiKey}&perf=1`),
        details: `elapsed_ms=${res.elapsed_ms}`,
      });
    }
  }

  console.log(`[Performance Test IPv6 Stats]`, calculateStatistics(measurements6));

  const locShare = ipv6HasLocation / numIPv6Samples;
  log(`[IPv6 location share][${locShare < 0.5 ? 'failed' : 'ok'}] ${ipv6HasLocation}/${numIPv6Samples} (${locShare})`);

  averageElapsed6 = round(averageElapsed6 / numPerfTests, 2);
  if (averageElapsed6 > badPerformanceThreshold) {
    logTestFail('Performance Test IPv6', {
      input: `count=${someRandomIPv6IPs.length}`,
      url: 'multiple requests',
      details: `average_ms=${averageElapsed6}`,
    });
  } else {
    log(`[Performance Test IPv6] test passed: average elapsed_ms=${averageElapsed6}ms over ${someRandomIPv6IPs.length} tests`);
  }

  const slowIPs = [`184.205.87.10`, `196.63.58.182`, `132.0.28.188`,
    `120.128.65.201`, `139.175.96.163`, `161.126.146.25`,
    `214.119.49.132`, `25.129.101.214`, `145.219.72.24`];
  for (let ip of slowIPs) {
    let res = await APIRequest(ip, true);
    if (res.elapsed_ms > badPerformanceThreshold) {
      log(`[IPv4 Performance Test] test failed: elapsed_ms = ${res.elapsed_ms}, ${JSON.stringify(res.perf)}`);
    }
  }

  const bulkT0 = performance.now();
  const bulkIPs = getRandomIPs(100); // API now limits to 100 IPs
  const bulkResult = await bulkAPIRequest(bulkIPs);
  const bulkElapsed = round(performance.now() - bulkT0, 2);
  if (bulkResult && !bulkResult.status) {
    // Success response doesn't have status property (it's in the data)
    log(`Bulk lookup of ${bulkIPs.length} IPs took ${bulkElapsed}ms`);
  } else {
    const errorMsg = bulkResult?.data?.error || 'unknown error';
    logTestFail('Bulk API Request', {
      input: `count=${bulkIPs.length}`,
      url: `http://localhost:3899/?key=${testApiKey}`,
      details: `error=${errorMsg}`,
    });
  }

  // stress tests
  await stressTest();
  await specialQueryTests();
}

const functionalTests = async () => {
  const reporter = new TestReporter();
  const finalize = () => {
    reporter.stop();
    reporter.printSummary();
  };
  const handleExit = () => finalize();

  reporter.start();
  process.once('exit', handleExit);
  try {
    await runFunctionalTestSuite();
  } finally {
    process.removeListener('exit', handleExit);
    finalize();
  }
};

class LogMonitor extends EventEmitter {
  constructor(filename) {
    super();
    this.filename = filename;
    this.fileDescriptor = null;
    this.lastSize = 0;

    // Initialize the monitoring
    this.init();
  }

  init() {
    fs.open(this.filename, 'r', (err, fd) => {
      if (err) {
        this.emit('error', err);
        return;
      }
      this.fileDescriptor = fd;
      this.watchFile();
    });
  }

  watchFile() {
    fs.watch(this.filename, (eventType, filename) => {
      if (eventType === 'change') {
        this.readNewLines();
      }
    });
  }

  readNewLines() {
    fs.stat(this.filename, (err, stats) => {
      if (err) {
        this.emit('error', err);
        return;
      }

      const newSize = stats.size;
      if (newSize < this.lastSize) {
        // File was truncated, start reading from beginning
        this.lastSize = 0;
      }

      const stream = fs.createReadStream(this.filename, {
        start: this.lastSize,
        end: newSize
      });

      stream.on('data', (chunk) => {
        const lines = chunk.toString().split('\n');
        lines.forEach(line => {
          if (line.includes('[MASTER] Starting rolling reload of PIDs:')) {
            this.emit('rollingReloadDetected', line);
          } else if (line.includes('[MASTER] Workers PIDs after reload:')) {
            this.emit('reloadCompleteDetected', line);
          }
        });
      });

      this.lastSize = newSize;
    });
  }
};

const rollingReloadTest = async (testWithOneCluster = false) => {
  const configPath = testWithOneCluster
    ? path.join(__dirname, './../config/test-config-cu-one.json') :
    path.join(__dirname, './../config/test-config-cu-two.json');
  const logFile = path.join(__dirname, './../log/ipapi.log');
  const monitor = new LogMonitor(logFile);
  const apiLaunched = await launchAPI(configPath);
  if (!apiLaunched) {
    log('Turning down, unable to launch API', 'ERROR');
    process.exit();
  }

  let apiFailures = 0;
  const MASTER_PID_FILE = path.join(__dirname, './run/master.pid');
  const masterPid = fs.readFileSync(MASTER_PID_FILE, 'utf-8');
  let beforeReloadPids = null;
  let afterReloadPids = null;
  let success = 0;

  monitor.on('rollingReloadDetected', (line) => {
    beforeReloadPids = line.split('reload of PIDs:')[1].trim().split(',');
    log('Detected rolling reload:', beforeReloadPids);
  });

  monitor.on('reloadCompleteDetected', (line) => {
    afterReloadPids = line.split('after reload:')[1].trim().split(',');
    log('Detected reload completion:', afterReloadPids);
    if (beforeReloadPids && afterReloadPids) {
      const alpha = JSON.stringify(beforeReloadPids);
      const beta = JSON.stringify(afterReloadPids);
      // both worker PID's must have changed after the rolling reload
      const tag = alpha === beta ? '[FAILED]' : '[SUCCESS]';
      log(`${tag} beforeReloadPids=${alpha}, afterReloadPids=${beta}`);
      process.exit();
    }
  });

  monitor.on('error', (err) => {
    log('Error:', err, 'ERROR');
  });

  const triggerReload = () => {
    // now trigger a restart of the API
    try {
      // Sending SIGUSR2 to the process with PID 3772
      process.kill(masterPid, 'SIGUSR2');
      log(`SIGUSR2 signal sent to process ${masterPid}`);
    } catch (error) {
      // Error handling, in case the process does not exist or permissions are insufficient
      log(`Failed to send SIGUSR2 signal to process ${masterPid}:`, error.message, 'ERROR');
    }
  };

  // when we run one cluster, the API cannot keep serving requests, so we don't test for that
  if (!testWithOneCluster) {
    for (let i = 0; i < 500; i++) {
      const response = await APIRequest(getRandomIPv4(), false, true);

      if (!response || !response.ip) {
        apiFailures++;
        log('[FAILED] Cannot make API request!', 'ERROR');
        if (apiFailures > 3) {
          log('[FAILED] Too many API failures!', 'ERROR');
          process.exit();
        }
      } else {
        success++;
      }

      if (i % 50 === 0) {
        log(`Successful requests=${success}, i=${i}`);
      }

      if (i === 30) {
        triggerReload();
      }

      await sleep(200);
    }
  } else {
    setTimeout(triggerReload, 5000);
  }
};

(async () => {
  if (process.argv[2] === 'func') {
    // await testApiCorrectlyRoutes();
    await functionalTests();
  } else if (process.argv[2] === 'sameTime') {
    const res = sameTime("2023-03-31T05:52:25-07:00", "2023-03-31 05:52:25.989-0700");
    log('sameTime', res);
  } else if (process.argv[2] === 'stress') {
    await stressTest();
    process.exit();
  } else if (process.argv[2] === 'ctest') {
    await competitionAPIRequest('130.250.0.0');
    process.exit();
  } else if (process.argv[2] === 'rollingReloadTest') {
    await rollingReloadTest(false);
  } else if (process.argv[2] === 'testWithOneCluster') {
    await rollingReloadTest(true);
  } else if (process.argv[2] === 'testApiCorrectlyRoutes') {
    await testApiCorrectlyRoutes(true);
  } else if (process.argv[2] === 'sameTimeAsCompetition') {
    await sameTimeAsCompetition();
  }
})();

module.exports = {
  sameTime,
  sameTimeAsCompetition,
  competitionAPIRequest,
  APIRequest,
  bulkAPIRequest,
  launchAPI
};
