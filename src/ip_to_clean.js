const { FastLut } = require('./fast_lut');

class IPtoClean {
  constructor() {
    this.cleanLut = new FastLut('CleanLut');
  }

  loadLookupTable() {
    this.cleanLut.loadPersistedLut();
  }

  lookup(ip) {
    return this.cleanLut.fastLookup(ip);
  }
}

module.exports = {
  IPtoClean,
};
