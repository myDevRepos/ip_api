const { IPv6, IPv6CidrRange, expandIPv6Number, collapseIPv6Number, Validator } = require('ip-num');
const { log } = require('./utils');

const testIPv6 = () => {
  const testAddresses = [
    "2001:0db8:85a3:0000:0000:8a2e:0370:7334",
    "2001:0db8:85a3:0000:0000:8a2e:0370:ffff",
    "2001:0db8:85a3:0000:0000:8a2e:ffff:ffff",
    "2001:0db8:85a3:0000:0000:ffff:ffff:ffff",
    "2001:0db8:85a3:0000:ffff:ffff:ffff:ffff",
    "2001:0db8:85a3:ffff:ffff:ffff:ffff:ffff",
    "2001:0db8:ffff:ffff:ffff:ffff:ffff:ffff",
    "2001:ffff:ffff:ffff:ffff:ffff:ffff:ffff",
    "ffff:ffff:ffff:ffff:ffff:ffff:ffff:ffff",
    "2001:0db8::",
    "2001:0db8:85a3::8a2e:0370:7334",
    "2001:550:0:1000::9A36:1DE0",
    "2001:4457:0:371a::",
    "2001:550:0:1000::9A1A:2187",
    "2001:550:0:1000::9A18:3C58"
  ];

  const testCidrs = [
    "2001:0db8:85a3::/64",
    "2001:0db8:85a3::/48",
    "2001:0db8:85a3::/32",
    "2001:0db8:85a3::/16",
    "2001:0db8:85a3::/8",
    '2001:550:0:1000::9A18:13BC/126',
    '2001:550:0:1000::9A1A:40D/128',
    '2001:550:0:1000::9A36:1C14/126',
  ];

  for (const address of testAddresses) {
    const parsed = IPv6.fromString(address);
    log(address, parsed.toString());
    log(`BigInt: ${parsed.value}`);
    log('-----------------------------------');
  }

  for (const cidr of testCidrs) {
    const parsed = IPv6CidrRange.fromCidr(cidr);
    log(cidr);
    log(parsed.getFirst().toString(), parsed.getLast().toString());
    log('-----------------------------------');
  }

  log(expandIPv6Number('2001:550:0:1000::9A1A:40D'));
  log(expandIPv6Number('2001:550:0:1000::9A36:1C14'));
  log(expandIPv6Number('2001:0db8:85a3::8a2e:0370:7334'));

  log(Validator.isValidIPv6String('2001:550:0:1000::9A1A:40D'));
  log(Validator.isValidIPv6String('2001:0db8:85a3::8a2e:0370:7334:1'));

  log(collapseIPv6Number('2001:550:0:1000:0:0:9a1a:2187'));
  log(collapseIPv6Number('2001:4457:0:371a:0:0:0:0'));
  log(collapseIPv6Number('2001:550:0:1000:0:0:9a18:3c58'));
};

testIPv6();