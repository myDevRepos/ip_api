const { IPtoLocation } = require('./geolocation');
const { getRandomIPs, round } = require('./utils');
const { competitionAPIRequest, sameTime } = require('./functional_tests');

async function sameTimeAsCompetition(obj) {
  for (let ip of getRandomIPs(5)) {
    let location = obj.lookup(ip);
    let cres = await competitionAPIRequest(ip);
    if (cres?.time_zone?.current_time && location) {
      let realTime = cres.time_zone.current_time;
      let myTime = location.local_time;
      if (sameTime(myTime, realTime)) {
        console.log(`[IP Time] test passed`);
      } else {
        console.log(`[IP Time] test failed, own (${myTime}), competitor (${realTime})`);
        console.log(`own (${location.country}, ${location.city}), competitor (${cres.country_code2}, ${cres.city})`);
      }
    }
  }
}

async function testGeolocationPerformance(obj, N = 1000) {
  let genIPs = getRandomIPs(N);
  let sum = 0;
  let numAltLocation = 0;
  for (let ip of genIPs) {
    const t0 = performance.now();
    const lookupRes = obj.lookup(ip);
    if (lookupRes && Array.isArray(lookupRes.other) && lookupRes.other.length > 0) {
      numAltLocation++;
    }
    sum += (performance.now() - t0);
  }

  console.log(`[Geolocation Stress Test] Elapsed on average: ${round(sum / N, 2)}ms, N = ${N}`);
  console.log(`[Num Alternative Country] Number of responses with conflicting country: ${numAltLocation}/${N}`);
}

async function quickInspection(obj, N = 10) {
  let genIPs = getRandomIPs(N);
  for (let ip of genIPs) {
    console.log(ip, obj.lookup(ip));
  }
  const someIPv6 = [
    '2a0b:f4c2::10',
    "2620:7:6001::166",
    "2602:fed2:7194::6",
    "2605:6400:30:f174::",
    "2001:1af8:4700:a114:6::1",
    "2a02:248:2:41dc:5054:ff:fe80:10f",
    "2a0b:f4c2::8",
    "2602:fc05::14",
    "2001:67c:6ec:203:218:33ff:fe44:5520",
    "2620:7:6001::110",
    '2405:b500:0000:0000:0000:0000:0000:0000',
    "2604:a880:0000:1011:abcd:0000:eeee:ffff",
    "2600:1ff9:c0ff:abc:ffff:def:bbbb:000",
    '2804:7c68::',
    '2804:7dbc::',
    '2804:7f58::',
  ];
  for (let ip of someIPv6) {
    console.log(ip, obj.lookup(ip));
  }
}

(async () => {
  if (process.argv.length === 3) {
    if (process.argv[2] === 'testGeo') {
      const locLut = new IPtoLocation(true);
      await locLut.loadGeolocation({
        'db-ip.com': false,
        'ipdeny.com': true,
        'ipip.net': true,
        'maxmind.com': false,
        'ip2location.com': true,
        'ipinfo.io': true,
        'own': true,
      });

      await sameTimeAsCompetition(locLut);
      await testGeolocationPerformance(locLut);
      await quickInspection(locLut);
    }
  }
})();