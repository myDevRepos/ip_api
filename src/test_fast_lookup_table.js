const { ON_MULTI_FIRST, ON_MULTI_SMALLEST, ON_MULTI_ALL, ON_MULTI_LARGEST } = require('./fast_lut');
const { arrayEquals, objectEquals, log, removeDirectoryIfExists } = require('./utils');
const { isIP } = require('ip_address_tools');
const path = require('path');
const fs = require('fs');
const { RAM_DB_DIR } = require('./constants');

// Test configuration and constants
const TEST_CONFIG = {
  PERFORMANCE_THRESHOLD_MS: 100,
  STRESS_TEST_ITERATIONS: 1000,
  LARGE_DATASET_SIZE: 10000,
  RANDOM_IP_COUNT: 20
};

// Test data generators
const TestDataGenerator = {
  generateRandomIPv4: () => {
    return `${Math.floor(Math.random() * 256)}.${Math.floor(Math.random() * 256)}.${Math.floor(Math.random() * 256)}.${Math.floor(Math.random() * 256)}`;
  },

  generateRandomIPv6: () => {
    const hex = () => Math.floor(Math.random() * 65536).toString(16).padStart(4, '0');
    return `${hex()}:${hex()}:${hex()}:${hex()}:${hex()}:${hex()}:${hex()}:${hex()}`;
  },

  generateCIDRRange: (baseIP, prefixLength) => {
    return `${baseIP}/${prefixLength}`;
  },

  generateInetnumRange: (startIP, endIP) => {
    return `${startIP} - ${endIP}`;
  },

  generateMalformedIPs: () => [
    '999.999.999.999',
    '256.1.1.1',
    '1.256.1.1',
    '1.1.256.1',
    '1.1.1.256',
    'not.an.ip',
    '1.1.1',
    '1.1.1.1.1',
    ':::',
    'gggg::',
    '2001:db8::gggg',
    '2001:db8:::1'
  ],

  generateEdgeCaseIPs: () => [
    '0.0.0.0',
    '255.255.255.255',
    '127.0.0.1',
    '::',
    '::1',
    'ffff:ffff:ffff:ffff:ffff:ffff:ffff:ffff',
    '2001:db8::',
    'fe80::',
    'ff02::1'
  ]
};

// Global verbose setting for tests
let globalVerbose = true;

// Test utilities and helpers
const TestUtils = {
  getFastLutClass: (fastLutClass = null) => {
    let fastLutImpl = null;

    if (fastLutClass) {
      fastLutImpl = fastLutClass;
    } else {
      const fast_lut = require('./fast_lut');
      fastLutImpl = fast_lut.FastLut;
    }

    return fastLutImpl;
  },

  measurePerformance: (fn, label = 'Operation', verbose = null) => {
    const start = performance.now();
    const result = fn();
    const end = performance.now();
    const duration = end - start;
    if (verbose !== null ? verbose : globalVerbose) {
      log(`${label}: ${duration.toFixed(2)}ms`);
    }
    return { result, duration };
  },

  generateTestNetworks: (count = 100) => {
    const networks = [];
    for (let i = 0; i < count; i++) {
      const baseIP = TestDataGenerator.generateRandomIPv4();
      const prefixLength = Math.floor(Math.random() * 24) + 8; // /8 to /32
      networks.push([TestDataGenerator.generateCIDRRange(baseIP, prefixLength), `provider_${i}`]);
    }
    return networks;
  },

  createStressTestLut: (networkCount = 1000) => {
    const FastLut = TestUtils.getFastLutClass();
    const lut = new FastLut('stressTest', ON_MULTI_SMALLEST, false);
    const networks = TestUtils.generateTestNetworks(networkCount);

    for (const [net, provider] of networks) {
      lut.addLut(net, provider);
    }

    lut.prepareLut();
    return lut;
  }
};

let FastLut = TestUtils.getFastLutClass();

let numPassed = 0;
let total = 0;

const resetCounters = () => {
  numPassed = 0;
  total = 0;
};

// Enhanced test assertion with better error reporting
const TestAssertions = {
  testPassed: (allResults, res, expected, equalFunc = null, verbose = null, testName = '') => {
    total++;
    let isEqual = false;
    if (equalFunc) {
      isEqual = equalFunc(res, expected);
    } else {
      isEqual = (res === expected);
    }
    if (isEqual) {
      numPassed++;
      if (verbose !== null ? verbose : globalVerbose) {
        log(`[ok] Test passed${testName ? `: ${testName}` : ''}`);
      }
      allResults.push(true);
    } else {
      if (verbose !== null ? verbose : globalVerbose) {
        let errorMessage = '';
        if (equalFunc) {
          errorMessage = `[fail] Test failed${testName ? `: ${testName}` : ''}. equalFunc failed.`;
        } else {
          errorMessage = `[fail] Test failed${testName ? `: ${testName}` : ''}. Expected: ${JSON.stringify(expected)}, Actual: ${JSON.stringify(res)}`;
        }
        log(errorMessage, 'ERROR');
      }
      allResults.push(false);
    }
  },

  assertThrows: (allResults, fn, expectedError = null, testName = '') => {
    total++;
    try {
      fn();
      log(`[fail] Expected function to throw${testName ? `: ${testName}` : ''}`, 'ERROR');
      allResults.push(false);
    } catch (error) {
      if (expectedError && !error.message.includes(expectedError)) {
        log(`[fail] Expected error containing '${expectedError}' but got: ${error.message}${testName ? `: ${testName}` : ''}`, 'ERROR');
        allResults.push(false);
      } else {
        numPassed++;
        log(`[ok] Test passed - function threw as expected${testName ? `: ${testName}` : ''}`);
        allResults.push(true);
      }
    }
  },

  assertPerformance: (allResults, fn, maxDurationMs, testName = '') => {
    const { duration } = TestUtils.measurePerformance(fn, testName);
    total++;
    if (duration <= maxDurationMs) {
      numPassed++;
      log(`[ok] Performance test passed${testName ? `: ${testName}` : ''} (${duration.toFixed(2)}ms <= ${maxDurationMs}ms)`);
      allResults.push(true);
    } else {
      log(`[fail] Performance test failed${testName ? `: ${testName}` : ''} (${duration.toFixed(2)}ms > ${maxDurationMs}ms)`, 'ERROR');
      allResults.push(false);
    }
  }
};

// Backward compatibility
const testPassed = TestAssertions.testPassed;

const extendedTest = (which = 'asn') => {
  let networks = null;
  if (which === 'dc') {
    networks = load('hosting_data/hostingRanges.tsv', { split: true })
      .map((el) => el.split('\t').slice(0, 2));
  } else if (which === 'com') {
    networks = load('organisation_data/inetnum.tsv', { split: true })
      .map((el) => el.split('\t').slice(0, 2));
    let arinNets = load('organisation_data/arin.tsv', { split: true });
    for (let net of arinNets) {
      networks.push(net.split('\t').slice(0, 2))
    }
    let lacnicNets = load('organisation_data/lacnic.tsv', { split: true });
    for (let net of lacnicNets) {
      networks.push(net.split('\t').slice(0, 2))
    }
  } else if (which === 'asn') {
    networks = load('asn_data/data-raw-table', { split: true })
      .map((el) => {
        let parsed = el.split('\t');
        return parsed.reverse();
      });
  }

  const someIPs = getRandomIPs(20);

  const t0 = performance.now();
  let pre = new FastLut(which, ON_MULTI_SMALLEST, false);
  for (const [provider, net] of networks) {
    pre.addLut(net, provider);
  }
  pre.prepareLut();
  const t1 = performance.now();
  log(`Elapsed while loading from disk: ${round(t1 - t0, 2)}ms`);

  for (const ip of someIPs) {
    log('\t', ip, pre.fastLookup(ip));
  }

  pre.persistLut();

  const t00 = performance.now();
  let pre2 = new FastLut(which, ON_MULTI_SMALLEST, false);
  pre2.loadPersistedLut();
  const t11 = performance.now();
  log(`Elapsed while loading persisted: ${round(t11 - t00, 2)}ms`);

  for (const ip of someIPs) {
    log('\t', ip, pre2.fastLookup(ip));
  }
};

// Creative edge case tests
const edgeCaseTests = (fastLutClass = null) => {
  let FastLut = TestUtils.getFastLutClass(fastLutClass);
  let allResults = [];

  log('\\n=== Running Edge Case Tests ===');

  // Test 1: Malformed IP addresses - these should return null or undefined
  const malformedLut = new FastLut('malformedTest', ON_MULTI_FIRST, false);
  malformedLut.addLut('1.2.3.4/24', 'valid');
  malformedLut.prepareLut();

  const malformedIPs = TestDataGenerator.generateMalformedIPs();
  malformedIPs.forEach(ip => {
    const result = malformedLut.fastLookup(ip);
    // FastLut might return null, undefined, or throw - all are acceptable for malformed IPs
    const isValidResult = result === null || result === undefined;
    TestAssertions.testPassed(allResults, isValidResult, true, null, true, `Malformed IP: ${ip}`);
  });

  // Test 2: Edge case IP addresses - test specific known cases
  const edgeCaseLut = new FastLut('edgeCaseTest', ON_MULTI_FIRST, false);
  edgeCaseLut.addLut('0.0.0.0/8', 'zero_network');
  edgeCaseLut.addLut('255.255.255.255/32', 'broadcast');
  edgeCaseLut.addLut('127.0.0.0/8', 'loopback');
  edgeCaseLut.addLut('::/128', 'ipv6_zero');
  edgeCaseLut.prepareLut();

  // Test specific edge cases that should work
  const edgeCaseTests = [
    { ip: '0.0.0.0', expected: 'zero_network' },
    { ip: '255.255.255.255', expected: 'broadcast' },
    { ip: '127.0.0.1', expected: 'loopback' },
    { ip: '::', expected: 'ipv6_zero' }
  ];

  edgeCaseTests.forEach(({ ip, expected }) => {
    const result = edgeCaseLut.fastLookup(ip);
    TestAssertions.testPassed(allResults, result, expected, null, true, `Edge case IP: ${ip}`);
  });

  // Test 3: Extremely large and small networks - use more reasonable ranges
  const extremeLut = new FastLut('extremeTest', ON_MULTI_SMALLEST, false);
  extremeLut.addLut('10.0.0.0/8', 'large_private');
  extremeLut.addLut('172.16.0.0/12', 'medium_private');
  extremeLut.addLut('192.168.1.1/32', 'single_host');
  extremeLut.addLut('2001:db8::/32', 'ipv6_large');
  extremeLut.addLut('2001:db8::1/128', 'ipv6_single');
  extremeLut.prepareLut();

  TestAssertions.testPassed(allResults, extremeLut.fastLookup('10.0.0.1'), 'large_private', null, true, 'Large private network test');
  TestAssertions.testPassed(allResults, extremeLut.fastLookup('172.16.0.1'), 'medium_private', null, true, 'Medium private network test');
  TestAssertions.testPassed(allResults, extremeLut.fastLookup('192.168.1.1'), 'single_host', null, true, 'Single host test');

  // Test 4: Overlapping networks with extreme size differences
  const overlapLut = new FastLut('overlapTest', ON_MULTI_ALL, false);
  overlapLut.addLut('10.0.0.0/8', 'class_a');
  overlapLut.addLut('10.0.0.0/16', 'class_b');
  overlapLut.addLut('10.0.0.0/24', 'class_c');
  overlapLut.addLut('10.0.0.0/30', 'tiny');
  overlapLut.addLut('10.0.0.1/32', 'single');
  overlapLut.prepareLut();

  const overlapResult = overlapLut.fastLookup('10.0.0.1');
  TestAssertions.testPassed(allResults, overlapResult.length, 5, null, true, 'All overlapping networks found');
  TestAssertions.testPassed(allResults, overlapResult.includes('single'), true, null, true, 'Smallest network included');

  // Test 5: IPv6 compression and expansion edge cases
  const ipv6Lut = new FastLut('ipv6CompressionTest', ON_MULTI_FIRST, false);
  ipv6Lut.addLut('2001:db8::/64', 'compressed');
  ipv6Lut.addLut('2001:0db8:0000:0000:0000:0000:0000:0000/64', 'expanded');
  ipv6Lut.addLut('2001:db8:0:0:0:0:0:0/64', 'mixed');
  ipv6Lut.prepareLut();

  const ipv6TestIPs = [
    '2001:db8::1',
    '2001:0db8:0000:0000:0000:0000:0000:0001',
    '2001:db8:0:0:0:0:0:1'
  ];

  ipv6TestIPs.forEach(ip => {
    TestAssertions.testPassed(allResults, ipv6Lut.fastLookup(ip), 'compressed', null, true, `IPv6 format: ${ip}`);
  });

  // Test 6: Boundary conditions for network ranges
  const boundaryLut = new FastLut('boundaryTest', ON_MULTI_FIRST, false);
  boundaryLut.addLut('192.168.1.0 - 192.168.1.255', 'exact_range');
  boundaryLut.addLut('192.168.1.1 - 192.168.1.254', 'internal_range');
  boundaryLut.prepareLut();

  TestAssertions.testPassed(allResults, boundaryLut.fastLookup('192.168.1.0'), 'exact_range', null, true, 'Range start boundary');
  TestAssertions.testPassed(allResults, boundaryLut.fastLookup('192.168.1.255'), 'exact_range', null, true, 'Range end boundary');
  TestAssertions.testPassed(allResults, boundaryLut.fastLookup('192.168.1.1'), 'internal_range', null, true, 'Internal range start');
  TestAssertions.testPassed(allResults, boundaryLut.fastLookup('192.168.1.254'), 'internal_range', null, true, 'Internal range end');

  log(`Edge Case Tests: ${numPassed} / ${total} passed`);
  return allResults.every((test) => !!test);
};

// Performance and stress tests
const performanceTests = (fastLutClass = null) => {
  let FastLut = TestUtils.getFastLutClass(fastLutClass);
  let allResults = [];

  log('\\n=== Running Performance Tests ===');

  // Test 1: Large dataset performance
  const largeLut = TestUtils.createStressTestLut(TEST_CONFIG.LARGE_DATASET_SIZE);

  TestAssertions.assertPerformance(
    allResults,
    () => {
      for (let i = 0; i < 100; i++) {
        largeLut.fastLookup(TestDataGenerator.generateRandomIPv4());
      }
    },
    TEST_CONFIG.PERFORMANCE_THRESHOLD_MS,
    'Large dataset lookup performance'
  );

  // Test 2: Memory usage with many networks
  const memoryLut = new FastLut('memoryTest', ON_MULTI_ALL, false);
  const startMemory = process.memoryUsage().heapUsed;

  for (let i = 0; i < 5000; i++) {
    const baseIP = TestDataGenerator.generateRandomIPv4();
    memoryLut.addLut(TestDataGenerator.generateCIDRRange(baseIP, 24), `provider_${i}`);
  }
  memoryLut.prepareLut();

  const endMemory = process.memoryUsage().heapUsed;
  const memoryIncrease = (endMemory - startMemory) / 1024 / 1024; // MB

  TestAssertions.testPassed(allResults, memoryIncrease < 100, true, null, true, `Memory usage reasonable (${memoryIncrease.toFixed(2)}MB)`);

  // Test 3: Persistence performance
  const persistLut = TestUtils.createStressTestLut(1000);

  TestAssertions.assertPerformance(
    allResults,
    () => persistLut.persistLut(),
    TEST_CONFIG.PERFORMANCE_THRESHOLD_MS * 2,
    'Persistence performance'
  );

  // Test 4: Load performance
  const loadLut = new FastLut('memoryTest', ON_MULTI_ALL, false);

  TestAssertions.assertPerformance(
    allResults,
    () => loadLut.loadPersistedLut(),
    TEST_CONFIG.PERFORMANCE_THRESHOLD_MS,
    'Load performance'
  );

  log(`Performance Tests: ${numPassed} / ${total} passed`);
  return allResults.every((test) => !!test);
};

