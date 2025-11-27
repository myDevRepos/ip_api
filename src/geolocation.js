const fs = require('fs');
const { FastLut, ON_MULTI_ALL } = require('./fast_lut');
const { log } = require('./utils');
const { GEONAME_ID_LUT_FILE } = require('./constants');
const { getTimeFromLocation } = require('./geolocation_tools');
const { readCountryInfo } = require('./geolocation_tools');

class IPtoLocation {
  constructor() {
    this.finalLut = new FastLut('FinalLut', ON_MULTI_ALL, true);
    this.geonameLut = JSON.parse(fs.readFileSync(GEONAME_ID_LUT_FILE, 'utf-8'));
  }

  async loadGeolocation() {
    this.countryData = await readCountryInfo();
    this.finalLut.loadPersistedLut();
    return Promise.resolve();
  }

  getLocationFromFinal(ip, markSource = false, returnNetwork = false) {
    let res = null;
    let retVal = this.finalLut.fastLookup(ip, returnNetwork);
    let network = null;

    if (retVal && returnNetwork && 'obj' in retVal) {
      network = retVal.network;
      retVal = retVal.obj;
    }

    if (retVal) {
      const geodata = this.geonameLut[retVal];
      if (!geodata) {
        return null;
      }
      let [country_code, state, city, zip, latitude, longitude] = geodata.split('_');
      country_code = country_code.toUpperCase().trim();
      const lat = parseFloat(latitude);
      const lon = parseFloat(longitude);
      let { timezone, local_time, local_time_unix, is_dst } = getTimeFromLocation(lat, lon);
      const countryDetails = this.countryData[country_code];
      res = {
        is_eu_member: countryDetails?.is_eu_member,
        calling_code: countryDetails?.calling_code,
        currency_code: countryDetails?.currency_code,
        continent: countryDetails?.continent,
        country: countryDetails?.country,
        country_code: country_code,
        state: state,
        city: city,
        latitude: lat,
        longitude: lon,
        zip: zip,
        timezone: timezone,
        local_time: local_time,
        local_time_unix: local_time_unix,
        is_dst: is_dst,
      };
      if (markSource) {
        res.source = 'final';
      }
      if (network) {
        res.network = network;
      }
    }

    return res;
  }

  lookup(ip, markSource = false) {
    return this.getLocationFromFinal(ip, markSource);
  }
}

module.exports = {
  IPtoLocation,
};
