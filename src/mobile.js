const { FastLut, ON_MULTI_SMALLEST } = require('./fast_lut');
const { POS_VAL } = require('./constants');

class IPtoMobile {
  constructor() {
    this.mobileLut = new FastLut('MobileLut', ON_MULTI_SMALLEST);
    this.mobileLutLoaded = false;
  }

  async loadLookupTable() {
    this.mobileLut.loadPersistedLut();
    this.mobileLutLoaded = true;
    return Promise.resolve();
  }

  lookup(ip) {
    // lookup to which organization the IP address belongs
    if (this.mobileLut && this.mobileLutLoaded) {
      return this.mobileLut.fastLookup(ip) === POS_VAL;
    }
    return false;
  }
}

module.exports = {
  IPtoMobile,
};