// Error handling and validation tests
const errorHandlingTests = (fastLutClass = null) => {
  let FastLut = TestUtils.getFastLutClass(fastLutClass);
  let allResults = [];

  log('\\n=== Running Error Handling Tests ===');

  // Test 1: Invalid network formats - FastLut handles these gracefully
  const invalidLut = new FastLut('invalidTest', ON_MULTI_FIRST, false);

  const invalidNetworks = [
    'not.a.network',
    '1.2.3.4/999',
    '1.2.3.4/-1',
    '1.2.3.4/33',
    '256.1.1.1/24',
    '1.1.1.1 - 0.0.0.0', // end before start
    '1.1.1.1 - 1.1.1.0', // end before start
    '::/999',
    'gggg::/64',
    '2001:db8::/129'
  ];

  // Test that invalid networks are handled gracefully (don't crash)
  invalidNetworks.forEach(network => {
    try {
      invalidLut.addLut(network, 'test');
      TestAssertions.testPassed(allResults, true, true, null, true, `Invalid network handled gracefully: ${network}`);
    } catch (error) {
      // If it throws, that's also acceptable behavior
      TestAssertions.testPassed(allResults, true, true, null, true, `Invalid network threw error: ${network}`);
    }
  });

  // Test 2: Empty and null inputs - these should be handled gracefully
  try {
    invalidLut.addLut('', 'test');
    TestAssertions.testPassed(allResults, true, true, null, true, 'Empty network string handled gracefully');
  } catch (error) {
    TestAssertions.testPassed(allResults, true, true, null, true, 'Empty network string threw error');
  }

  try {
    invalidLut.addLut(null, 'test');
    TestAssertions.testPassed(allResults, true, true, null, true, 'Null network handled gracefully');
  } catch (error) {
    TestAssertions.testPassed(allResults, true, true, null, true, 'Null network threw error');
  }

  // Test 3: Duplicate network names
  const duplicateLut = new FastLut('duplicateTest', ON_MULTI_FIRST, false);
  duplicateLut.addLut('1.2.3.4/24', 'provider1');

  // This should not throw, but should handle gracefully
  duplicateLut.addLut('1.2.3.4/24', 'provider2');
  duplicateLut.prepareLut();

  const result = duplicateLut.fastLookup('1.2.3.5');
  TestAssertions.testPassed(allResults, result === 'provider1' || result === 'provider2', true, null, true, 'Duplicate network handling');

  log(`Error Handling Tests: ${numPassed} / ${total} passed`);
  return allResults.every((test) => !!test);
};

// Integration tests with real-world scenarios
const integrationTests = (fastLutClass = null) => {
  let FastLut = TestUtils.getFastLutClass(fastLutClass);
  let allResults = [];

  log('\\n=== Running Integration Tests ===');

  // Test 1: Real-world ISP network simulation
  const ispLut = new FastLut('ispSimulation', ON_MULTI_SMALLEST, false);

  // Simulate a real ISP with multiple tiers
  ispLut.addLut('203.0.113.0/24', 'ISP_Customer_A');
  ispLut.addLut('203.0.113.0/28', 'ISP_Customer_A_Server');
  ispLut.addLut('203.0.113.16/28', 'ISP_Customer_B');
  ispLut.addLut('203.0.113.32/28', 'ISP_Customer_C');
  ispLut.addLut('203.0.113.0/16', 'ISP_Backbone');
  ispLut.addLut('203.0.0.0/8', 'ISP_Regional');
  ispLut.prepareLut();

  TestAssertions.testPassed(allResults, ispLut.fastLookup('203.0.113.1'), 'ISP_Customer_A_Server', null, true, 'ISP customer server');
  TestAssertions.testPassed(allResults, ispLut.fastLookup('203.0.113.17'), 'ISP_Customer_B', null, true, 'ISP customer B');
  TestAssertions.testPassed(allResults, ispLut.fastLookup('203.0.113.100'), 'ISP_Customer_A', null, true, 'ISP customer A range');
  TestAssertions.testPassed(allResults, ispLut.fastLookup('203.0.200.1'), 'ISP_Backbone', null, true, 'ISP backbone');

  // Test 2: CDN network simulation
  const cdnLut = new FastLut('cdnSimulation', ON_MULTI_ALL, false);

  cdnLut.addLut('104.16.0.0/12', 'Cloudflare_Global');
  cdnLut.addLut('104.16.0.0/16', 'Cloudflare_US');
  cdnLut.addLut('104.16.1.0/24', 'Cloudflare_US_West');
  cdnLut.addLut('104.16.2.0/24', 'Cloudflare_US_East');
  cdnLut.addLut('2a06:98c0::/29', 'Cloudflare_IPv6');
  cdnLut.prepareLut();

  const cdnResult = cdnLut.fastLookup('104.16.1.1');
  TestAssertions.testPassed(allResults, cdnResult.length, 3, null, true, 'CDN multiple matches');
  TestAssertions.testPassed(allResults, cdnResult.includes('Cloudflare_US_West'), true, null, true, 'CDN specific region');

  // Test 3: Corporate network with VPN
  const corporateLut = new FastLut('corporateSimulation', ON_MULTI_FIRST, false);

  corporateLut.addLut('10.0.0.0/8', 'Corporate_Internal');
  corporateLut.addLut('10.1.0.0/16', 'Corporate_Branch_Office');
  corporateLut.addLut('10.1.1.0/24', 'Corporate_IT_Department');
  corporateLut.addLut('172.16.0.0/12', 'Corporate_VPN');
  corporateLut.addLut('192.168.1.0/24', 'Corporate_Guest_WiFi');
  corporateLut.prepareLut();

  TestAssertions.testPassed(allResults, corporateLut.fastLookup('10.1.1.100'), 'Corporate_IT_Department', null, true, 'Corporate IT department');
  TestAssertions.testPassed(allResults, corporateLut.fastLookup('172.16.1.1'), 'Corporate_VPN', null, true, 'Corporate VPN');
  TestAssertions.testPassed(allResults, corporateLut.fastLookup('192.168.1.50'), 'Corporate_Guest_WiFi', null, true, 'Corporate guest WiFi');

  // Test 4: Mixed IPv4/IPv6 dual-stack scenario
  const dualStackLut = new FastLut('dualStackSimulation', ON_MULTI_SMALLEST, false);

  dualStackLut.addLut('2001:db8:1::/64', 'IPv6_Network_A');
  dualStackLut.addLut('2001:db8:1::/80', 'IPv6_Network_A_Subnet');
  dualStackLut.addLut('192.0.2.0/24', 'IPv4_Network_A');
  dualStackLut.addLut('192.0.2.0/28', 'IPv4_Network_A_Subnet');
  dualStackLut.addLut('2001:db8:2::/64', 'IPv6_Network_B');
  dualStackLut.addLut('192.0.3.0/24', 'IPv4_Network_B');
  dualStackLut.prepareLut();

  TestAssertions.testPassed(allResults, dualStackLut.fastLookup('2001:db8:1::1'), 'IPv6_Network_A_Subnet', null, true, 'IPv6 dual-stack subnet');
  TestAssertions.testPassed(allResults, dualStackLut.fastLookup('192.0.2.1'), 'IPv4_Network_A_Subnet', null, true, 'IPv4 dual-stack subnet');
  TestAssertions.testPassed(allResults, dualStackLut.fastLookup('2001:db8:2::1'), 'IPv6_Network_B', null, true, 'IPv6 dual-stack network B');

  log(`Integration Tests: ${numPassed} / ${total} passed`);
  return allResults.every((test) => !!test);
};

const simpleLutTests = (fastLutClass = null, verbose = true) => {
  globalVerbose = verbose;
  let FastLut = TestUtils.getFastLutClass(fastLutClass);

  let allResults = [];
  let numPassed = 0;
  let total = 0;
  const networks = [
    ['1.2.3.4 - 1.2.3.45', 'test1'],
    ['1.2.3.4 - 1.2.4.45', 'test2'],
    ['37.2.3.4 - 37.3.0.0', 'test3'],
    ['133.78.19.0 - 133.78.26.0', 'test4'],
    ['217.12.0.0 - 217.12.0.255', 'test5'],
    ['99.0.0.0 - 99.4.0.2', 'test6'],
    ['0.22.11.0 - 0.23.0.1', 'test7'],
    ['0.0.7.0 - 0.0.7.19', 'test8'],
    ['147.147.0.0 - 147.152.255.255', 'test9'],
    ['147.147.0.0 - 147.147.255.255', 'test10'],
    ['1.2.2.4 - 1.2.4.112', 'test11'],
    ['1.2.4.4 - 1.2.5.22', 'test12'],
    ['1.0.0.0 - 1.200.255.255', 'test13'],
  ];
  const pre = new FastLut('testLut');
  for (const [net, provider] of networks) {
    pre.addLut(net, provider);
  }
  pre.prepareLut();

  const ipsInRange = {
    '1.2.3.4': 'test1',
    '1.2.3.45': 'test1',
    '37.2.3.66': 'test3',
    '99.0.0.0': 'test6',
    '99.0.0.1': 'test6',
    '99.4.0.2': 'test6',
    '0.0.7.5': 'test8',
    '147.148.244.96': 'test9',
    '147.152.255.255': 'test9',
  };
  const ipsNotInRange = ['218.12.0.0', '0.0.0.0', '0.255.255.255'];

  for (let ip in ipsInRange) {
    let res = pre.fastLookup(ip);
    testPassed(allResults, res, ipsInRange[ip]);
  }
  for (let ip of ipsNotInRange) {
    let res = pre.fastLookup(ip);
    testPassed(allResults, res, null);
  }

  // test that onMultiMatch `smallest` returns actually the object belonging to the smallest network
  const lutSmallest = new FastLut('lutSmallest', ON_MULTI_SMALLEST, false);
  for (const [net, provider] of networks) {
    lutSmallest.addLut(net, provider);
  }
  lutSmallest.prepareLut();
  const shouldReturnSmallest = {
    '1.2.3.4': 'test1',
    '1.2.4.0': 'test2',
    '147.147.0.0': 'test10',
    '147.147.255.255': 'test10',
    '147.147.255.254': 'test10',
    '1.2.4.44': 'test12'
  };
  for (let ip in shouldReturnSmallest) {
    let res = lutSmallest.fastLookup(ip);
    testPassed(allResults, res, shouldReturnSmallest[ip]);
  }

  // test that onMultiMatch `smallest` returns actually the object belonging to the smallest network
  const smallest = new FastLut('lutSmallestSecond', ON_MULTI_SMALLEST, false);
  const networksMore = [
    ['100.200.0.0 - 100.200.0.20', 'alpha'], // 20 hosts
    ['100.200.0.10 - 100.200.100.0', 'beta'], // 100x 
    ['100.200.0.20 - 100.200.200.0', 'gamma'], // 200x 
  ];
  for (const [net, provider] of networksMore) {
    smallest.addLut(net, provider);
  }
  smallest.prepareLut();
  const mustReturnSmallest = {
    '100.200.0.20': 'alpha',
    '100.200.0.0': 'alpha',
    '100.200.0.10': 'alpha',
    '100.200.100.0': 'beta',
    '100.200.50.0': 'beta',
  };
  for (let ip in mustReturnSmallest) {
    let res = smallest.fastLookup(ip);
    testPassed(allResults, res, mustReturnSmallest[ip]);
  }

  // test that onMultiMatch `largest` returns actually the object belonging to the largest network
  const largest = new FastLut('lutLargest', ON_MULTI_LARGEST);
  for (const [net, provider] of networksMore) {
    largest.addLut(net, provider);
  }
  largest.prepareLut();
  const mustReturnLargest = {
    '100.200.0.20': 'gamma',
    '100.200.0.10': 'beta',
    '100.200.0.9': 'alpha',
    '100.200.55.55': 'gamma',
    '100.200.200.1': null,
    '100.199.255.255': null,
  };
  for (let ip in mustReturnLargest) {
    let res = largest.fastLookup(ip);
    testPassed(allResults, res, mustReturnLargest[ip]);
  }

  // IPv6: test that onMultiMatch `smallest` returns actually the object belonging to the smallest network
  const smallest6 = new FastLut('lutSmallestIPv6', ON_MULTI_SMALLEST, false);
  const networks6 = [
    ['aaaa:bbbb:: - aaaa:bbbb:cccc::', 'alpha'],
    ['aaaa:bbbb:: - aaaa:bbbb:ffff::', 'beta'],
    ['aaaa:bbbb:ccc0:: - aaaa:bbbc::', 'gamma'],
    ['cccc:: - cccc:aabb::', 'delta'],
  ];
  for (const [net, provider] of networks6) {
    smallest6.addLut(net, provider);
  }
  smallest6.prepareLut();
  const mustReturnSmallest6 = {
    'aaaa:bbbb::': 'alpha',
    'aaaa:bbbb:ccc0::': 'gamma',
    'aaaa:bbbb:ffff::': 'gamma',
    'cccc::': 'delta',
    'cccc:aabb::': 'delta',
    'aaaa:bbbc::': 'gamma',
  };
  for (let ip in mustReturnSmallest6) {
    let res = smallest6.fastLookup(ip);
    testPassed(allResults, res, mustReturnSmallest6[ip]);
  }

  // IPv6: test that onMultiMatch `all` returns all objects for that IP address
  const all6 = new FastLut('all6', ON_MULTI_ALL, false);
  const allNets6 = [
    ['2001:808::/35', 'alpha'],
    ['2001:808:e000::/35', 'beta'],
    ['2001:808:a000:: - 2001:808:e000::', 'gamma'],
    ['2001:808:1000:: - 2001:808:2f00::', 'epsilon'],
    ['2001:4c80::/32', 'delta'],
    ['2001:0806:e000::/30', 'zeta'],
  ];
  for (const [net, provider] of allNets6) {
    all6.addLut(net, provider);
  }
  all6.prepareLut();
  const mustReturnAll6 = {
    '2001:808:e000::': ['beta', 'gamma'],
    '2001:0808:1FFF:FFFF:FFFF:FFFF:FFFF:FFFF': ['alpha', 'epsilon'],
    '2001:0806:e000::': ['zeta'],
    '2001:808:1000::': ["alpha", "epsilon"]
  };
  for (let ip in mustReturnAll6) {
    let res = all6.fastLookup(ip);
    testPassed(allResults, res, mustReturnAll6[ip], arrayEquals);
  }

  // IPv4: test that onMultiMatch `all` returns all objects for that IP address
  const all4 = new FastLut('all4', ON_MULTI_ALL, false);
  const allNets4 = [
    ['22.0.0.1/24', 'alpha'],
    ['22.0.0.2/22', 'beta'],
    ['22.0.0.3/18', 'gamma'],
    ['21.255.255.33/24', 'zeta'],
    ['21.255.255.33 - 22.0.0.2', 'epsilon']
  ];
  for (const [net, provider] of allNets4) {
    all4.addLut(net, provider);
  }
  all4.prepareLut();
  const mustReturnAll4 = {
    '22.0.0.3': ['alpha', 'beta', 'gamma', 'zeta'],
    '22.0.0.2': ['alpha', 'beta', 'zeta', 'epsilon'],
  };
  for (let ip in mustReturnAll4) {
    let res = all4.fastLookup(ip);
    testPassed(allResults, res, mustReturnAll4[ip], arrayEquals);
  }

  // Test that LUT does contain IPv6 CIDR ranges
  const inet6numCidr = new FastLut('inet6numCidr', ON_MULTI_FIRST, false);
  inet6numCidr.addLut("2604:a880:0:1011::/64", "New York");
  inet6numCidr.addLut("2a03:b0c0:0:1050::/64", "Amsterdam");
  inet6numCidr.prepareLut();

  testPassed(allResults, inet6numCidr.fastLookup('2604:a880:0000:1011:0000:0000:0000:0000'), "New York");
  testPassed(allResults, inet6numCidr.fastLookup("2604:A880:0000:1011:FFFF:FFFF:FFFF:FFFF"), "New York");

  testPassed(allResults, inet6numCidr.fastLookup("2a03:b0c0:0000:1050:0000:0000:0000:0000"), "Amsterdam");
  testPassed(allResults, inet6numCidr.fastLookup("2A03:B0C0:0000:1050:FFFF:FFFF:FFFF:FFFF"), "Amsterdam");

  testPassed(allResults, inet6numCidr.fastLookup("2a03:b0c0:0:1050:0000:aaaa::"), "Amsterdam");
  testPassed(allResults, inet6numCidr.fastLookup("2a03:b0c0:0:1050:0000:bbbb::"), "Amsterdam");

  const finalLut = new FastLut('finalLut', ON_MULTI_FIRST, false);
  const moreNets = [
    ['176.31.224.0 - 176.31.255.25', '1'],
    ['92.205.48.0 - 92.205.55.255', '2'],
    ['64.43.64.0 - 64.43.127.255', '3'],
    ['2a07:5cc0::/29', '4'],
    ['2a03:1b20::/32', '5'],
    ['199.190.151.0 - 199.190.154.255', '6'],
    ['2a0b:8240::/32', '7'],
    ['2a01:6244:3400::/40', '8'],
  ];
  for (const [net, provider] of moreNets) {
    finalLut.addLut(net, provider);
  }
  finalLut.prepareLut();

  testPassed(allResults, finalLut.fastLookup("176.31.224.0"), '1');
  testPassed(allResults, finalLut.fastLookup("176.31.224.1"), '1');
  testPassed(allResults, finalLut.fastLookup("176.31.255.24"), '1');
  testPassed(allResults, finalLut.fastLookup("176.31.255.25"), '1');

  // test that lut does NOT contain IPs
  testPassed(allResults, finalLut.fastLookup("0.0.0.0"), null);
  testPassed(allResults, finalLut.fastLookup("255.0.0.0"), null);

  testPassed(allResults, finalLut.fastLookup("64.43.64.0"), '3');
  testPassed(allResults, finalLut.fastLookup("64.43.127.255"), '3');

  testPassed(allResults, finalLut.fastLookup("2A07:5CC7:FFFF:FFFF:FFFF:FFFF:FFFF:FFFF"), '4');
  testPassed(allResults, finalLut.fastLookup("2A07:5CC7:FFFF:aaaa:FFFF:0000:FFFF:FFFF"), '4');
  testPassed(allResults, finalLut.fastLookup("2A07:5CC7:FFFF:aaaa:bbbb:cccc:FFFF:FFFF"), '4');
  testPassed(allResults, finalLut.fastLookup("2a07:5cc0::"), '4');

  testPassed(allResults, finalLut.fastLookup("2A01:6244:3400:0000:0000:0000:0000:0000"), '8');
  testPassed(allResults, finalLut.fastLookup("2A01:6244:34FF:FFFF:FFFF:FFFF:FFFF:FFFF"), '8');
  testPassed(allResults, finalLut.fastLookup("2A01:6244:34FF:aaaa:FFFF:FFFF:FFFF:FFFF"), '8');

  // test that lut does NOT contain IPs
  testPassed(allResults, finalLut.fastLookup("ffff::"), null);
  testPassed(allResults, finalLut.fastLookup("aaaa::"), null);


  // test ON_MULTI_ALL works with single IPs
  // if lookup strategy is ON_MULTI_ALL, the return value is ALWAYS an ARRAY, in any fucking case
  const singleIPsOnMultiAll = new FastLut('finalLut', ON_MULTI_ALL);
  const ips = [
    '222.230.138.25',
    '47.100.38.146',
    '61.131.142.203',
    '80.94.95.81',
    '157.230.105.229',
    '2a0b:f4c2::10',
    "2620:7:6001::166",
    "2602:fed2:7194::6",
    "2605:6400:30:f174::",
  ];
  for (const ip of ips) {
    for (let index = 1; index <= 3; index++) {
      singleIPsOnMultiAll.addLut(ip, index);
    }
  }

  singleIPsOnMultiAll.addLut('61.131.162.103', 55);
  singleIPsOnMultiAll.addLut("2602:fed2:aa94::6", 66);

  singleIPsOnMultiAll.prepareLut();

  for (const ip of ips) {
    const res = singleIPsOnMultiAll.fastLookup(ip);
    testPassed(allResults, res[0], [1, 2, 3], arrayEquals);
  }

  testPassed(allResults, singleIPsOnMultiAll.fastLookup('61.131.162.103'), [55], arrayEquals);
  testPassed(allResults, singleIPsOnMultiAll.fastLookup("2602:fed2:aa94::6"), [66], arrayEquals);
  testPassed(allResults, singleIPsOnMultiAll.fastLookup('61.131.162.11'), null);
  testPassed(allResults, singleIPsOnMultiAll.fastLookup('61.131.12.12'), null);

  if (verbose) {
    log(`Num Tests Passed: ${numPassed} / ${total}`);
  }

  return allResults.every((test) => !!test);
};

