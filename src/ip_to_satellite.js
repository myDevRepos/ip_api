const { FastLut } = require('./fast_lut');

class IPtoSatellite {
  constructor() {
    this.satelliteLut = new FastLut('SatelliteLut');
  }

  loadLookupTable() {
    this.satelliteLut.loadPersistedLut();
  }

  lookup(ip) {
    return !!this.satelliteLut.fastLookup(ip);
  }

}

module.exports = {
  IPtoSatellite,
};
