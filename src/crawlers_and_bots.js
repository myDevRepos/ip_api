const { FastLut, ON_MULTI_SMALLEST } = require('./fast_lut');

class CrawlerAndBots {
  constructor() {
    this.crawlerAndBotsLut = new FastLut('CrawlerAndBotsLut', ON_MULTI_SMALLEST);
  }

  lookup(ip) {
    const isCrawler = this.crawlerAndBotsLut.fastLookup(ip);
    if (typeof isCrawler === 'string') {
      return isCrawler;
    } else {
      return false;
    }
  }

  async loadLookupTable() {
    this.crawlerAndBotsLut.loadPersistedLut();
    return Promise.resolve();
  }
}

module.exports = {
  CrawlerAndBots,
};