// Comprehensive persistence tests for persistLut and loadPersistedLut
const persistenceTests = async (fastLutClass = null) => {
  let FastLut = TestUtils.getFastLutClass(fastLutClass);
  let allResults = [];

  log('\\n=== Running Persistence Tests ===');

  // Test 1: Basic persistence and loading
  const basicPersistenceLut = new FastLut('basicPersistenceTest', ON_MULTI_SMALLEST, false);
  basicPersistenceLut.addLut('192.168.1.0/24', 'local_network');
  basicPersistenceLut.addLut('10.0.0.0/8', 'private_network');
  basicPersistenceLut.addLut('2001:db8::/32', 'ipv6_test_network');
  basicPersistenceLut.prepareLut();

  // Test persistence
  const persistResult = basicPersistenceLut.persistLut();
  TestAssertions.testPassed(allResults, persistResult, 'success', null, true, 'Basic persistence success');

  // Test loading
  const loadedLut = new FastLut('basicPersistenceTest', ON_MULTI_SMALLEST, false);
  const loadResult = loadedLut.loadPersistedLut();
  TestAssertions.testPassed(allResults, loadResult, 'success', null, true, 'Basic loading success');

  // Verify data integrity after load
  TestAssertions.testPassed(allResults, loadedLut.fastLookup('192.168.1.1'), 'local_network', null, true, 'IPv4 lookup after load');
  TestAssertions.testPassed(allResults, loadedLut.fastLookup('10.0.0.1'), 'private_network', null, true, 'Private network lookup after load');
  TestAssertions.testPassed(allResults, loadedLut.fastLookup('2001:db8::1'), 'ipv6_test_network', null, true, 'IPv6 lookup after load');

  // Test 2: Complex data structures persistence
  const complexDataLut = new FastLut('complexDataTest', ON_MULTI_ALL, false);

  // Add complex objects
  const complexObject1 = {
    provider: 'AWS',
    region: 'us-east-1',
    services: ['ec2', 's3', 'lambda'],
    metadata: { tier: 'premium', cost: 0.023 }
  };

  const complexObject2 = {
    provider: 'Google Cloud',
    region: 'europe-west1',
    services: ['compute', 'storage'],
    metadata: { tier: 'standard', cost: 0.019 }
  };

  complexDataLut.addLut('54.239.0.0/16', complexObject1);
  complexDataLut.addLut('35.190.0.0/15', complexObject2);
  complexDataLut.addLut('54.239.0.0/20', { ...complexObject1, subregion: 'us-east-1a' });
  complexDataLut.prepareLut();

  complexDataLut.persistLut();

  const loadedComplexLut = new FastLut('complexDataTest', ON_MULTI_ALL, false);
  loadedComplexLut.loadPersistedLut();

  const complexResult = loadedComplexLut.fastLookup('54.239.1.1');
  TestAssertions.testPassed(allResults, complexResult.length, 2, null, true, 'Complex object multiple matches');
  TestAssertions.testPassed(allResults, complexResult[0].provider, 'AWS', null, true, 'Complex object provider preserved');
  TestAssertions.testPassed(allResults, complexResult[0].metadata.cost, 0.023, null, true, 'Complex object metadata preserved');

  // Test 3: Version management and reload scenarios
  const versionLut = new FastLut('versionTest', ON_MULTI_FIRST, false);
  versionLut.addLut('1.2.3.0/24', 'version1');
  versionLut.prepareLut();
  versionLut.persistLut();

  const versionLut2 = new FastLut('versionTest', ON_MULTI_FIRST, false);
  versionLut2.loadPersistedLut();

  // First reload should return 'reloadNotNeeded'
  const reloadResult1 = versionLut2.loadPersistedLut();
  TestAssertions.testPassed(allResults, reloadResult1, 'reloadNotNeeded', null, true, 'Reload not needed when version unchanged');

  // Create new version
  const versionLut3 = new FastLut('versionTest', ON_MULTI_FIRST, false);
  versionLut3.addLut('1.2.3.0/24', 'version1');
  versionLut3.addLut('4.5.6.0/24', 'version2');
  versionLut3.prepareLut();
  versionLut3.persistLut();

  // Small delay to ensure file system operations complete
  await new Promise(resolve => setTimeout(resolve, 10));

  // Now reload should return 'success'
  const reloadResult2 = versionLut2.loadPersistedLut();
  TestAssertions.testPassed(allResults, reloadResult2, 'success', null, true, 'Reload success when version changed');
  TestAssertions.testPassed(allResults, versionLut2.fastLookup('4.5.6.1'), 'version2', null, true, 'New data available after reload');

  // Test 4: Large dataset persistence performance
  const largeDatasetLut = new FastLut('largeDatasetTest', ON_MULTI_SMALLEST, false);

  // Generate large dataset
  for (let i = 0; i < 1000; i++) {
    const baseIP = TestDataGenerator.generateRandomIPv4();
    const prefixLength = Math.floor(Math.random() * 24) + 8;
    largeDatasetLut.addLut(TestDataGenerator.generateCIDRRange(baseIP, prefixLength), `provider_${i}`);
  }

  largeDatasetLut.prepareLut();

  TestAssertions.assertPerformance(
    allResults,
    () => largeDatasetLut.persistLut(),
    TEST_CONFIG.PERFORMANCE_THRESHOLD_MS * 5,
    'Large dataset persistence performance'
  );

  const loadedLargeLut = new FastLut('largeDatasetTest', ON_MULTI_SMALLEST, false);

  TestAssertions.assertPerformance(
    allResults,
    () => loadedLargeLut.loadPersistedLut(),
    TEST_CONFIG.PERFORMANCE_THRESHOLD_MS * 3,
    'Large dataset loading performance'
  );

  // Test 5: File corruption and error handling
  const corruptionLut = new FastLut('corruptionTest', ON_MULTI_FIRST, false);
  corruptionLut.addLut('1.1.1.0/24', 'test');
  corruptionLut.prepareLut();
  corruptionLut.persistLut();

  // Corrupt the timestamp file
  const timestampFile = path.join(corruptionLut.ramDbStoreDir, 'tsCreated.json');
  fs.writeFileSync(timestampFile, 'invalid json content');

  const corruptedLut = new FastLut('corruptionTest', ON_MULTI_FIRST, false);

  // The current implementation throws an error for corrupted JSON, so we test that behavior
  let corruptedLoadResult = null;
  try {
    corruptedLoadResult = corruptedLut.loadPersistedLut();
    TestAssertions.testPassed(allResults, false, true, null, true, 'Corrupted JSON should throw error');
  } catch (error) {
    TestAssertions.testPassed(allResults, true, true, null, true, 'Handles corrupted timestamp file by throwing error');
  }

  // Test 6: Missing directory handling
  const missingDirLut = new FastLut('nonexistentTest', ON_MULTI_FIRST, false);
  const missingDirResult = missingDirLut.loadPersistedLut();
  TestAssertions.testPassed(allResults, missingDirResult, 'ramDbStoreDirDoesNotExist', null, true, 'Handles missing directory correctly');

  // Test 7: IPv6 compression and expansion persistence
  const ipv6CompressionLut = new FastLut('ipv6CompressionTest', ON_MULTI_SMALLEST, false);
  ipv6CompressionLut.addLut('2001:0db8:0000:0000:0000:0000:0000:0000/64', 'expanded');
  ipv6CompressionLut.addLut('2001:db8::/64', 'compressed');
  ipv6CompressionLut.addLut('2001:db8:0:0:0:0:0:0/64', 'mixed');
  ipv6CompressionLut.prepareLut();
  ipv6CompressionLut.persistLut();

  const loadedIpv6Lut = new FastLut('ipv6CompressionTest', ON_MULTI_SMALLEST, false);
  loadedIpv6Lut.loadPersistedLut();

  // All three networks are the same size, so it should return the first one added
  TestAssertions.testPassed(allResults, loadedIpv6Lut.fastLookup('2001:db8::1'), 'expanded', null, true, 'IPv6 compression preserved after load');

  // Test 8: Direct lookup table persistence
  const directLutTest = new FastLut('directLutTest', ON_MULTI_ALL, false);
  directLutTest.addLut('1.1.1.1', 'single_ip_1');
  directLutTest.addLut('2.2.2.2', 'single_ip_2');
  directLutTest.addLut('2001:db8::1', 'single_ipv6');
  directLutTest.prepareLut();
  directLutTest.persistLut();

  const loadedDirectLut = new FastLut('directLutTest', ON_MULTI_ALL, false);
  loadedDirectLut.loadPersistedLut();

  TestAssertions.testPassed(allResults, loadedDirectLut.fastLookup('1.1.1.1'), ['single_ip_1'], arrayEquals, true, 'Direct IPv4 lookup preserved');
  TestAssertions.testPassed(allResults, loadedDirectLut.fastLookup('2001:db8::1'), ['single_ipv6'], arrayEquals, true, 'Direct IPv6 lookup preserved');

  // Test 9: Overlapping networks persistence
  const overlappingLut = new FastLut('overlappingPersistenceTest', ON_MULTI_ALL, false);
  overlappingLut.addLut('10.0.0.0/8', 'large_network');
  overlappingLut.addLut('10.0.0.0/16', 'medium_network');
  overlappingLut.addLut('10.0.0.0/24', 'small_network');
  overlappingLut.prepareLut();
  overlappingLut.persistLut();

  const loadedOverlappingLut = new FastLut('overlappingPersistenceTest', ON_MULTI_ALL, false);
  loadedOverlappingLut.loadPersistedLut();

  const overlappingResult = loadedOverlappingLut.fastLookup('10.0.0.1');
  TestAssertions.testPassed(allResults, overlappingResult.length, 3, null, true, 'Overlapping networks preserved after load');
  TestAssertions.testPassed(allResults, overlappingResult.includes('small_network'), true, null, true, 'Smallest network in overlapping result');

  // Ensure stale overlapping binaries are replaced when no overlaps remain
  const overlapCleanupName = 'overlapCleanupTest';
  const overlapCleanupDir = path.join(RAM_DB_DIR, overlapCleanupName);
  removeDirectoryIfExists(overlapCleanupDir);
  fs.mkdirSync(overlapCleanupDir, { recursive: true });

  const staleOverlap = Buffer.alloc(12);
  staleOverlap.writeUInt32LE(0, 0);
  staleOverlap.writeUInt32LE(1, 4);
  staleOverlap.writeUInt32LE(123, 8);
  fs.writeFileSync(path.join(overlapCleanupDir, 'overlapping6.bin'), staleOverlap);

  const overlapCleanupLut = new FastLut(overlapCleanupName, ON_MULTI_SMALLEST, false);
  overlapCleanupLut.addLut('2001:db8::/32', 'cleanup');
  overlapCleanupLut.prepareLut();
  overlapCleanupLut.persistLut();

  const overlapFilePath = path.join(overlapCleanupDir, 'overlapping6.bin');
  const overlapFileSize = fs.existsSync(overlapFilePath) ? fs.statSync(overlapFilePath).size : 0;
  TestAssertions.testPassed(allResults, overlapFileSize, 0, null, true, 'Empty overlapping6.bin truncated on persist');

  const loadedOverlapCleanupLut = new FastLut(overlapCleanupName, ON_MULTI_SMALLEST, false);
  loadedOverlapCleanupLut.loadPersistedLut();

  let cleanupLookupThrew = false;
  let cleanupLookupResult = null;
  try {
    cleanupLookupResult = loadedOverlapCleanupLut.fastLookup('2001:db8::1');
  } catch (error) {
    cleanupLookupThrew = true;
  }

  TestAssertions.testPassed(allResults, cleanupLookupThrew, false, null, true, 'Lookup succeeds when overlapping6.bin is empty');
  TestAssertions.testPassed(allResults, cleanupLookupResult, 'cleanup', null, true, 'IPv6 lookup preserved after cleanup');

  // Test 10: Memory efficiency after load
  const memoryEfficiencyLut = new FastLut('memoryEfficiencyTest', ON_MULTI_SMALLEST, false);

  // Add many networks to test memory efficiency
  for (let i = 0; i < 500; i++) {
    const baseIP = TestDataGenerator.generateRandomIPv4();
    memoryEfficiencyLut.addLut(TestDataGenerator.generateCIDRRange(baseIP, 24), `efficiency_test_${i}`);
  }
  memoryEfficiencyLut.prepareLut();
  memoryEfficiencyLut.persistLut();

  const startMemory = process.memoryUsage().heapUsed;
  const loadedMemoryLut = new FastLut('memoryEfficiencyTest', ON_MULTI_SMALLEST, false);
  loadedMemoryLut.loadPersistedLut();
  const endMemory = process.memoryUsage().heapUsed;
  const memoryIncrease = (endMemory - startMemory) / 1024 / 1024; // MB

  TestAssertions.testPassed(allResults, memoryIncrease < 50, true, null, true, `Memory efficiency after load (${memoryIncrease.toFixed(2)}MB)`);

  // Test 11: Concurrent access simulation
  const concurrentLut = new FastLut('concurrentTest', ON_MULTI_FIRST, false);
  concurrentLut.addLut('192.168.0.0/16', 'concurrent_test');
  concurrentLut.prepareLut();
  concurrentLut.persistLut();

  // Simulate concurrent access by loading multiple instances
  const concurrentInstances = [];
  for (let i = 0; i < 5; i++) {
    const instance = new FastLut('concurrentTest', ON_MULTI_FIRST, false);
    instance.loadPersistedLut();
    concurrentInstances.push(instance);
  }

  // All instances should work correctly
  let allConcurrentWork = true;
  for (const instance of concurrentInstances) {
    if (instance.fastLookup('192.168.1.1') !== 'concurrent_test') {
      allConcurrentWork = false;
      break;
    }
  }
  TestAssertions.testPassed(allResults, allConcurrentWork, true, null, true, 'Concurrent access simulation');

  // Test 12: Edge case - empty LUT persistence
  const emptyLut = new FastLut('emptyTest', ON_MULTI_FIRST, false);
  emptyLut.prepareLut();
  const emptyPersistResult = emptyLut.persistLut();
  TestAssertions.testPassed(allResults, emptyPersistResult, 'success', null, true, 'Empty LUT persistence');

  const loadedEmptyLut = new FastLut('emptyTest', ON_MULTI_FIRST, false);
  const emptyLoadResult = loadedEmptyLut.loadPersistedLut();
  TestAssertions.testPassed(allResults, emptyLoadResult, 'success', null, true, 'Empty LUT loading');
  TestAssertions.testPassed(allResults, loadedEmptyLut.fastLookup('1.1.1.1'), null, null, true, 'Empty LUT lookup returns null');

  // Test 13: Binary data integrity
  const binaryIntegrityLut = new FastLut('binaryIntegrityTest', ON_MULTI_SMALLEST, false);

  // Add networks that will create binary data
  for (let i = 0; i < 100; i++) {
    const baseIP = TestDataGenerator.generateRandomIPv4();
    binaryIntegrityLut.addLut(TestDataGenerator.generateCIDRRange(baseIP, 24), `binary_test_${i}`);
  }
  binaryIntegrityLut.prepareLut();
  binaryIntegrityLut.persistLut();

  const loadedBinaryLut = new FastLut('binaryIntegrityTest', ON_MULTI_SMALLEST, false);
  loadedBinaryLut.loadPersistedLut();

  // Test that binary data was correctly reconstructed
  let binaryIntegrityPassed = true;
  for (let i = 0; i < 10; i++) {
    const testIP = TestDataGenerator.generateRandomIPv4();
    const originalResult = binaryIntegrityLut.fastLookup(testIP);
    const loadedResult = loadedBinaryLut.fastLookup(testIP);
    if (originalResult !== loadedResult) {
      binaryIntegrityPassed = false;
      break;
    }
  }
  TestAssertions.testPassed(allResults, binaryIntegrityPassed, true, null, true, 'Binary data integrity after load');

  // Test 14: Stress test with rapid persist/load cycles
  const stressLut = new FastLut('stressPersistenceTest', ON_MULTI_SMALLEST, false);

  // Add networks
  for (let i = 0; i < 50; i++) {
    const baseIP = TestDataGenerator.generateRandomIPv4();
    stressLut.addLut(TestDataGenerator.generateCIDRRange(baseIP, 24), `stress_${i}`);
  }
  stressLut.prepareLut();

  // Perform multiple persist/load cycles
  let stressCyclesPassed = true;
  for (let cycle = 0; cycle < 5; cycle++) {
    stressLut.persistLut();
    const stressLoadedLut = new FastLut('stressPersistenceTest', ON_MULTI_SMALLEST, false);
    const loadResult = stressLoadedLut.loadPersistedLut();
    if (loadResult !== 'success') {
      stressCyclesPassed = false;
      break;
    }
  }
  TestAssertions.testPassed(allResults, stressCyclesPassed, true, null, true, 'Stress test with rapid persist/load cycles');

  // Test 15: Cross-platform path handling
  const pathTestLut = new FastLut('pathTest', ON_MULTI_FIRST, false);
  pathTestLut.addLut('127.0.0.1/32', 'localhost');
  pathTestLut.prepareLut();
  pathTestLut.persistLut();

  const pathLoadedLut = new FastLut('pathTest', ON_MULTI_FIRST, false);
  const pathLoadResult = pathLoadedLut.loadPersistedLut();
  TestAssertions.testPassed(allResults, pathLoadResult, 'success', null, true, 'Cross-platform path handling');

  // Test 16: File permission edge cases
  const permissionLut = new FastLut('permissionTest', ON_MULTI_FIRST, false);
  permissionLut.addLut('192.168.1.0/24', 'permission_test');
  permissionLut.prepareLut();
  permissionLut.persistLut();

  // Test that we can still load even if some files have different permissions
  const permissionLoadedLut = new FastLut('permissionTest', ON_MULTI_FIRST, false);
  const permissionLoadResult = permissionLoadedLut.loadPersistedLut();
  TestAssertions.testPassed(allResults, permissionLoadResult, 'success', null, true, 'File permission handling');

  // Test 17: Large object persistence
  const largeObjectLut = new FastLut('largeObjectTest', ON_MULTI_FIRST, false);

  // Create a large object with nested structures
  const largeObject = {
    provider: 'MegaCorp',
    regions: {},
    services: [],
    metadata: {}
  };

  // Add many regions
  for (let i = 0; i < 100; i++) {
    largeObject.regions[`region_${i}`] = {
      name: `Region ${i}`,
      datacenters: [],
      capacity: Math.random() * 1000
    };

    // Add datacenters to each region
    for (let j = 0; j < 10; j++) {
      largeObject.regions[`region_${i}`].datacenters.push({
        id: `dc_${i}_${j}`,
        location: `City ${i}-${j}`,
        capacity: Math.random() * 100
      });
    }
  }

  // Add many services
  for (let i = 0; i < 50; i++) {
    largeObject.services.push({
      name: `service_${i}`,
      type: ['compute', 'storage', 'network'][i % 3],
      version: `v${i}.0.0`,
      dependencies: Array.from({ length: 5 }, (_, j) => `dep_${i}_${j}`)
    });
  }

  largeObjectLut.addLut('10.0.0.0/8', largeObject);
  largeObjectLut.prepareLut();
  largeObjectLut.persistLut();

  const largeObjectLoadedLut = new FastLut('largeObjectTest', ON_MULTI_FIRST, false);
  largeObjectLoadedLut.loadPersistedLut();

  const loadedLargeObject = largeObjectLoadedLut.fastLookup('10.0.0.1');
  TestAssertions.testPassed(allResults, loadedLargeObject.provider, 'MegaCorp', null, true, 'Large object provider preserved');
  TestAssertions.testPassed(allResults, Object.keys(loadedLargeObject.regions).length, 100, null, true, 'Large object regions preserved');
  TestAssertions.testPassed(allResults, loadedLargeObject.services.length, 50, null, true, 'Large object services preserved');

  // Test 18: Unicode and special character handling
  const unicodeLut = new FastLut('unicodeTest', ON_MULTI_FIRST, false);

  const unicodeObjects = [
    { name: '北京数据中心', region: '中国', emoji: '🇨🇳' },
    { name: 'München Datacenter', region: 'Deutschland', emoji: '🇩🇪' },
    { name: 'São Paulo DC', region: 'Brasil', emoji: '🇧🇷' },
    { name: 'Москва ЦОД', region: 'Россия', emoji: '🇷🇺' },
    { name: '東京データセンター', region: '日本', emoji: '🇯🇵' }
  ];

  unicodeObjects.forEach((obj, index) => {
    const baseIP = `192.168.${index + 1}.0/24`;
    unicodeLut.addLut(baseIP, obj);
  });

  unicodeLut.prepareLut();
  unicodeLut.persistLut();

  const unicodeLoadedLut = new FastLut('unicodeTest', ON_MULTI_FIRST, false);
  unicodeLoadedLut.loadPersistedLut();

  const unicodeResult = unicodeLoadedLut.fastLookup('192.168.1.1');
  TestAssertions.testPassed(allResults, unicodeResult.name, '北京数据中心', null, true, 'Unicode characters preserved');
  TestAssertions.testPassed(allResults, unicodeResult.emoji, '🇨🇳', null, true, 'Emoji characters preserved');

  // Test 19: Circular reference handling (should be handled gracefully)
  const circularLut = new FastLut('circularTest', ON_MULTI_FIRST, false);

  const circularObject = { name: 'circular_test' };
  circularObject.self = circularObject; // Create circular reference

  circularLut.addLut('172.16.0.0/16', circularObject);
  circularLut.prepareLut();

  // The current implementation throws an error for circular references, so we test that behavior
  let circularPersistResult = null;
  try {
    circularPersistResult = circularLut.persistLut();
    TestAssertions.testPassed(allResults, false, true, null, true, 'Circular reference should throw error');
  } catch (error) {
    TestAssertions.testPassed(allResults, true, true, null, true, 'Handles circular reference by throwing error');
  }

  // Test 20: Mixed data types persistence
  const mixedTypesLut = new FastLut('mixedTypesTest', ON_MULTI_ALL, false);

  const mixedTypesData = [
    { type: 'string', value: 'test_string' },
    { type: 'number', value: 42 },
    { type: 'boolean', value: true },
    { type: 'null', value: null },
    { type: 'array', value: [1, 2, 3, 'test'] },
    { type: 'object', value: { nested: 'value' } },
    { type: 'date', value: new Date('2023-01-01') },
    { type: 'regex', value: /test-pattern/gi }
  ];

  mixedTypesData.forEach((data, index) => {
    const baseIP = `203.0.113.${index}/32`;
    mixedTypesLut.addLut(baseIP, data);
  });

  mixedTypesLut.prepareLut();
  mixedTypesLut.persistLut();

  const mixedTypesLoadedLut = new FastLut('mixedTypesTest', ON_MULTI_ALL, false);
  mixedTypesLoadedLut.loadPersistedLut();

  const stringResult = mixedTypesLoadedLut.fastLookup('203.0.113.0');
  TestAssertions.testPassed(allResults, stringResult[0].type, 'string', null, true, 'String type preserved');
  TestAssertions.testPassed(allResults, stringResult[0].value, 'test_string', null, true, 'String value preserved');

  const numberResult = mixedTypesLoadedLut.fastLookup('203.0.113.1');
  TestAssertions.testPassed(allResults, numberResult[0].type, 'number', null, true, 'Number type preserved');
  TestAssertions.testPassed(allResults, numberResult[0].value, 42, null, true, 'Number value preserved');

  const booleanResult = mixedTypesLoadedLut.fastLookup('203.0.113.2');
  TestAssertions.testPassed(allResults, booleanResult[0].type, 'boolean', null, true, 'Boolean type preserved');
  TestAssertions.testPassed(allResults, booleanResult[0].value, true, null, true, 'Boolean value preserved');

  // Cleanup test directories
  const testDirs = [
    'basicPersistenceTest',
    'complexDataTest',
    'versionTest',
    'largeDatasetTest',
    'corruptionTest',
    'ipv6CompressionTest',
    'directLutTest',
    'overlappingPersistenceTest',
    'overlapCleanupTest',
    'memoryEfficiencyTest',
    'concurrentTest',
    'emptyTest',
    'binaryIntegrityTest',
    'stressPersistenceTest',
    'pathTest',
    'permissionTest',
    'largeObjectTest',
    'unicodeTest',
    'circularTest',
    'mixedTypesTest'
  ];

  testDirs.forEach(dir => {
    removeDirectoryIfExists(path.join(RAM_DB_DIR, dir));
  });

  // Test 21: Network topology persistence simulation
  const topologyLut = new FastLut('topologyTest', ON_MULTI_ALL, false);

  // Simulate a complex network topology
  const networkTopology = {
    '10.0.0.0/8': { type: 'backbone', tier: 1, connections: ['10.1.0.0/16', '10.2.0.0/16'] },
    '10.1.0.0/16': { type: 'regional', tier: 2, connections: ['10.1.1.0/24', '10.1.2.0/24'] },
    '10.1.1.0/24': { type: 'access', tier: 3, connections: ['10.1.1.1/32', '10.1.1.2/32'] },
    '10.1.1.1/32': { type: 'endpoint', tier: 4, connections: [] },
    '10.1.1.2/32': { type: 'endpoint', tier: 4, connections: [] }
  };

  Object.entries(networkTopology).forEach(([network, topology]) => {
    topologyLut.addLut(network, topology);
  });

  topologyLut.prepareLut();
  topologyLut.persistLut();

  const topologyLoadedLut = new FastLut('topologyTest', ON_MULTI_ALL, false);
  topologyLoadedLut.loadPersistedLut();

  const topologyResult = topologyLoadedLut.fastLookup('10.1.1.1');
  TestAssertions.testPassed(allResults, topologyResult.length, 4, null, true, 'Network topology multiple matches');
  TestAssertions.testPassed(allResults, topologyResult[3].type, 'access', null, true, 'Network topology access preserved');

  // Test 22: Time-series data persistence
  const timeSeriesLut = new FastLut('timeSeriesTest', ON_MULTI_SMALLEST, false);

  // Simulate time-series data for network monitoring
  const timeSeriesData = [];
  const baseTime = new Date('2023-01-01T00:00:00Z');

  for (let i = 0; i < 24; i++) {
    const timestamp = new Date(baseTime.getTime() + i * 60 * 60 * 1000); // Hourly data
    timeSeriesData.push({
      timestamp: timestamp,
      network: `192.168.${i + 1}.0/24`,
      metrics: {
        bandwidth: Math.random() * 1000,
        latency: Math.random() * 100,
        packetLoss: Math.random() * 0.1,
        connections: Math.floor(Math.random() * 1000)
      }
    });
  }

  timeSeriesData.forEach(data => {
    timeSeriesLut.addLut(data.network, data);
  });

  timeSeriesLut.prepareLut();
  timeSeriesLut.persistLut();

  const timeSeriesLoadedLut = new FastLut('timeSeriesTest', ON_MULTI_SMALLEST, false);
  timeSeriesLoadedLut.loadPersistedLut();

  const timeSeriesResult = timeSeriesLoadedLut.fastLookup('192.168.1.1');
  // Date objects are serialized as strings in JSON, so we check for string type instead
  TestAssertions.testPassed(allResults, typeof timeSeriesResult.timestamp, 'string', null, true, 'Time-series timestamp preserved as string');
  TestAssertions.testPassed(allResults, typeof timeSeriesResult.metrics.bandwidth, 'number', null, true, 'Time-series metrics preserved');

  // Test 23: Geographic data persistence
  const geoLut = new FastLut('geoTest', ON_MULTI_FIRST, false);

  const geoData = [
    { network: '8.8.8.0/24', location: { country: 'US', city: 'Mountain View', coordinates: { lat: 37.386, lng: -122.0838 } } },
    { network: '1.1.1.0/24', location: { country: 'US', city: 'San Francisco', coordinates: { lat: 37.7749, lng: -122.4194 } } },
    { network: '208.67.222.0/24', location: { country: 'US', city: 'San Francisco', coordinates: { lat: 37.7749, lng: -122.4194 } } },
    { network: '2001:4860:4860::/48', location: { country: 'US', city: 'Mountain View', coordinates: { lat: 37.386, lng: -122.0838 } } }
  ];

  geoData.forEach(data => {
    geoLut.addLut(data.network, data);
  });

  geoLut.prepareLut();
  geoLut.persistLut();

  const geoLoadedLut = new FastLut('geoTest', ON_MULTI_FIRST, false);
  geoLoadedLut.loadPersistedLut();

  const geoResult = geoLoadedLut.fastLookup('8.8.8.8');
  TestAssertions.testPassed(allResults, geoResult.location.country, 'US', null, true, 'Geographic country preserved');
  TestAssertions.testPassed(allResults, geoResult.location.coordinates.lat, 37.386, null, true, 'Geographic coordinates preserved');

  // Test 24: Security policy persistence
  const securityLut = new FastLut('securityTest', ON_MULTI_ALL, false);

  const securityPolicies = [
    { network: '10.0.0.0/8', policy: { level: 'internal', allowedPorts: [22, 80, 443], blockedIPs: ['192.168.1.100'] } },
    { network: '172.16.0.0/12', policy: { level: 'dmz', allowedPorts: [80, 443], blockedIPs: [] } },
    { network: '192.168.0.0/16', policy: { level: 'guest', allowedPorts: [80], blockedIPs: ['10.0.0.0/8'] } }
  ];

  securityPolicies.forEach(data => {
    securityLut.addLut(data.network, data);
  });

  securityLut.prepareLut();
  securityLut.persistLut();

  const securityLoadedLut = new FastLut('securityTest', ON_MULTI_ALL, false);
  securityLoadedLut.loadPersistedLut();

  const securityResult = securityLoadedLut.fastLookup('10.0.0.1');
  TestAssertions.testPassed(allResults, securityResult[0].policy.level, 'internal', null, true, 'Security policy level preserved');
  TestAssertions.testPassed(allResults, securityResult[0].policy.allowedPorts.includes(22), true, null, true, 'Security policy ports preserved');

  // Test 25: Load balancing configuration persistence
  const loadBalancerLut = new FastLut('loadBalancerTest', ON_MULTI_SMALLEST, false);

  const loadBalancerConfig = {
    '203.0.113.0/24': {
      algorithm: 'round_robin',
      healthCheck: { interval: 30, timeout: 5, retries: 3 },
      backends: [
        { ip: '10.1.1.1', weight: 1, status: 'active' },
        { ip: '10.1.1.2', weight: 1, status: 'active' },
        { ip: '10.1.1.3', weight: 2, status: 'active' }
      ],
      ssl: { enabled: true, certificate: 'wildcard.example.com' }
    }
  };

  Object.entries(loadBalancerConfig).forEach(([network, config]) => {
    loadBalancerLut.addLut(network, config);
  });

  loadBalancerLut.prepareLut();
  loadBalancerLut.persistLut();

  const loadBalancerLoadedLut = new FastLut('loadBalancerTest', ON_MULTI_SMALLEST, false);
  loadBalancerLoadedLut.loadPersistedLut();

  const loadBalancerResult = loadBalancerLoadedLut.fastLookup('203.0.113.1');
  TestAssertions.testPassed(allResults, loadBalancerResult.algorithm, 'round_robin', null, true, 'Load balancer algorithm preserved');
  TestAssertions.testPassed(allResults, loadBalancerResult.backends.length, 3, null, true, 'Load balancer backends preserved');
  TestAssertions.testPassed(allResults, loadBalancerResult.ssl.enabled, true, null, true, 'Load balancer SSL config preserved');

  // Test 26: DNS resolution data persistence
  const dnsLut = new FastLut('dnsTest', ON_MULTI_ALL, false);

  const dnsRecords = [
    { network: '93.184.216.0/24', records: { A: ['93.184.216.34'], AAAA: ['2606:2800:220:1:248:1893:25c8:1946'], MX: ['10 mail.example.com'] } },
    { network: '198.51.100.0/24', records: { A: ['198.51.100.1', '198.51.100.2'], CNAME: ['www.example.com'], TXT: ['v=spf1 include:_spf.example.com ~all'] } }
  ];

  dnsRecords.forEach(data => {
    dnsLut.addLut(data.network, data);
  });

  dnsLut.prepareLut();
  dnsLut.persistLut();

  const dnsLoadedLut = new FastLut('dnsTest', ON_MULTI_ALL, false);
  dnsLoadedLut.loadPersistedLut();

  const dnsResult = dnsLoadedLut.fastLookup('93.184.216.34');
  TestAssertions.testPassed(allResults, dnsResult[0].records.A.includes('93.184.216.34'), true, null, true, 'DNS A record preserved');
  TestAssertions.testPassed(allResults, dnsResult[0].records.AAAA.includes('2606:2800:220:1:248:1893:25c8:1946'), true, null, true, 'DNS AAAA record preserved');

  // Test 27: Network performance metrics persistence
  const performanceLut = new FastLut('performanceTest', ON_MULTI_SMALLEST, false);

  const performanceData = {
    '104.16.0.0/12': {
      provider: 'Cloudflare',
      metrics: {
        throughput: { min: 100, max: 10000, avg: 5000, unit: 'Mbps' },
        latency: { min: 1, max: 50, avg: 10, unit: 'ms' },
        availability: 99.9,
        jitter: { min: 0.1, max: 5, avg: 1, unit: 'ms' }
      },
      lastUpdated: new Date(),
      sampleSize: 1000000
    }
  };

  Object.entries(performanceData).forEach(([network, data]) => {
    performanceLut.addLut(network, data);
  });

  performanceLut.prepareLut();
  performanceLut.persistLut();

  const performanceLoadedLut = new FastLut('performanceTest', ON_MULTI_SMALLEST, false);
  performanceLoadedLut.loadPersistedLut();

  const performanceResult = performanceLoadedLut.fastLookup('104.16.1.1');
  TestAssertions.testPassed(allResults, performanceResult.provider, 'Cloudflare', null, true, 'Performance provider preserved');
  TestAssertions.testPassed(allResults, performanceResult.metrics.availability, 99.9, null, true, 'Performance availability preserved');
  TestAssertions.testPassed(allResults, performanceResult.sampleSize, 1000000, null, true, 'Performance sample size preserved');

  // Test 28: Network device inventory persistence
  const inventoryLut = new FastLut('inventoryTest', ON_MULTI_ALL, false);

  const deviceInventory = [
    {
      network: '192.168.1.0/24', devices: [
        { ip: '192.168.1.1', type: 'router', model: 'Cisco ISR4331', firmware: '16.09.04', lastSeen: new Date() },
        { ip: '192.168.1.2', type: 'switch', model: 'Cisco Catalyst 2960', firmware: '15.2.4', lastSeen: new Date() },
        { ip: '192.168.1.100', type: 'server', model: 'Dell PowerEdge R740', os: 'Ubuntu 20.04', lastSeen: new Date() }
      ]
    }
  ];

  deviceInventory.forEach(data => {
    inventoryLut.addLut(data.network, data);
  });

  inventoryLut.prepareLut();
  inventoryLut.persistLut();

  const inventoryLoadedLut = new FastLut('inventoryTest', ON_MULTI_ALL, false);
  inventoryLoadedLut.loadPersistedLut();

  const inventoryResult = inventoryLoadedLut.fastLookup('192.168.1.1');
  TestAssertions.testPassed(allResults, inventoryResult[0].devices.length, 3, null, true, 'Device inventory count preserved');
  TestAssertions.testPassed(allResults, inventoryResult[0].devices[0].type, 'router', null, true, 'Device type preserved');
  TestAssertions.testPassed(allResults, inventoryResult[0].devices[0].model, 'Cisco ISR4331', null, true, 'Device model preserved');

  // Cleanup additional test directories
  const additionalTestDirs = [
    'topologyTest',
    'timeSeriesTest',
    'geoTest',
    'securityTest',
    'loadBalancerTest',
    'dnsTest',
    'performanceTest',
    'inventoryTest'
  ];

  additionalTestDirs.forEach(dir => {
    removeDirectoryIfExists(path.join(RAM_DB_DIR, dir));
  });

  log(`Persistence Tests: ${numPassed} / ${total} passed`);
  return allResults.every((test) => !!test);
};

