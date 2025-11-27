const https = require('https');
const { getRandomIPs } = require('ip_address_tools');

// List of IP addresses to test
const testIPs = [
  '98.13.193.0', '2604:3d08:d97f:dd00::', '211.7.102.0', '240b:253:2040:3000::',
  '2605:b100:13e:1550::', '179.215.214.0', '79.170.109.0', '2607:fb90:bda0:ee6d::',
  '186.105.55.0', '2001:e68:542d:9612::', '162.230.227.0', '99.232.120.0',
  '74.253.6.0', '147.161.247.0', '206.45.90.0', '2605:a601:a62e:4100::',
  '210.10.77.0', '133.32.183.0', '123.20.64.0', '171.235.34.0',
  '2a00:23ee:1848:2ae6::', '125.103.24.0', '2605:b100:919:854c::',
  '162.204.125.0', '2001:1388:110:c9a5::', '218.146.143.0', '107.12.102.0',
  '154.51.142.0', '2800:cd0:1241:d100::', '2001:569:5973:6700::',
  '2406:3003:2005:66f9::', '99.228.233.0', '2806:105e:1a:3ef1::',
  '81.152.149.0', '180.69.228.0', '178.221.31.0', '220.240.243.0',
  '220.253.116.0', '71.174.103.0', '2001:9e8:f62f:6800::', '118.70.214.0',
  '72.208.191.0', '14.186.113.0', '42.112.223.0', '2a00:23c8:f72a:1c01::',
  '103.59.160.0', '175.140.123.0', '142.188.189.0', '2001:e68:544e:6cdd::',
  '171.5.3.0', '89.143.144.0', '68.60.169.0', '2604:3d09:e184:c300::',
  '209.141.121.0', '154.43.165.0', '2602:feda:30:cafe::', '113.170.164.0',
  '87.197.124.0', '2604:3d09:6777:7900::', '77.22.155.0', '58.136.53.0',
  '2604:3d09:e091:9200::', '137.220.64.0', '95.83.152.0', '126.163.158.0',
  '107.138.145.0', '2a0c:5a85:9305:f00::', '137.186.120.0', '189.144.237.0',
  '80.71.154.0', '99.40.7.0', '42.117.205.0', '2601:647:6883:87e0::',
  '125.253.30.0', '2001:56a:f064:2600::', '118.208.235.0', '2602:feda:f102:b63f::',
  '24.5.107.0', '58.6.82.0', '24.4.72.0', '2604:3d09:d08a:c400::',
  '184.160.136.0', '203.153.16.0', '140.235.2.0', '2600:387:15:3912::',
  '182.181.154.0', '60.53.47.0', '61.8.219.0', '2604:3d09:98a:e700::',
  '118.37.179.0', '172.56.69.0', '31.223.52.0', '196.198.211.0',
  '38.45.66.0', '207.216.141.0', '2604:4080:102f:8005::', '2600:4040:a319:500::',
  '216.167.94.0', '159.146.87.0', '70.111.197.0'
];

// add random IPs until we have 100
testIPs.push(...getRandomIPs(100 - testIPs.length));

// Test both local and production APIs
const API_KEY = 'edff309097c99c2e';

const bulkApiRequestProduction = (ips, apiKey = '') => new Promise((resolve, reject) => {
  const postData = JSON.stringify({
    ips: ips,
    key: apiKey
  });

  const options = {
    hostname: 'us.ipapi.is',
    port: 443,
    path: '/',
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Content-Length': Buffer.byteLength(postData)
    }
  };

  const req = https.request(options, (res) => {
    let data = '';

    res.on('data', chunk => data += chunk);
    res.on('end', () => {
      try {
        console.log(data);
        const result = JSON.parse(data);
        resolve({
          statusCode: res.statusCode,
          headers: res.headers,
          data: result
        });
      } catch (err) {
        reject(new Error('Error parsing JSON: ' + err.message));
      }
    });
  });

  req.on('error', err => reject(new Error('Request error: ' + err.message)));

  // Write data to request body
  req.write(postData);
  req.end();
});

console.log(`Testing bulk API with ${testIPs.length} IP addresses...`);
console.log('IPs to test:', testIPs.slice(0, 5), '... and', testIPs.length - 5, 'more');

// Test production API first
console.log('\n=== TESTING PRODUCTION API ===');
bulkApiRequestProduction(testIPs, API_KEY)
  .then(result => {
    console.log('\n=== BULK API TEST RESULTS ===');
    console.log('Status Code:', result.statusCode);
    console.log('Response Headers:', result.headers);

    if (result.data.error) {
      console.log('Error:', result.data.error);
    } else {
      console.log('Total IPs processed:', Object.keys(result.data).length);
      console.log('Total elapsed time:', result.data.total_elapsed_ms, 'ms');

      // Show sample results for first few IPs
      const sampleIPs = testIPs.slice(0, 3);
      console.log('\n=== SAMPLE RESULTS ===');
      sampleIPs.forEach(ip => {
        if (result.data[ip]) {
          console.log(`\nIP: ${ip}`);
          console.log('  ASN:', result.data[ip].asn?.asn || 'N/A');
          console.log('  Company:', result.data[ip].company?.name || 'N/A');
          console.log('  Country:', result.data[ip].location?.country || 'N/A');
          console.log('  City:', result.data[ip].location?.city || 'N/A');
          console.log('  Is Datacenter:', result.data[ip].is_datacenter || false);
          console.log('  Is VPN:', result.data[ip].is_vpn || false);
          console.log('  Is Mobile:', result.data[ip].is_mobile || false);
          console.log('  Elapsed:', result.data[ip].elapsed_ms, 'ms');
        }
      });

      // Summary statistics
      const results = Object.values(result.data).filter(r => !r.error);
      const datacenters = results.filter(r => r.is_datacenter).length;
      const vpns = results.filter(r => r.is_vpn).length;
      const mobiles = results.filter(r => r.is_mobile).length;
      const crawlers = results.filter(r => r.is_crawler).length;

      console.log('\n=== SUMMARY STATISTICS ===');
      console.log('Total successful lookups:', results.length);
      console.log('Datacenters:', datacenters);
      console.log('VPNs:', vpns);
      console.log('Mobile IPs:', mobiles);
      console.log('Crawlers:', crawlers);
      console.log('Average lookup time:', (results.reduce((sum, r) => sum + (r.elapsed_ms || 0), 0) / results.length).toFixed(2), 'ms');
    }
  })
  .catch(error => {
    console.log('Test failed:', error.message, 'ERROR');
    console.log('Error details:', error, 'ERROR');
  });
