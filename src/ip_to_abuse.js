const { FastLut, ON_MULTI_ALL } = require('./fast_lut');
const { isSameArrNet, numHostsInNet } = require('ip_address_tools');

class IPtoAbuse {
  constructor() {
    this.abuseLut = new FastLut('AbuseLut', ON_MULTI_ALL);
  }

  loadLookupTable() {
    this.abuseLut.loadPersistedLut();
  }

  lookup(ip, matchNetwork = null) {
    let response = {};
    const res = this.abuseLut.fastLookup(ip, true);

    if (res) {
      let cand = null;

      if (Array.isArray(res)) {
        if (matchNetwork) {
          const filtered = res.filter((el) => isSameArrNet(el.network, matchNetwork));
          if (filtered.length > 0) {
            cand = filtered[0].obj;
          }
        }

        if (!cand) {
          // sort so that smallest net comes first
          res.sort((a, b) => {
            return numHostsInNet(a.network) - numHostsInNet(b.network);
          });
          if (res.length > 0) {
            cand = res[0].obj;
          }
        }
      }

      if (cand) {
        response.name = cand[0] || '';
        response.address = cand[1] || '';
        response.country = cand[2] || '';
        response.email = cand[3] || '';
        response.phone = cand[4] || '';
      }
    }

    return response;
  }
}

exports.IPtoAbuse = IPtoAbuse;