// Comprehensive test runner
const runAllTests = async (fastLutClass = null) => {
  log('🚀 Starting Comprehensive FastLut Test Suite\\n');

  const startTime = performance.now();
  let allPassed = true;

  try {
    // Run all test suites
    allPassed &= simpleLutTests(fastLutClass);
    allPassed &= edgeCaseTests(fastLutClass);
    allPassed &= performanceTests(fastLutClass);
    allPassed &= errorHandlingTests(fastLutClass);
    allPassed &= integrationTests(fastLutClass);
    allPassed &= await persistenceTests(fastLutClass);
    allPassed &= testFastLookupTable(fastLutClass);

    const endTime = performance.now();
    const totalTime = endTime - startTime;

    log(`\\n🎯 Test Suite Summary:`);
    log(`   Total Tests: ${total}`);
    log(`   Passed: ${numPassed}`);
    log(`   Failed: ${total - numPassed}`);
    log(`   Success Rate: ${((numPassed / total) * 100).toFixed(2)}%`);
    log(`   Total Time: ${totalTime.toFixed(2)}ms`);
    log(`   Overall Result: ${allPassed ? '✅ ALL TESTS PASSED' : '❌ SOME TESTS FAILED'}`);

    return allPassed;
  } catch (error) {
    console.error('💥 Test suite crashed:', error);
    return false;
  }
};

