const puppeteer = require('puppeteer');
const util = require('util');
const exec = util.promisify(require('child_process').exec);
const { hostIsGood, isBadCrawl } = require('./crawl_utils');

function curlHead(url) {
  return new Promise((resolve, reject) => {
    let command = `curl -s --max-time 10 --head ${url}`;
    exec(command, (error, stdout, stderr) => {
      if (error) {
        console.log(`error: ${error.message}`);
      }
      if (stderr) {
        return resolve(stderr.trim());
      }
      return resolve(stdout.trim());
    });
  });
}

async function getPage(disableMediaRequests = false, headless = true) {
  let browser = null;
  let launchOptions = {
    headless: headless,
    defaultViewport: null,
    args: ['--start-maximized', '--ignore-certificate-errors', '--window-size=1920,1080'],
    ignoreDefaultArgs: ['--enable-automation'],
    executablePath: '/Applications/Google\ Chrome.app/Contents/MacOS/Google\ Chrome'
  };

  if (!browser) {
    console.log('starting browser...');
    browser = await puppeteer.launch(launchOptions);
  }
  const page = await browser.newPage();

  // dont load static files
  // https://github.com/puppeteer/puppeteer/issues/1913
  if (disableMediaRequests) {
    await page.setRequestInterception(true);
    page.on('request', (request) => {
      if (['image', 'stylesheet', 'font'].indexOf(request.resourceType()) !== -1) {
        request.abort();
      } else {
        request.continue();
      }
    });
  }

  return [browser, page];
}

function getHtml(page, url, maxTimeout = 30000) {
  return new Promise((resolve) => {
    setTimeout(function () {
      return resolve(false);
    }, maxTimeout + 5000);

    page.goto(url, { waitUntil: 'networkidle2', timeout: maxTimeout }).then(async (response) => {
      try {
        // allow google to translate
        await page.waitForTimeout(1500);
        // get text
        let text = await page.evaluate(() => {
          return document.body.innerText;
        });
        let html = await page.content();
        let title = await page.title();
        let pageUrl = await page.url();
        console.error(`[ok] success visiting ${url} with browser`);
        return resolve({
          response: response.headers(),
          status: response.status(),
          text: text,
          html: html,
          url: pageUrl,
          title: title
        });
      } catch (err) {
        console.error(`[-] failed to visit ${url} with browser: ${err.toString()}`);
        return resolve(false);
      }
    }).catch((err) => {
      console.error(`[-] failed to visit ${url} with browser: ${err.toString()}`);
      return resolve(false);
    });
  })
}

async function googleSearch(query, page) {
  let response = await page.goto(`https://www.google.com/search?q=${query}`, { waitUntil: 'networkidle2', timeout: 50000 })

  try {
    await page.click("#L2AGLb > div", { timeout: 5000 })
  } catch (err) { }

  // When google stops our crawling, it displays: 
  // "Our systems have detected unusual traffic from your computer network. This page checks to see if it's really you sending the requests, and not a robot. Why did this happen?"
  const detectNeedle = 'unusual traffic from your computer network';
  let contents = await page.content();
  if (contents.includes(detectNeedle)) {
    console.log('Got detected by Google.');
    return false;
  }
  try {
    await page.waitForSelector('.g', { timeout: 45000 });
    await page.waitForTimeout(800)
  } catch (err) {
    return false;
  }

  let serpData = await page.evaluate(() => {
    let res = document.querySelectorAll('.g');
    let serpData = [];
    for (let el of res) {
      let serp = {};
      try {
        serp.visibleUrl = el.querySelector('link').getAttribute('href');
      } catch (err) {
        try {
          serp.visibleUrl = el.querySelector('cite').innerText;
        } catch (err) { }
      }
      try {
        serp.title = el.querySelector('h3').innerText;
      } catch (err) { }
      try {
        serp.href = el.querySelector('a').getAttribute('href');
      } catch (err) { }
      try {
        serp.descr = el.querySelector('div > div:nth-child(2) > div:nth-child(2) > div').innerText;
      } catch (err) {
        try {
          serp.descr = el.innerText;
        } catch (err) { }
      }
      if (serp.title && serp.href) {
        serpData.push(serp);
      }
    }
    return serpData;
  });

  return {
    response: response.headers(),
    status: response.status(),
    serpData: serpData,
    html: await page.content(),
  };
}

function getUrlFromGoogleSerp(serpData, domain = null, domainLookupFailed = null) {
  // first try to get this URL which we have already as domain
  if (domain && domainLookupFailed === false) {
    for (let serp of serpData) {
      if (serp.href) {
        let urlParsed = null;
        try {
          urlParsed = new URL(serp.href);
        } catch (err) { urlParsed = null; }
        if (urlParsed && (urlParsed.host.includes(domain) || urlParsed.host === domain || serp.href.includes(domain))) {
          console.log(`[+++] Found url by whois domain: ${serp.href}`);
          return serp.href;
        }
      }
    }
  }

  let goodUrls = [];
  let badUrls = [];
  let nonUrls = [];
  for (let serp of serpData) {
    if (serp.href) {
      let urlParsed = null;
      try {
        urlParsed = new URL(serp.href);
      } catch (err) { urlParsed = null; }
      if (urlParsed) {
        if (hostIsGood(urlParsed.host)) {
          goodUrls.push(serp.href);
          continue;
        } else {
          badUrls.push(serp.href);
          continue;
        }
      }
    }
    nonUrls.push(serp);
  }

  console.log(`[i] Good Urls: ${goodUrls.length}, Bad Urls: ${badUrls.length}, Non Urls: ${nonUrls.length}`);

  // just return the first url that is good
  for (let serp of serpData) {
    if (serp.href) {
      let urlParsed = null;
      try {
        urlParsed = new URL(serp.href);
      } catch (err) { urlParsed = null; }
      if (urlParsed) {
        if (hostIsGood(urlParsed.host)) {
          console.log(`[+] Found url from Google Serp ${serp.href}`);
          return serp.href;
        } else {
          console.log(`[+] Bad url: ${urlParsed.host}`);
        }
      }
    }
  }
}

exports.curlHead = curlHead;
exports.getPage = getPage;
exports.getHtml = getHtml;
exports.googleSearch = googleSearch;
exports.getUrlFromGoogleSerp = getUrlFromGoogleSerp;
exports.hostIsGood = hostIsGood;
exports.isBadCrawl = isBadCrawl;