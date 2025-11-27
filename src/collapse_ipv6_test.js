const { collapseIPv6Number } = require('ip-num');
const { log } = require('./utils');

const inputs = [
  {
    input: '2001:550:0:1000:0:0:9a1a:2187',
    expected: '2001:550:0:1000::9a1a:2187'
  },
  {
    input: '2001:4457:0:371a:0:0:0:0',
    expected: '2001:4457:0:371a::'
  },
  {
    input: '2001:550:0:1000:0:0:9a18:3c58',
    expected: '2001:550:0:1000::9a18:3c58'
  },
];

for (const input of inputs) {
  const collapsed = collapseIPv6Number(input.input);
  const failed = collapsed !== input.expected;
  if (failed) {
    log(`[FAILED] Collapsed: ${collapsed} != Expected: ${input.expected}`);
  } else {
    log(`[PASSED] Collapsed: ${collapsed} == Expected: ${input.expected}`);
  }
}