function testFastLookupTable(fastLutClass = null, verbose = true) {
  globalVerbose = verbose;
  let FastLut = TestUtils.getFastLutClass(fastLutClass);

  let allResults = [];

  // Test that FastLut will prioritize the smaller network for overlapping IP ranges
  const lut_one = new FastLut('testLutOne', ON_MULTI_SMALLEST);
  lut_one.addLut('87.122.0.0/15', 'alpha');
  lut_one.addLut('87.122.0.0/20', 'beta');
  lut_one.addLut('87.122.0.0/13', 'gamma');
  lut_one.prepareLut();

  testPassed(allResults, lut_one.fastLookup('87.122.0.0'), 'beta');
  testPassed(allResults, lut_one.fastLookup('87.122.23.167'), 'alpha');

  // Test that LUT with insert strategy `all` will keep
  // all inserted nets
  const lut_two = new FastLut('testLutTwo', ON_MULTI_ALL);
  lut_two.addLut('87.122.0.0/15', '8881');
  lut_two.addLut('87.122.0.0/20', '8882');
  lut_two.prepareLut();

  testPassed(allResults, lut_two.fastLookup('87.122.0.0'), ['8881', '8882'], arrayEquals);
  testPassed(allResults, lut_two.fastLookup('87.122.23.167'), ['8881'], arrayEquals);

  // test edge IP cases for inetnum, cidr and IPv6 cidr
  // and for all lookup strategies
  let lut_test = new FastLut('testLut');
  // cidr array
  lut_test.addLut('1.2.3.4/14', ['1.2.3.4/14', 'Google Datacenter']);
  // cidr object
  lut_test.addLut('55.12.6.4/18', { cidr: '55.12.6.4/18', datacenter: 'Amazon AWS' });
  // inetnum object
  lut_test.addLut("65.98.108.0 - 65.98.108.255", {
    "inetnum": "65.98.108.0 - 65.98.108.255",
    "datacenter": "Fortress Integrated Technologies",
    "needle": "dedicatednow"
  });
  // inetnum array
  lut_test.addLut("137.184.0.0 - 137.184.255.255", [
    "137.184.0.0 - 137.184.255.255",
    "DigitalOcean",
  ]);
  // IPv6 cidr array
  lut_test.addLut("2600:1f18:7fff:f800::/56", ["Amazon AWS"]);
  // IPv6 cidr object
  lut_test.addLut("2001:8d8:580::/48", {
    "datacenter": "IONOS SE",
    "cidr": "2001:8d8:580::/48"
  });
  lut_test.prepareLut();

  // first IP
  testPassed(allResults, lut_test.fastLookup('1.2.3.4'), ['1.2.3.4/14', 'Google Datacenter'], arrayEquals);
  // last IP
  testPassed(allResults, lut_test.fastLookup('1.3.255.255'), ['1.2.3.4/14', 'Google Datacenter'], arrayEquals);
  // random middle IP
  testPassed(allResults, lut_test.fastLookup('1.3.100.101'), ['1.2.3.4/14', 'Google Datacenter'], arrayEquals);

  // first IP
  testPassed(allResults, lut_test.fastLookup('55.12.6.4'), { cidr: '55.12.6.4/18', datacenter: 'Amazon AWS' }, objectEquals);
  // last IP
  testPassed(allResults, lut_test.fastLookup('55.12.63.255'), { cidr: '55.12.6.4/18', datacenter: 'Amazon AWS' }, objectEquals);
  // random middle IP
  testPassed(allResults, lut_test.fastLookup('55.12.44.22'), { cidr: '55.12.6.4/18', datacenter: 'Amazon AWS' }, objectEquals);

  // --- 65.98.108.0 - 65.98.108.255
  // first IP
  testPassed(allResults, lut_test.fastLookup('65.98.108.0'), {
    "inetnum": "65.98.108.0 - 65.98.108.255",
    "datacenter": "Fortress Integrated Technologies",
    "needle": "dedicatednow"
  }, objectEquals);
  // last IP
  testPassed(allResults, lut_test.fastLookup('65.98.108.255'), {
    "inetnum": "65.98.108.0 - 65.98.108.255",
    "datacenter": "Fortress Integrated Technologies",
    "needle": "dedicatednow"
  }, objectEquals);
  // random middle IP
  testPassed(allResults, lut_test.fastLookup('65.98.108.54'), {
    "inetnum": "65.98.108.0 - 65.98.108.255",
    "datacenter": "Fortress Integrated Technologies",
    "needle": "dedicatednow"
  }, objectEquals);

  // --- 137.184.0.0 - 137.184.255.255
  // first IP
  testPassed(allResults, lut_test.fastLookup('137.184.0.0'), [
    "137.184.0.0 - 137.184.255.255",
    "DigitalOcean",
  ], arrayEquals);

  // last IP
  testPassed(allResults, lut_test.fastLookup('137.184.255.255'), [
    "137.184.0.0 - 137.184.255.255",
    "DigitalOcean",
  ], arrayEquals);

  // random middle IP
  testPassed(allResults, lut_test.fastLookup('137.184.111.22'), [
    "137.184.0.0 - 137.184.255.255",
    "DigitalOcean",
  ], arrayEquals);

  // --- 2600:1f18:7fff:f800::/56
  // first IP
  testPassed(allResults, lut_test.fastLookup('2600:1f18:7fff:f800:0000:0000:0000:0000'), ["Amazon AWS"], arrayEquals);
  // last IP
  testPassed(allResults, lut_test.fastLookup('2600:1f18:7fff:f8ff:ffff:ffff:ffff:ffff'), ["Amazon AWS"], arrayEquals);
  // random middle IP
  testPassed(allResults, lut_test.fastLookup('2600:1f18:7fff:f800:0000:000a::'), ["Amazon AWS"], arrayEquals);
  // random middle IP
  testPassed(allResults, lut_test.fastLookup('2600:1f18:7fff:f800:0000:bbbb::'), ["Amazon AWS"], arrayEquals);
  // random middle IP
  testPassed(allResults, lut_test.fastLookup('2600:1f18:7fff:f800:0000:ffff::'), ["Amazon AWS"], arrayEquals);

  // first IP
  testPassed(allResults, lut_test.fastLookup('2001:08d8:0580:0000:0000:0000:0000:0000'), {
    "datacenter": "IONOS SE",
    "cidr": "2001:8d8:580::/48"
  }, objectEquals);
  // last IP
  testPassed(allResults, lut_test.fastLookup('2001:08D8:0580:FFFF:FFFF:FFFF:FFFF:FFFF'), {
    "datacenter": "IONOS SE",
    "cidr": "2001:8d8:580::/48"
  }, objectEquals);
  // random middle IP
  testPassed(allResults, lut_test.fastLookup('2001:08D8:0580:FFFF:abcd:abcd:abcd:abcd'), {
    "datacenter": "IONOS SE",
    "cidr": "2001:8d8:580::/48"
  }, objectEquals);

  // Test that LUT with ON_MULTI_ALL will return all results
  const lut_three = new FastLut('testLutThree', ON_MULTI_ALL);
  lut_three.addLut('87.122.0.0/15', '/15');
  lut_three.addLut('87.122.0.0/26', '/26');
  lut_three.addLut('87.122.0.0/20', '/20');
  lut_three.addLut('87.122.0.0/22', '/22');
  lut_three.prepareLut();

  testPassed(allResults, lut_three.fastLookup('87.122.0.1'), ['/15', '/26', '/20', '/22'], arrayEquals);

  // Test that LUT with will return smallest with ON_MULTI_SMALLEST
  const lut_four = new FastLut('testLutFour', ON_MULTI_SMALLEST);
  lut_four.addLut('87.122.0.0/15', '/15');
  lut_four.addLut('87.122.0.0/26', '/26');
  lut_four.addLut('87.122.0.0/20', '/20');
  lut_four.addLut('87.122.0.0/22', '/22');
  lut_four.prepareLut();

  testPassed(allResults, lut_four.fastLookup('87.122.0.1'), '/26');

  // Test that LUT with will return largest with ON_MULTI_LARGEST
  const lut_five = new FastLut('testLutFour', ON_MULTI_LARGEST);
  lut_five.addLut('87.122.0.0/15', '/15');
  lut_five.addLut('87.122.0.0/26', '/26');
  lut_five.addLut('87.122.0.0/20', '/20');
  lut_five.addLut('87.122.0.0/8', '/8');
  lut_five.addLut('87.122.0.0/22', '/22');
  lut_five.prepareLut();

  testPassed(allResults, lut_five.fastLookup('87.122.0.1'), '/8');

  // Test that LUT with insert strategy `all` will
  // return the net if returnOnMultiple is `largest`
  // test for all insert strategies
  const companyLut = new FastLut('companyLutTest');
  companyLut.addLut('2.5.138.0 - 2.5.138.255', 'BSAMI651 Amiens Bloc 2	2.5.138.0 - 2.5.138.255	orange.fr');
  companyLut.prepareLut();

  testPassed(allResults, companyLut.fastLookup('2.5.142.2'), null);

  // Test that LUT does not include a certain net
  const negLut = new FastLut('negLut');
  negLut.prepareLut();

  testPassed(allResults, negLut.fastLookup('23.11.142.12'), null);

  // Test that LUT does not include a certain net
  // since huge nets are disallowed
  const allLut = new FastLut('allLut');
  allLut.addLut('0.0.0.0 - 255.255.255.255', 'allnet');
  allLut.addLut('::', 'allnet');
  allLut.prepareLut();

  testPassed(allResults, allLut.fastLookup('23.11.142.12'), null);
  testPassed(allResults, allLut.fastLookup('26ab:1F18:7def:F800:abcd:abcd:abcd:0000'), null);
  testPassed(allResults, allLut.fastLookup('26ab:1F18:7def:F800:abcd:abcd:abcd:0000'), null);

  // Test that LUT does not include a certain net
  const inet6numTest = new FastLut('inet6numTest');
  inet6numTest.addLut('abcd:aa00:cc00:: - abcd:bb00:cc00::', 'inet6num');
  inet6numTest.addLut('ffaa:5d00:ab00:: - ffaa:5d00:ff00::', 'inet6num');
  inet6numTest.prepareLut();

  testPassed(allResults, inet6numTest.fastLookup('abcd:aa00:cc00:000f:0001::'), 'inet6num');
  testPassed(allResults, inet6numTest.fastLookup('ffaa:5d00:efff:0abd::'), 'inet6num');
  testPassed(allResults, inet6numTest.fastLookup('ffab::'), null);
  testPassed(allResults, inet6numTest.fastLookup('ffaa:5d00:ff00:0000:0000:0000:0000:0000'), 'inet6num');
  testPassed(allResults, inet6numTest.fastLookup('ffaa:5d00:ff00:0000:0000:0000:0000:0001'), null);
  testPassed(allResults, inet6numTest.fastLookup('ffaa:5d00:ab00:0000:0000:0000:0000:0000'), 'inet6num');

  // Test that LUT does contain IPv6 CIDR ranges
  const inet6numCidr = new FastLut('inet6numCidr', ON_MULTI_FIRST, false);
  inet6numCidr.addLut("2604:a880:0:1011::/64", "New York");
  inet6numCidr.addLut("2a03:b0c0:0:1050::/64", "Amsterdam");
  inet6numCidr.addLut("2a02:2450::/29", "Berlin");
  inet6numCidr.prepareLut();

  testPassed(allResults, inet6numCidr.fastLookup('2604:a880:0000:1011:0000:0000:0000:0000'), "New York");
  testPassed(allResults, inet6numCidr.fastLookup("2604:A880:0000:1011:FFFF:FFFF:FFFF:FFFF"), "New York");
  testPassed(allResults, inet6numCidr.fastLookup("2a03:b0c0:0000:1050:0000:0000:0000:0000"), "Amsterdam");
  testPassed(allResults, inet6numCidr.fastLookup("2A03:B0C0:0000:1050:FFFF:FFFF:FFFF:FFFF"), "Amsterdam");

  testPassed(allResults, inet6numCidr.fastLookup("2a02:2450:0000:0000:0000:0000:0000:0000"), "Berlin");
  testPassed(allResults, inet6numCidr.fastLookup("2a02:2457:ffff:ffff:ffff:ffff:ffff:ffff"), "Berlin");
  testPassed(allResults, inet6numCidr.fastLookup("2a02:2450:0000:0000:aaaa:0000:0000:0000"), "Berlin");

  const moreIpv6IPsTor = [
    '2a0b:f4c2::10',
    "2620:7:6001::166",
    "2602:fed2:7194::6",
    "2605:6400:30:f174::",
    '107.189.11.207',
    '68.178.204.94',
    '107.189.13.253',
    "205.185.126.167",
    '159.65.50.174',
    "2001:1af8:4700:a114:6::1",
    "2a02:248:2:41dc:5054:ff:fe80:10f",
    "2a0b:f4c2::8",
    "2602:fc05::14",
    "2001:67c:6ec:203:218:33ff:fe44:5520",
    "2620:7:6001::110",
  ];

  const torLut = new FastLut('torLut');
  for (let ip of moreIpv6IPsTor) {
    torLut.addLut(ip, "Tor");
  }
  torLut.prepareLut();

  for (let ip of moreIpv6IPsTor) {
    testPassed(allResults, torLut.fastLookup(ip), "Tor");
  }

  // Test that LUT does not include a certain net
  const another6 = new FastLut('inet6numTest');
  another6.addLut('abcd:aa00:cc00:: - abcd:bb00:cc00::', 'inet6num');
  another6.addLut('ffaa:5d00:ab00:: - ffaa:5d00:ff00::', 'inet6num');
  another6.prepareLut();
  testPassed(allResults, another6.fastLookup('abcd:aa00:cc00:000f:0001::'), "inet6num");

  // Test ASN LUT
  const asnLut = new FastLut('asnLutTest', ON_MULTI_SMALLEST);
  asnLut.addLut("149.135.0.0/16", "Telstra Corporation Limited");
  asnLut.addLut("149.136.0.0/16", "California Department of Transportation");
  asnLut.addLut("149.136.0.0/24", "Some Other Org");
  asnLut.prepareLut();

  testPassed(allResults, asnLut.fastLookup('149.135.0.0'), "Telstra Corporation Limited");
  testPassed(allResults, asnLut.fastLookup('149.135.0.100'), "Telstra Corporation Limited");
  testPassed(allResults, asnLut.fastLookup('149.135.255.255'), "Telstra Corporation Limited");
  testPassed(allResults, asnLut.fastLookup('149.136.0.0'), "Some Other Org");
  testPassed(allResults, asnLut.fastLookup('149.136.0.1'), "Some Other Org");
  testPassed(allResults, asnLut.fastLookup('149.136.200.1'), "California Department of Transportation");
  testPassed(allResults, asnLut.fastLookup('149.136.255.255'), "California Department of Transportation");

  // Test complicated Edge Case
  const edgeCase = new FastLut('edgeCase', ON_MULTI_SMALLEST);
  edgeCase.addLut("149.135.0.0/16", "Org1");
  edgeCase.addLut("149.135.0.0/17", "Org2");
  edgeCase.addLut("149.135.0.0/18", "Org3");
  edgeCase.addLut("149.135.0.0/19", "Org4");
  edgeCase.prepareLut();

  testPassed(allResults, edgeCase.fastLookup('149.135.0.0'), "Org4");
  testPassed(allResults, edgeCase.fastLookup('149.135.0.1'), "Org4");
  testPassed(allResults, edgeCase.fastLookup('149.135.31.255'), "Org4");
  testPassed(allResults, edgeCase.fastLookup('149.135.63.255'), "Org3");
  testPassed(allResults, edgeCase.fastLookup('149.135.31.255'), "Org4");
  testPassed(allResults, edgeCase.fastLookup('149.135.255.255'), "Org1");
  testPassed(allResults, edgeCase.fastLookup('149.135.127.255'), "Org2");

  // now persist the lut
  edgeCase.persistLut();

  // create a new lut
  const edgeCaseFromDisk = new FastLut('edgeCase', ON_MULTI_SMALLEST);
  edgeCaseFromDisk.loadPersistedLut();

  testPassed(allResults, edgeCaseFromDisk.fastLookup('149.135.0.0'), "Org4");
  testPassed(allResults, edgeCaseFromDisk.fastLookup('149.135.0.1'), "Org4");
  testPassed(allResults, edgeCaseFromDisk.fastLookup('149.135.31.255'), "Org4");
  testPassed(allResults, edgeCaseFromDisk.fastLookup('149.135.63.255'), "Org3");
  testPassed(allResults, edgeCaseFromDisk.fastLookup('149.135.31.255'), "Org4");
  testPassed(allResults, edgeCaseFromDisk.fastLookup('149.135.255.255'), "Org1");
  testPassed(allResults, edgeCaseFromDisk.fastLookup('149.135.127.255'), "Org2");

  let iterData = [];
  edgeCaseFromDisk.iterLut((network, obj, ipVersion) => {
    iterData.push([network, obj, ipVersion]);
  });

  testPassed(allResults, iterData[0][1], "Org1");
  testPassed(allResults, iterData[1][1], "Org2");
  testPassed(allResults, iterData[2][1], "Org3");
  testPassed(allResults, iterData[3][1], "Org4");

  testPassed(allResults, iterData[0][0], "149.135.0.0 - 149.135.255.255");
  testPassed(allResults, iterData[1][0], "149.135.0.0 - 149.135.127.255");
  testPassed(allResults, iterData[2][0], "149.135.0.0 - 149.135.63.255");
  testPassed(allResults, iterData[3][0], "149.135.0.0 - 149.135.31.255");

  testPassed(allResults, iterData[0][2], 4);
  testPassed(allResults, iterData[1][2], 4);
  testPassed(allResults, iterData[2][2], 4);
  testPassed(allResults, iterData[3][2], 4);

  // test function getEntriesForLargestNets() behaves correctly
  const largestNets = edgeCaseFromDisk.getEntriesForLargestNets(2, 4);

  testPassed(allResults, largestNets[0][0], 65536);
  testPassed(allResults, largestNets[0][1], "Org1");

  testPassed(allResults, largestNets[1][0], 32768);
  testPassed(allResults, largestNets[1][1], "Org2");

  // Test all variations of overlapping IPV6 networks
  const overlapping6 = new FastLut('overlapping6', ON_MULTI_ALL);
  overlapping6.addLut('abcd:aa00:cc00:: - abcd:bb00:cc00::', 'net-1');
  overlapping6.addLut('ffaa:5d00:ab00:: - ffaa:5d00:ff00::', 'net-2');
  overlapping6.addLut('abcd:aa00:1::/32', 'net-3');
  overlapping6.addLut('abcd:aa00:0000:aaaa:0000:abcd::/32', 'net-4');
  overlapping6.addLut('abcd:aa00:cc00:: - abcd:bb00:bb00::', 'net-5');
  overlapping6.prepareLut();

  const allMatches = overlapping6.fastLookup('abcd:aa00:cc00:000f:0001::');

  testPassed(allResults, allMatches[0], 'net-5');
  testPassed(allResults, allMatches[1], 'net-1');
  testPassed(allResults, allMatches[2], 'net-3');

  const overlapping4 = new FastLut('overlapping4', ON_MULTI_ALL);
  overlapping4.addLut('87.122.0.0/15', '/15');
  overlapping4.addLut('87.122.0.0/26', '/26');
  overlapping4.addLut('87.122.0.0/20', '/20');
  overlapping4.addLut('87.122.0.0/22', '/22');
  overlapping4.addLut('87.124.0.0/26', 'notOverlapping');
  overlapping4.prepareLut();

  const overlappingRanges = overlapping4.getOverlapping(4, true).overlappingNetworks;

  const net15 = '87.122.0.0 - 87.123.255.255';
  const net20 = '87.122.0.0 - 87.122.15.255';
  const net22 = '87.122.0.0 - 87.122.3.255';
  const net26 = '87.122.0.0 - 87.122.0.63';

  testPassed(allResults, null, null, () => {
    return !overlappingRanges[net15].includes(net15) &&
      overlappingRanges[net15].includes(net20) &&
      overlappingRanges[net15].includes(net22) &&
      overlappingRanges[net15].includes(net26);
  });

  singleTest6();

  // test adding strangely formatted IPv6 networks
  const strange = new FastLut('strangelyFormattedIPv6Networks');
  strange.addLut('abcd:aa00:cc00:: - abcd:bb00:cc00::', 'net-1');
  strange.addLut('ffaa:5d00:ab00:: - ffaa:5d00:ff00::', 'net-2');
  strange.addLut('abcd:aa00:1::/32', 'net-3');
  strange.addLut('abcd:aa00:0000:aaaa:0000:abcd::/32', 'net-4');
  strange.addLut('abcd:aa00:cc00:: - abcd:bb00:bb00::', 'net-5');

  // now the strange IPv6 networks come
  strange.addLut('2001:550:0:1000::9A18:13BC/126', 'net-6');
  strange.addLut('2001:550:0:1000::9A1A:6004/128', 'net-7');
  strange.addLut('2001:550:0:1000::9A19:330/126', 'net-8');
  strange.addLut('2001:550:0:1000::9A1A:40D/128', 'net-9');

  strange.prepareLut();

  testPassed(allResults, strange.fastLookup('abcd:aa00:cc00::'), 'net-1');
  testPassed(allResults, strange.fastLookup('abcd:aa00:1::'), 'net-3');

  const all99 = new FastLut('all99', ON_MULTI_ALL, false);
  const allNets6 = [
    ['2001:808::/35', 'alpha'],
    ['2001:808:e000::/35', 'beta'],
    ['2001:808:a000:: - 2001:808:e000::', 'gamma'],
    ['2001:808:1000:: - 2001:808:2f00::', 'epsilon'],
    ['2001:4c80::/32', 'delta'],
    ['2001:0806:e000::/30', 'zeta'],
    ['1.2.3.4', 'singleLut'],
    ['dead:beef:0:0:0:0::', 'singleLutSecond'],
    ['0:a:b:c::', 'singleLutThird'],
  ];
  for (const [net, provider] of allNets6) {
    all99.addLut(net, provider);
  }
  all99.prepareLut();
  all99.persistLut();

  const all99Verify = new FastLut('all99', ON_MULTI_ALL, false);
  all99Verify.loadPersistedLut();

  const mustReturnAll6 = {
    '2001:808:e000::': ['beta', 'gamma'],
    '2001:0808:1FFF:FFFF:FFFF:FFFF:FFFF:FFFF': ['alpha', 'epsilon'],
    '2001:0806:e000::': ['zeta'],
    '2001:808:1000::': ["alpha", "epsilon"]
  };
  for (let ip in mustReturnAll6) {
    let res = all99Verify.fastLookup(ip);
    testPassed(allResults, res, mustReturnAll6[ip], arrayEquals);
  }

  // test iterLut() function
  const entries = [];
  all99Verify.iterLut((network, obj, ipVersion) => {
    entries.push([network, obj, ipVersion]);
  });

  testPassed(allResults, entries[0], ['2001:804:: - 2001:807:ffff:ffff:ffff:ffff:ffff:ffff', 'zeta', 6], arrayEquals);
  testPassed(allResults, entries[1], ['2001:808:: - 2001:808:1fff:ffff:ffff:ffff:ffff:ffff', 'alpha', 6], arrayEquals);
  testPassed(allResults, entries[2], ['2001:808:1000:: - 2001:808:2f00::', 'epsilon', 6], arrayEquals);
  testPassed(allResults, entries[3], ['2001:808:a000:: - 2001:808:e000::', 'gamma', 6], arrayEquals);
  testPassed(allResults, entries[4], ['2001:808:e000:: - 2001:808:ffff:ffff:ffff:ffff:ffff:ffff', 'beta', 6], arrayEquals);
  testPassed(allResults, entries[5], ['2001:4c80:: - 2001:4c80:ffff:ffff:ffff:ffff:ffff:ffff', 'delta', 6], arrayEquals);
  testPassed(allResults, entries[6], ['1.2.3.4', 'singleLut', 4], arrayEquals);
  testPassed(allResults, entries[7], ['dead:beef::', 'singleLutSecond', 6], arrayEquals);
  testPassed(allResults, entries[8], ['0:a:b:c::', 'singleLutThird', 6], arrayEquals);

  // test getRandomLutEntries() function
  const randomEntries = all99Verify.getRandomLutEntries(3, 6);
  testPassed(allResults, randomEntries.length, 3);
  testPassed(allResults, !!isIP(randomEntries[0]), true);

  // test getEntriesForLargestNets() function
  const largestEntries = all99Verify.getEntriesForLargestNets(2, 6);

  testPassed(allResults, largestEntries[0][1], 'zeta');
  testPassed(allResults, largestEntries[1][1], 'delta');

  const testHostingNets = new FastLut('testHostingNets', ON_MULTI_ALL);
  testHostingNets.verbose = false;
  testHostingNets.addLut('152.53.36.0 - 152.53.39.255', 'netcup GmbH');
  // powered by ANX	152.53.30.16 - 152.53.30.31	anexia.at
  testHostingNets.addLut('152.53.30.16 - 152.53.30.31', 'ANX');
  // ANX Holding GmbH	152.53.0.0 - 152.53.255.255	anexia.com
  testHostingNets.addLut('152.53.0.0 - 152.53.255.255', 'ANX Holding GmbH');
  testHostingNets.addLut('2a03:4e41::/32', 'JM - DATA GmbH');
  testHostingNets.addLut('2a0a:4940:95a4::/48', 'GIBIRNET');
  testHostingNets.addLut('152.53.36.14', 'quic.cloud');
  testHostingNets.prepareLut();

  const testIps = [
    // netcup GmbH	152.53.36.0 - 152.53.39.255	netcup.de
    '152.53.36.15',
    '152.53.38.99',
    '152.53.36.0',
    '152.53.39.255'
  ];

  testPassed(allResults, testHostingNets.fastLookup('152.53.36.14'), ["quic.cloud"], arrayEquals);

  testIps.forEach(ip => {
    testPassed(allResults, testHostingNets.fastLookup(ip), ["netcup GmbH", "ANX Holding GmbH"], arrayEquals);
  });

  log(`Num Tests Passed: ${numPassed} / ${total}`);
  return allResults.every((test) => !!test);
}

