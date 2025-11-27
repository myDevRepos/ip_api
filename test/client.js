const fetch = (...args) => import('node-fetch').then(({ default: fetch }) => fetch(...args));

function makeRequest(ip) {
  fetch('https://ipapi.is/json/?q=' + ip)
    .then(response => response.json())
    .then(data => {
      console.log(data)
    })
    .catch(err => console.error(err))
}

makeRequest('35.151.13.127')
makeRequest('71.48.36.187')

// 35.151.13.127 - - [14/Nov/2022:16:33:16 +0000] "GET / HTTP/1.1" 200 1005 "-" "node-fetch/1.0 (+https://github.com/bitinn/node-fetch)"
// 71.48.36.187 - - [14/Nov/2022:16:33:17 +0000] "GET / HTTP/1.1" 200 1034 "-" "node-fetch/1.0 (+https://github.com/bitinn/node-fetch)"

// 37.120.17.217 - -[14 / Nov / 2022: 16: 33: 51 + 0000] "GET /json/?q=35.151.13.127 HTTP/1.1" 200 993 "-" "node-fetch"
// 37.120.17.217 - -[14 / Nov / 2022: 16: 33: 51 + 0000] "GET /json/?q=71.48.36.187 HTTP/1.1" 200 1022 "-" "node-fetch"