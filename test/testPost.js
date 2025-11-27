const { getRandomIPs, round, log } = require('./../src/utils');
const axios = require('axios');

(async () => {
  // invalid inputs to post endpoint
  const invalidPostInputs = [
    // '32.34.3.2211.34.3.22',
    // '555.32.33.2',
    // [],
    // ['1,3,4', '1.3332.3.4'],
    // undefined,
    // null,
    // getRandomIPs(101),
    // getRandomIPs(1000),
    ["1.2.3.4", null],
    ["1.2.3.4", "::gggg"],
  ];
  for (let input of invalidPostInputs) {
    const postData = JSON.stringify({ ips: input });
    let postResponse = await axios.post(`https://api.ipapi.is/`, postData, {
      headers: {
        'Content-Type': 'application/json'
      }
    });
    log(input, postResponse.data)
  }
})();