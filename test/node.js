// npm i axios
const axios = require('axios');

(async () => {
  const ip = '23.236.48.55';
  const apiKey = '59d338069b038b73';
  const url = `https://api.ipapi.is?q=${ip}&key=${apiKey}`;

  const response = await axios.get(url);
  console.log(response.data);
})();