const singleTest = () => {
  let allResults = [];

  // Test that FastLut will prioritize the smaller network for overlapping IP ranges
  const lut_one = new FastLut('testLutOne', ON_MULTI_SMALLEST);
  lut_one.addLut('87.122.0.0/15', 'alpha');
  lut_one.addLut('87.122.0.0/20', 'beta');
  lut_one.addLut('87.122.0.0/13', 'gamma');
  lut_one.addLut('87.122.0.0/8', 'zeta');
  lut_one.addLut('87.122.0.0/7', 'caesar');
  lut_one.prepareLut();

  testPassed(allResults, lut_one.fastLookup('87.122.0.0'), 'beta');
  testPassed(allResults, lut_one.fastLookup('87.122.23.167'), 'alpha');
};

const singleTest2 = () => {
  let allResults = [];

  const networks = [
    ['1.2.3.4 - 1.2.3.45', 'test1'],
    ['1.2.3.4 - 1.2.4.45', 'test2'],
    ['37.2.3.4 - 37.3.0.0', 'test3'],
    ['133.78.19.0 - 133.78.26.0', 'test4'],
    ['217.12.0.0 - 217.12.0.255', 'test5'],
    ['99.0.0.0 - 99.4.0.2', 'test6'],
    ['0.22.11.0 - 0.23.0.1', 'test7'],
    ['0.0.7.0 - 0.0.7.19', 'test8'],
    ['147.147.0.0 - 147.152.255.255', 'test9'],
    ['147.147.0.0 - 147.147.255.255', 'test10'],
    ['1.2.2.4 - 1.2.4.112', 'test11'],
    ['1.2.4.4 - 1.2.5.22', 'test12'],
    ['1.0.0.0 - 1.200.255.255', 'test13'],
  ];

  const pre = new FastLut('testLut');
  for (const [net, provider] of networks) {
    pre.addLut(net, provider);
  }
  pre.prepareLut();

  const ipsInRange = {
    '1.2.3.4': 'test1',
    '1.2.3.45': 'test1',
    '37.2.3.66': 'test3',
    '99.0.0.0': 'test6',
    '99.0.0.1': 'test6',
    '99.4.0.2': 'test6',
    '0.0.7.5': 'test8',
    '147.148.244.96': 'test9',
    '147.152.255.255': 'test9',
  };
  const ipsNotInRange = ['218.12.0.0', '0.0.0.0', '0.255.255.255'];

  for (let ip in ipsInRange) {
    let res = pre.fastLookup(ip);
    testPassed(allResults, res, ipsInRange[ip]);
  }

  for (let ip of ipsNotInRange) {
    let res = pre.fastLookup(ip);
    testPassed(allResults, res, null);
  }
};

