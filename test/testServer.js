const https = require('https');

const apiRequest = (ip, apiKey = 'edff309097c99c2e') => new Promise((resolve, reject) => {
  const url = `https://api.ipapi.is/?q=${ip}${apiKey ? `&key=${apiKey}` : ''}`;

  https.get(url, (res) => {
    let data = '';
    res.on('data', chunk => data += chunk);
    res.on('end', () => {
      try {
        resolve(JSON.parse(data));
      } catch (err) {
        reject(new Error('Error parsing JSON: ' + err.message));
      }
    });
  }).on('error', err => reject(new Error('Error: ' + err.message)));
});

const getRandomIPv4 = () => {
  return Array.from({ length: 4 }, () => Math.floor(Math.random() * 256)).join('.');
};

const fireRequests = async (numRequests) => {
  const promises = [];
  const elapsedTimes = [];

  for (let i = 0; i < numRequests; i++) {
    const randomIP = getRandomIPv4();
    promises.push(
      apiRequest(randomIP)
        .then(response => {
          console.log(response);
          if (response.elapsed_ms !== undefined) {
            elapsedTimes.push(response.elapsed_ms);
          }
        })
        .catch(console.error)
    );
  }

  await Promise.all(promises);

  if (elapsedTimes.length > 0) {
    const totalElapsed = elapsedTimes.reduce((acc, curr) => acc + curr, 0);
    const averageElapsed = totalElapsed / elapsedTimes.length;
    const meanElapsed = elapsedTimes.sort((a, b) => a - b)[Math.floor(elapsedTimes.length / 2)];
    console.log(`Average elapsed_ms: ${averageElapsed}`);
    console.log(`Mean elapsed_ms: ${meanElapsed}`);
  } else {
    console.log('No elapsed_ms data available.');
  }
};

fireRequests(1000);