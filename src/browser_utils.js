const startBrowser = async () => {
  const puppeteer = require('puppeteer-core');
  const launchOptions = {
    headless: 'new',
    defaultViewport: null,
    args: ['--start-maximized', '--ignore-certificate-errors', '--window-size=1920,1080'],
    ignoreDefaultArgs: ['--enable-automation'],
    executablePath: '/Applications/Google\ Chrome.app/Contents/MacOS/Google\ Chrome'
  };
  const browser = await puppeteer.launch(launchOptions);
  const page = await browser.newPage();
  return [browser, page];
};

const closeBrowser = async (page, browser) => {
  if (page) {
    console.log('Closing page');
    await page.close();
  }
  if (browser) {
    console.log('Closing browser');
    await browser.close();
  }
};

exports.closeBrowser = closeBrowser;
exports.startBrowser = startBrowser;