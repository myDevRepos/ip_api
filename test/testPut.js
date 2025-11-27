const axios = require('axios');

(async () => {
  // use invalid API method
  let invalid = await axios.put(`http://localhost:3899/`);
  if (invalid.status === 200 && invalid.data.error === 'Invalid request method') {
    console.log(invalid.data)
    console.log(`[Invalid Input] test passed`)
  } else {
    console.log(`[Invalid Input] test failed`)
  }
})();