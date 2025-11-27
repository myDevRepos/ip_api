const https = require('https');

class DuneClient {
  constructor(api, DUNE_API_KEY, push_after = 10000) {
    this.api = api;
    this.DUNE_API_KEY = DUNE_API_KEY;
    this.push_after = push_after;
    this.counter = {
      hits: 0,
      data: {},
    };
  }

  send(data) {
    const options = {
      hostname: 'dune.incolumitas.com',
      port: 443,
      path: '/update?key=' + this.DUNE_API_KEY,
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': data.length,
      },
    };

    const req = https.request(options, (res) => {
      res.on('data', (response) => {
        if (response != 'ok') {
          process.stdout.write(response)
        }
      });
    });

    req.on('error', (error) => {
      console.error(error);
    })

    req.write(data);
    req.end();
  }

  incr(ip) {
    if (!ip || ip === '127.0.0.1' || ip === '0.0.0.0') {
      return;
    }

    this.counter.hits++;

    if (this.counter.data[ip] !== undefined) {
      this.counter.data[ip]++;
    } else {
      this.counter.data[ip] = 1;
    }

    if (this.counter.hits > this.push_after) {
      const data = JSON.stringify({
        api: this.api,
        hits: this.counter.hits,
        data: this.counter.data,
      });

      this.counter = {
        hits: 0,
        data: {},
      };

      if (this.DUNE_API_KEY) {
        this.send(data);
      }
    }
  }
}

exports.DuneClient = DuneClient;