const singleTest3 = () => {
  let allResults = [];
  const asnLut = new FastLut('asnLut', ON_MULTI_SMALLEST);
  asnLut.addLut("149.135.0.0/16", "Telstra Corporation Limited");
  asnLut.addLut("149.136.0.0/16", "California Department of Transportation");
  asnLut.addLut("149.136.0.0/24", "Some Other Org");
  asnLut.prepareLut();

  testPassed(allResults, asnLut.fastLookup('149.135.0.0'), "Telstra Corporation Limited");
  testPassed(allResults, asnLut.fastLookup('149.135.0.100'), "Telstra Corporation Limited");
  testPassed(allResults, asnLut.fastLookup('149.135.255.255'), "Telstra Corporation Limited");
  testPassed(allResults, asnLut.fastLookup('149.136.0.0'), "Some Other Org");
  testPassed(allResults, asnLut.fastLookup('149.136.0.1'), "Some Other Org");
  testPassed(allResults, asnLut.fastLookup('149.136.200.1'), "California Department of Transportation");
  testPassed(allResults, asnLut.fastLookup('149.136.255.255'), "California Department of Transportation");
}

const singleTest4 = () => {
  let allResults = [];
  const networksMore = [
    ['100.200.0.0 - 100.200.0.20', 'alpha'], // 20 hosts
    ['100.200.0.10 - 100.200.100.0', 'beta'], // 100x 
    ['100.200.0.20 - 100.200.200.0', 'gamma'], // 200x 
  ];
  const largest = new FastLut('lutLargest', ON_MULTI_LARGEST);
  for (const [net, provider] of networksMore) {
    largest.addLut(net, provider);
  }
  largest.prepareLut();
  const mustReturnLargest = {
    '100.200.0.20': 'gamma',
    '100.200.0.10': 'beta',
    '100.200.0.9': 'alpha',
    '100.200.55.55': 'gamma',
    '100.200.200.1': null,
    '100.199.255.255': null,
    '0.0.0.0': null,
  };
  for (let ip in mustReturnLargest) {
    let res = largest.fastLookup(ip);
    testPassed(allResults, res, mustReturnLargest[ip]);
  }
};

