const { MainIpApi } = require('./ip_api');
const { round } = require('./utils');
const { getRandomIPs } = require('ip_address_tools');

// How many lookups to make
const N = 10000;
const ipAPI = new MainIpApi(true, true, false, true);
// generate some random IPs to test the performance
const someRandomIPs = getRandomIPs(N);

// the API takes some time to load, since
// a lot of data has to be stored into RAM
ipAPI.loadAPI().then((loaded) => {
  const t0 = Date.now();
  // test how long it takes to lookup the `N` IPs
  for (const ip of someRandomIPs) {
    // ignore the API result
    let apiResult = ipAPI.fastLookup(ip);
  }
  const t1 = Date.now();
  const elapsed_ms = t1 - t0;
  // On my Dev machine: 
  // Looking up 10000 IP's in 22054ms, Average: 2.21ms per lookup
  const avg = round(elapsed_ms / N, 2);
  console.log(`Looking up ${N} IP's in ${elapsed_ms}ms, Average: ${avg}ms per lookup`);
  process.exit();
});