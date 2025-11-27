const axios = require('axios');

const ip = '23.236.48.55';
const apiKey = 'a742ef2e3ca82f9d';
const url = `https://api.ipapi.is?q=${ip}&key=${apiKey}`;

(async () => {
  for (let i = 0; i < 150; i++) {
    let resp = await axios.get(url);
    console.log(resp.data.ip, resp.status);
  }
})();