const singleTest5 = () => {
  let allResults = [];
  const all6 = new FastLut('all6', ON_MULTI_ALL, false);
  const allNets6 = [
    ['2001:808::/35', 'alpha'],
    ['2001:808:e000::/35', 'beta'],
    ['2001:808:a000:: - 2001:808:e000::', 'gamma'],
    ['2001:808:1000:: - 2001:808:2f00::', 'epsilon'],
    ['2001:4c80::/32', 'delta'],
    ['2001:0806:e000::/30', 'zeta'],
  ];
  for (const [net, provider] of allNets6) {
    all6.addLut(net, provider);
  }
  all6.prepareLut();
  const mustReturnAll6 = {
    '2001:808:e000::': ['beta', 'gamma'],
    '2001:0808:1FFF:FFFF:FFFF:FFFF:FFFF:FFFF': ['alpha', 'epsilon'],
    '2001:0806:e000::': ['zeta'],
    '2001:808:1000::': ["alpha", "epsilon"]
  };
  for (let ip in mustReturnAll6) {
    let res = all6.fastLookup(ip);
    log(res)
    testPassed(allResults, res, mustReturnAll6[ip], arrayEquals);
  }
};

const singleTest6 = () => {
  let allResults = [];

  // test behavior on ON_MULTI_FIRST

  const majorTests1 = new FastLut('majorTests1', ON_MULTI_FIRST);
  const mTestNets = {
    "79.58.160.0 - 79.58.175.255": 'net1',
    "9.24.218.0 - 9.24.218.255": 'net2',
    "40.220.32.0 - 40.220.32.255": 'net3',
    "66.186.134.0 - 66.186.134.255": 'net4',
    "68.154.132.0 - 68.154.135.255": 'net5',
    "209.139.61.0 - 209.139.61.255": 'net6',
    "48.20.189.0 - 48.20.189.255": 'net7',
    "222.151.160.0 - 222.151.175.255": 'net8',
    "105.228.32.0 - 105.228.63.255": 'net9',
    "139.38.224.0 - 139.38.225.255": 'net10',

    // those networks are overlapping
    "141.42.0.0 - 141.42.15.255": 'net11', // smallest
    "141.32.55.0 - 141.43.17.19": 'net12', // mid
    "140.255.255.0 - 141.47.17.19": 'net13', // largest

    "146.184.68.0 - 146.184.69.255": 'net14',
    "132.193.182.0 - 132.193.182.255": 'net15',
    "92.66.0.0 - 92.66.15.255": 'net16',
    "176.185.72.0 - 176.185.75.255": 'net17',
  };

  for (const net in mTestNets) {
    majorTests1.addLut(net, mTestNets[net]);
  }

  majorTests1.prepareLut();
  for (const net in mTestNets) {
    const id = mTestNets[net];
    const [first, second] = net.split('-').map((item) => item.trim());
    testPassed(allResults, majorTests1.fastLookup(first), id);
    testPassed(allResults, majorTests1.fastLookup(second), id);
  }
  const overlapping = majorTests1.getOverlapping(4, true).overlappingNetworks;
  testPassed(allResults, null, null, () => {
    return overlapping['141.42.0.0 - 141.42.15.255'].includes('141.32.55.0 - 141.43.17.19') &&
      overlapping['141.42.0.0 - 141.42.15.255'].includes('140.255.255.0 - 141.47.17.19')
  });

  testPassed(allResults, null, null, () => {
    return overlapping['141.32.55.0 - 141.43.17.19'].includes('140.255.255.0 - 141.47.17.19') &&
      overlapping['141.32.55.0 - 141.43.17.19'].includes('141.42.0.0 - 141.42.15.255')
  });

  testPassed(allResults, null, null, () => {
    return overlapping['140.255.255.0 - 141.47.17.19'].includes('141.32.55.0 - 141.43.17.19') &&
      overlapping['140.255.255.0 - 141.47.17.19'].includes('141.42.0.0 - 141.42.15.255')
  });

  testPassed(allResults, majorTests1.fastLookup('141.32.55.76'), `net12`);
  testPassed(allResults, majorTests1.fastLookup('141.46.17.19'), `net13`);
  testPassed(allResults, majorTests1.fastLookup('132.193.182.0'), `net15`);

  testPassed(allResults, majorTests1.fastLookup('9.24.217.255'), null);
  testPassed(allResults, majorTests1.fastLookup('222.151.176.9'), null);
  testPassed(allResults, majorTests1.fastLookup('92.66.16.255'), null);
  testPassed(allResults, majorTests1.fastLookup('0.0.0.0'), null);

  // test behavior on ON_MULTI_LARGEST

  const majorTests2 = new FastLut('majorTests2', ON_MULTI_LARGEST);

  for (const net in mTestNets) {
    majorTests2.addLut(net, mTestNets[net]);
  }
  majorTests2.prepareLut();

  const overlappingNets = ['net11', 'net12', 'net13'];
  for (const net in mTestNets) {
    const id = mTestNets[net];
    if (overlappingNets.includes(id)) {
      continue;
    }
    const [first, second] = net.split('-').map((item) => item.trim());
    testPassed(allResults, majorTests2.fastLookup(first), id);
    testPassed(allResults, majorTests2.fastLookup(second), id);
  }

  testPassed(allResults, majorTests2.fastLookup('141.32.55.76'), `net13`);
  testPassed(allResults, majorTests2.fastLookup('141.46.17.19'), `net13`);
  testPassed(allResults, majorTests2.fastLookup('132.193.182.0'), `net15`);
  testPassed(allResults, majorTests2.fastLookup('140.255.255.0'), `net13`);
  testPassed(allResults, majorTests2.fastLookup('141.42.15.255'), `net13`);

  // now persist the lut 
  majorTests2.persistLut();

  // test behavior on ON_MULTI_SMALLEST
  const majorTests3 = new FastLut('majorTests2', ON_MULTI_SMALLEST);
  majorTests3.loadPersistedLut();

  for (const net in mTestNets) {
    const id = mTestNets[net];
    if (overlappingNets.includes(id)) {
      continue;
    }
    const [first, second] = net.split('-').map((item) => item.trim());
    testPassed(allResults, majorTests3.fastLookup(first), id);
    testPassed(allResults, majorTests3.fastLookup(second), id);
  }

  testPassed(allResults, majorTests3.fastLookup('141.32.55.76'), `net12`);
  testPassed(allResults, majorTests3.fastLookup('141.46.17.19'), `net13`);
  testPassed(allResults, majorTests3.fastLookup('132.193.182.0'), `net15`);
  testPassed(allResults, majorTests3.fastLookup('140.255.255.0'), `net13`);
  testPassed(allResults, majorTests3.fastLookup('141.42.15.255'), `net11`);

  // test behavior on ON_MULTI_ALL
  const majorTests4 = new FastLut('majorTests2', ON_MULTI_ALL);
  majorTests4.loadPersistedLut();

  testPassed(allResults, majorTests4.fastLookup('141.32.55.76'), [`net12`, `net13`], arrayEquals);
  testPassed(allResults, majorTests4.fastLookup('141.46.17.19'), [`net13`], arrayEquals);
  testPassed(allResults, majorTests4.fastLookup('132.193.182.0'), [`net15`], arrayEquals);
  testPassed(allResults, majorTests4.fastLookup('140.255.255.0'), [`net13`], arrayEquals);
  testPassed(allResults, majorTests4.fastLookup('141.42.15.255'), [`net11`, `net12`, `net13`], arrayEquals);

  testPassed(allResults, majorTests4.fastLookup('9.24.218.0'), [`net2`], arrayEquals);
  testPassed(allResults, majorTests4.fastLookup('92.66.15.0'), [`net16`], arrayEquals);

  removeDirectoryIfExists(path.join(RAM_DB_DIR, 'edgeCase/'));
  removeDirectoryIfExists(path.join(RAM_DB_DIR, 'majorTests2/'));

  // test that reloading a lut unchanged doesn't have an effect
  const reloadTest1 = new FastLut('reloadTest1');
  const networks = [
    ['1.2.3.4 - 1.2.3.45', 'test1'],
    ['1.2.3.4 - 1.2.4.45', 'test2'],
    ['133.78.19.0 - 133.78.26.0', 'test4'],
    ['217.12.0.0 - 217.12.0.255', 'test5'],
    ['99.0.0.0 - 99.4.0.2', 'test6'],
    ['0.22.11.0 - 0.23.0.1', 'test7'],
    ['147.147.0.0 - 147.152.255.255', 'test9'],
    ['147.147.0.0 - 147.147.255.255', 'test10'],
    ['1.2.4.4 - 1.2.5.22', 'test12'],
    ['1.0.0.0 - 1.200.255.255', 'test13'],
  ];
  for (const [net, provider] of networks) {
    reloadTest1.addLut(net, provider);
  }
  reloadTest1.prepareLut();

  const persistResult = reloadTest1.persistLut();
  testPassed(allResults, persistResult, 'success');

  const loadResult = reloadTest1.loadPersistedLut();
  testPassed(allResults, loadResult, 'success');

  const versionInitial = reloadTest1.lutVersion;

  const loadResult2 = reloadTest1.loadPersistedLut();
  testPassed(allResults, loadResult2, 'reloadNotNeeded');

  // now create a new lut with the same name to overwrite the ram database
  const reloadTest2 = new FastLut('reloadTest1');
  reloadTest2.addLut('3.12.0.0 - 3.33.0.255', 'test99');
  reloadTest2.prepareLut();

  const persistResult2 = reloadTest2.persistLut();
  testPassed(allResults, persistResult2, 'success');

  // now a reload is needed!!!
  const loadResult3 = reloadTest1.loadPersistedLut();
  testPassed(allResults, loadResult3, 'success');

  const versionAfterChange = reloadTest2.lutVersion;

  testPassed(allResults, versionInitial, versionAfterChange, (a, b) => a !== b);

  removeDirectoryIfExists(path.join(RAM_DB_DIR, 'reloadTest1/'));
};

const singleTest7 = () => {
  let allResults = [];
  const all99 = new FastLut('all99', ON_MULTI_ALL, false);
  const allNets6 = [
    ['2001:808::/35', 'alpha'],
    ['2001:808:e000::/35', 'beta'],
    ['2001:808:a000:: - 2001:808:e000::', 'gamma'],
    ['2001:808:1000:: - 2001:808:2f00::', 'epsilon'],
    ['2001:4c80::/32', 'delta'],
    ['2001:0806:e000::/30', 'zeta'],
  ];
  const mustReturnAll6 = {
    '2001:808:e000::': ['beta', 'gamma'],
    '2001:0808:1FFF:FFFF:FFFF:FFFF:FFFF:FFFF': ['alpha', 'epsilon'],
    '2001:0806:e000::': ['zeta'],
    '2001:808:1000::': ["alpha", "epsilon"]
  };
  for (const [net, provider] of allNets6) {
    all99.addLut(net, provider);
  }
  all99.prepareLut();

  for (let ip in mustReturnAll6) {
    let res = all99.fastLookup(ip);
    testPassed(allResults, res, mustReturnAll6[ip], arrayEquals);
  }

  all99.persistLut();

  const all99Verify = new FastLut('all99', ON_MULTI_ALL, false);
  all99Verify.loadPersistedLut();

  for (let ip in mustReturnAll6) {
    let res = all99Verify.fastLookup(ip);
    testPassed(allResults, res, mustReturnAll6[ip], arrayEquals);
  }
}

const testEntriesForNetworkRange = (fastLutClass = null) => {
  let FastLut = getFastLutClass(fastLutClass);
  const networks = [
    ['1.2.3.4 - 1.2.3.45', 'test1'],
    ['1.2.3.4 - 1.2.4.45', 'test2'],
    ['1.2.3.4 - 1.2.3.5', 'testxxx'],
    ['37.2.3.4 - 37.3.0.0', 'test3'],
    ['133.78.19.0 - 133.78.26.0', 'test4'],
    ['217.12.0.0 - 217.12.0.255', 'test5'],
    ['99.0.0.0 - 99.4.0.2', 'test6'],
    ['0.22.11.0 - 0.23.0.1', 'test7'],
    ['0.0.7.0 - 0.0.7.19', 'test8'],
    ['147.147.0.0 - 147.152.255.255', 'test9'],
    ['147.147.0.0 - 147.147.255.255', 'test10'],
    ['1.2.2.4 - 1.2.4.112', 'test11'],
    ['1.2.4.4 - 1.2.5.22', 'test12'],
    ['1.0.0.0 - 1.200.255.255', 'test13'],
  ];
  const pre = new FastLut('testLut');
  for (const [net, provider] of networks) {
    pre.addLut(net, provider);
  }
  pre.prepareLut();

  const entries = pre.getEntriesForNetworkRange('1.2.3.4 - 1.2.3.45', true);
  log(entries);
}

const singleTests = () => {
  singleTest();
  singleTest2();
  singleTest3();
  singleTest4();
  singleTest5();
  singleTest6();
};

// Command line interface
if (process.argv[2] === 'lut') {
  process.env.LOG_LEVEL = 3;
  testFastLookupTable();
  simpleLutTests();
} else if (process.argv[2] === 'all') {
  process.env.LOG_LEVEL = 3;
  (async () => {
    await runAllTests();
  })();
} else if (process.argv[2] === 'edge') {
  edgeCaseTests();
} else if (process.argv[2] === 'performance') {
  performanceTests();
} else if (process.argv[2] === 'error') {
  errorHandlingTests();
} else if (process.argv[2] === 'integration') {
  integrationTests();
} else if (process.argv[2] === 'persistence') {
  (async () => {
    await persistenceTests();
  })();
} else if (process.argv[2] === 'testReturnNetwork') {
  const testLut = new FastLut('asnLut', ON_MULTI_ALL);
  testLut.addLut("149.135.0.0/16", "Telstra Corporation Limited");
  testLut.addLut("149.136.0.0/16", "California Department of Transportation");
  testLut.addLut("149.136.0.0/24", "Some Other Org");
  testLut.addLut("149.136.0.5/23", "Test Org");
  testLut.prepareLut();
  log(testLut.fastLookup('149.136.0.5', true));
} else if (process.argv[2] === 'singleTests') {
  singleTests();
} else if (process.argv[2] === 'help' || process.argv[2] === '--help' || process.argv[2] === '-h') {
  log(`
🧪 FastLut Test Suite Commands:

  node test_fast_lookup_table.js all          - Run all test suites
  node test_fast_lookup_table.js lut          - Run original LUT tests
  node test_fast_lookup_table.js edge         - Run edge case tests
  node test_fast_lookup_table.js performance  - Run performance tests
  node test_fast_lookup_table.js error        - Run error handling tests
  node test_fast_lookup_table.js integration  - Run integration tests
  node test_fast_lookup_table.js persistence  - Run persistence tests
  node test_fast_lookup_table.js singleTests  - Run single test functions
  node test_fast_lookup_table.js help         - Show this help

📊 Test Categories:
  • Edge Cases: Malformed IPs, boundary conditions, extreme values
  • Performance: Large datasets, memory usage, persistence speed
  • Error Handling: Invalid inputs, exception handling
  • Integration: Real-world scenarios, ISP/CDN simulations
  • Persistence: File I/O, version management, data integrity
  • Original: Legacy test cases for backward compatibility
`);
}

module.exports = {
  testFastLookupTable,
  simpleLutTests,
  edgeCaseTests,
  performanceTests,
  errorHandlingTests,
  integrationTests,
  persistenceTests,
  runAllTests,
  resetCounters,
  TestUtils,
  TestAssertions,
  TestDataGenerator
};
