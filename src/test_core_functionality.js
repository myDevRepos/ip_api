const { testParseWhoisRecord } = require('whois_parse');
const { testFastLookupTable, simpleLutTests } = require('./test_fast_lookup_table');

const testCoreFunctionality = () => {
  let testResults = {};

  testResults.testParseWhoisRecord = testParseWhoisRecord(false);
  testResults.simpleLutTests = simpleLutTests(null, false);
  testResults.testFastLookupTable = testFastLookupTable(null, false);

  const hasFailingTests = Object.values(testResults).some((testResult) => !testResult);
  const passedTests = Object.values(testResults).filter(result => result).length;
  const totalTests = Object.keys(testResults).length;

  console.log(`Test Results: ${passedTests}/${totalTests} passed`);
  if (hasFailingTests) {
    console.log('Failed tests:', Object.entries(testResults).filter(([name, result]) => !result).map(([name]) => name));
  }

  return !hasFailingTests;
};

if (process.argv[2] === 'testCoreFunctionality') {
  testCoreFunctionality();
}

exports.testCoreFunctionality = testCoreFunctionality;
