const fs = require('fs');
const path = require('path');
const {
  isIPv4Cidr, isIPv4Inetnum, parseIPv4Inetnum, parseIPv4Cidr, IPv4ToInt, IntToIPv4,
  isIPv6Cidr, isIPv6Inetnum, parseIPv6Cidr, parseIPv6Inetnum, IntToIPv6, networkToStr,
  isIP, numHostsInNet, isIPv6Strict, abbreviateIPv6, getFirstAndLastIpOfNetwork
} = require('ip_address_tools');
const { IPv6 } = require('ip-num');
const { log, getRandomInt, createDirectoryIfNotExists, isInteger } = require('./utils');
const { RAM_DB_DIR } = require('./constants');

const ON_MULTI_FIRST = 'first';
const ON_MULTI_SMALLEST = 'smallest';
const ON_MULTI_LARGEST = 'largest';
const ON_MULTI_ALL = 'all';
const allowedOnMultiMatch = [ON_MULTI_FIRST, ON_MULTI_SMALLEST, ON_MULTI_LARGEST, ON_MULTI_ALL];

const START_RANGE = 0; // former: 's'
const END_RANGE = 1; // former: 'e'

/* -------------------------------------------------------------------------
 * Helper – binary format for the "overlapping" adjacency lists
 * ---------------------------------------------------------------------- *
 *  uint32   key
 *  uint32   count              (# of neighbours)
 *  count x  uint32 neighbourId
 *  … repeats …
 *  (Little-endian throughout)
 *  This keeps files tiny, is append-friendly, and trivial to parse.
 * ---------------------------------------------------------------------- */
function overlappingToBinary(obj) {
  // obj: { "12":[13,14], … }
  const keys = Object.keys(obj);
  let bytes = 0;
  for (const k of keys) bytes += 8 + obj[k].length * 4;

  const buf = Buffer.allocUnsafe(bytes);
  let offset = 0;

  for (const k of keys) {
    const list = obj[k];
    buf.writeUInt32LE(+k, offset); offset += 4;
    buf.writeUInt32LE(list.length, offset); offset += 4;
    for (const n of list) {
      buf.writeUInt32LE(n, offset);
      offset += 4;
    }
  }
  return buf;
}

function binaryToOverlapping(buf) {
  const map = {};
  let offset = 0;
  while (offset < buf.length) {
    const key = buf.readUInt32LE(offset); offset += 4;
    const len = buf.readUInt32LE(offset); offset += 4;
    const arr = new Array(len);
    for (let i = 0; i < len; i++) {
      arr[i] = buf.readUInt32LE(offset);
      offset += 4;
    }
    map[key] = arr;
  }
  return map;
}

class FastLut {
  constructor(name, onMultiMatch = ON_MULTI_FIRST, verbose = false) {
    this.name = name;
    if (typeof name !== 'string') {
      throw Error(`FastLut requires a name, but received: ${name}`);
    }
    this.ramDbStoreDir = path.join(RAM_DB_DIR, `${this.name}/`);
    // stored on disk
    this.lutVersion = null;
    this.verbose = verbose;
    this.onMultiMatch = onMultiMatch;
    if (!allowedOnMultiMatch.includes(this.onMultiMatch)) {
      throw Error(`Invalid onMultiMatch policy: ${this.onMultiMatch}, allowed = ${JSON.stringify(allowedOnMultiMatch)}`);
    }

    // When persisting the LUT, we collapse the IPv6 networks into a memory efficient format
    // For example "2001:0db8:ffff:ffff:ffff:ffff:ffff:ffff" ==> "2001:0db8-6"
    // this saves a lot of storage space, but we need to uncollapse them looking up IPv6 addresses
    // also line is binary when loaded from disk
    this.loadedFromPersisted = false;

    // Some lookup tables don't need to keep track of overlapping networks, since there are none 
    // In geolocation databases for example, it does not make sense to have an IP address with two different locations
    this.ignoreOverlapping = false;

    this.maxAllowedIPv4 = (2 ** 29) - 1;
    this.maxAllowedIPv6 = (2 ** 114) - 1;

    // Keep track of whether Lookup Table is locked
    this.lutLocked = false;
    this.lutLocked6 = false;

    // How many nets were not added
    this.notAdded = {
      invalidNet: 0,
      net4TooLarge: 0,
      net6TooLarge: 0,
      net4Duplicate: 0,
      net6Duplicate: 0,
    };

    // How many nets were added
    this.netsAdded = {
      directLut: 0,
      inet4num: 0,
      inet6num: 0,
      cidr4: 0,
      cidr6: 0,
    };

    // IPv4 Lookup Table
    this.ranges = [];
    this.duplicateCheck = {};
    this.line = [];
    this.objects = [];
    this.where = {};

    // IPv6 Lookup Table
    this.ranges6 = [];
    this.duplicateCheck6 = {};
    this.line6 = [];
    this.objects6 = [];
    this.where6 = {};

    // Direct Lookup Table for Single IP Addresses (Both IPv4 and IPv6)
    this.directLut = {};

    // when to stop searching
    this.overlappingCutoff = 200;
  }

  lutInfo() {
    return {
      name: this.name,
      ignoreOverlapping: this.ignoreOverlapping,
      maxAllowedIPv4: this.maxAllowedIPv4,
      maxAllowedIPv6: this.maxAllowedIPv6,
      lutLocked: this.lutLocked,
      lutLocked6: this.lutLocked6,
      notAdded: this.notAdded,
      netsAdded: this.netsAdded,
    };
  }

  /**
   * Convert the IP into its int version if it is IPv4. Don't do it for IPv6, since the collapsed form 
   * is actually less RAM intensive.
   * 
   * @param {number} ipVersion - The IP version (4 or 6)
   * @param {string} ip - The IP address
   * @param {*} obj - The object to associate with the IP
   */
  addDirectLut = (ipVersion, ip, obj) => {
    const addToLut = (key) => {
      if (this.onMultiMatch === ON_MULTI_ALL) {
        if (key in this.directLut) {
          if (Array.isArray(this.directLut[key])) {
            this.directLut[key].push(obj);
          } else {
            this.directLut[key] = [this.directLut[key], obj];
          }
        } else {
          this.directLut[key] = obj;
        }
      } else {
        this.directLut[key] = obj;
      }
      this.netsAdded.directLut++;
    };

    if (ipVersion === 4) {
      addToLut(IPv4ToInt(ip));
    } else if (ipVersion === 6) {
      addToLut(abbreviateIPv6(ip));
    }
  }

  isDuplicate = (net, ipVersion, obj) => {
    const netStr = networkToStr(net, ipVersion);
    if (ipVersion === 4) {
      if (this.duplicateCheck[netStr]) {
        this.notAdded.net4Duplicate++;
        if (this.verbose) {
          log(`Not adding duplicate IPv4 net`, netStr, obj, 'ERROR');
        }
        return true;
      } else {
        this.duplicateCheck[netStr] = obj;
      }
    } else if (ipVersion === 6) {
      if (this.duplicateCheck6[netStr]) {
        this.notAdded.net6Duplicate++;
        if (this.verbose) {
          log(`Not adding duplicate IPv6 net`, netStr, obj, 'ERROR');
        }
        return true;
      } else {
        this.duplicateCheck6[netStr] = obj;
      }
    }
    return false;
  }

  addLut = (network, obj) => {
    try {
      // always convert the network into an array of two numbers
      // regardless of whether the network is a inetnum or CIDR
      let parsedNet = null;
      let parsedNet6 = null;
      let netType = null;

      let ipVersion = isIP(network);
      if (ipVersion) {
        this.addDirectLut(ipVersion, network, obj);
        return;
      }

      if (isIPv4Cidr(network)) {
        parsedNet = parseIPv4Cidr(network);
        this.netsAdded.cidr4++;
        netType = 4;
      } else if (isIPv4Inetnum(network)) {
        parsedNet = parseIPv4Inetnum(network);
        this.netsAdded.inet4num++;
        netType = 4;
      } else if (isIPv6Cidr(network)) {
        parsedNet6 = parseIPv6Cidr(network);
        this.netsAdded.cidr6++;
        netType = 6;
      } else if (isIPv6Inetnum(network)) {
        parsedNet6 = parseIPv6Inetnum(network);
        this.netsAdded.inet6num++;
        netType = 6;
      }

      if (netType == 4 && this.lutLocked) {
        throw new Error(`FastLut ${this.name} is locked for IPv4 networks.`);
      }

      if (netType == 6 && this.lutLocked6) {
        throw new Error(`FastLut ${this.name} is locked for IPv6 networks.`);
      }

      if (parsedNet && parsedNet !== 'invalidInetnum') {
        const netSize = parsedNet[1] - parsedNet[0];
        if (netSize >= this.maxAllowedIPv4) {
          this.notAdded.net4TooLarge++;
          if (this.verbose) {
            log(`Not adding large IPv4 net: ${netSize}`, networkToStr(parsedNet, 4, true), obj, 'ERROR');
          }
          return;
        }
        if (this.isDuplicate(parsedNet, 4, obj)) {
          return;
        }
        this.ranges.push(parsedNet);
        this.objects.push(obj);
      } else if (parsedNet6 && parsedNet6 !== 'invalidInetnum') {
        if (!(isIPv6Strict(parsedNet6[0], true) && isIPv6Strict(parsedNet6[1], true))) {
          log('Not adding non-strict IPv6:', network, parsedNet6, obj);
          return;
        }
        const netSize = parsedNet6[1] - parsedNet6[0];
        if (netSize >= this.maxAllowedIPv6) {
          this.notAdded.net6TooLarge++;
          if (this.verbose) {
            log(`Not adding large IPv6 net: ${netSize}`, networkToStr(parsedNet6, 6, true), obj, 'ERROR');
          }
          return;
        }
        if (this.isDuplicate(parsedNet6, 6, obj)) {
          return;
        }
        this.ranges6.push(parsedNet6.map(num => num.value));
        this.objects6.push(obj);
      } else {
        if (this.verbose) {
          log(`Not adding invalid net: ${network}`, 'ERROR');
        }
        this.notAdded.invalidNet++;
      }
    } catch (err) {
      log(`[${this.name}] Unexpected error adding network "${network}": ${err.toString()}`, 'ERROR');
      // log stack trace
      console.trace();
    }
  }

  /**
   * https://stackoverflow.com/questions/4542892/possible-interview-question-how-to-find-all-overlapping-intervals
   * 
   * @param {*} ranges 
   * @param {*} ipVersion 
   */
  sweepLine = (ranges, ipVersion) => {
    const self = this;
    let line = [];

    for (let k = 0; k < ranges.length; k++) {
      const [start, end] = ranges[k];
      line.push([START_RANGE, start, k]);
      line.push([END_RANGE, end, k]);
    }

    // first sort by start range
    if (ipVersion === 4) {
      line.sort((a, b) => {
        const delta = a[1] - b[1];
        if (delta === 0) {
          // start range is equal
          return a[0] - b[0];
        } else {
          // sort by start range of net
          return delta;
        }
      });
    } else {
      line.sort((a, b) => {
        const delta = a[1] - b[1];
        if (delta === 0n) {
          // start range is equal
          return a[0] - b[0];
        } else {
          // sort by start range of net
          if (delta > 0n) {
            return 1;
          } else {
            return -1;
          }
        }
      });
    }

    let openRanges = {};
    let overlap = {};

    if (!this.ignoreOverlapping) {
      for (const [type, _range, index] of line) {
        // open the range
        if (type === START_RANGE) {
          openRanges[index] = 1;
        }

        // close the range (delete it)
        if (type === END_RANGE) {
          if (openRanges[index] === 1) {
            delete openRanges[index];
          }
        }

        // if more than one range is open, we have an overlap
        if (Object.keys(openRanges).length > 1) {
          // all ranges that are open at this point are overlapping
          if (!overlap[index]) {
            overlap[index] = new Set();
          }
          for (const oIndex in openRanges) {
            if (!overlap[oIndex]) {
              overlap[oIndex] = new Set();
            }
            overlap[oIndex].add(parseInt(oIndex));
            overlap[oIndex].add(parseInt(index));
            overlap[index].add(parseInt(oIndex));
          }
        }
      }

      // a network does not overlap with itself
      for (const index in overlap) {
        overlap[index].delete(parseInt(index));
        overlap[index] = Array.from(overlap[index]);
        if (overlap[index].length <= 0) {
          delete overlap[index];
        }
      }

      for (const index in overlap) {
        if (overlap[index].length > 1) {
          overlap[index].sort((a, b) => {
            const net1 = ipVersion === 4 ? self.ranges[a] : self.ranges6[a];
            const net2 = ipVersion === 4 ? self.ranges[b] : self.ranges6[b];
            const netSize1 = BigInt(net1[1]) - BigInt(net1[0]);
            const netSize2 = BigInt(net2[1]) - BigInt(net2[0]);
            let delta = netSize2 - netSize1;
            if (self.onMultiMatch === ON_MULTI_LARGEST) {
              return delta > 0n ? 1 : delta < 0n ? -1 : 0;
            } else if (self.onMultiMatch === ON_MULTI_SMALLEST) {
              return delta < 0n ? 1 : delta > 0n ? -1 : 0;
            }
            return 0;
          });
        }
      }
    }

    if (ipVersion === 4) {
      this.overlapping = overlap;
    } else if (ipVersion === 6) {
      this.overlapping6 = overlap;
    }

    // RE-INDEX the line
    // modify the line so that we can easily find the full network from each entry
    // replace the index `k` with the relative index to the counterpart.

    let where = {};

    for (let idx = 0; idx < line.length; idx++) {
      const [type, _range, index] = line[idx];
      if (!(index in where)) {
        where[index] = [idx,];
      } else {
        where[index].push(idx);
      }
    }

    let reducedWhere = {};
    for (const index in where) {
      reducedWhere[index] = where[index][0];
    }

    if (ipVersion === 4) {
      this.where = reducedWhere;
    } else if (ipVersion === 6) {
      this.where6 = reducedWhere;
    }

    // now insert the relative indices
    for (let idx = 0; idx < line.length; idx++) {
      const oldIndex = line[idx][2];
      const newIndex = where[oldIndex].pop();
      line[idx].push(newIndex);
    }

    if (ipVersion === 4) {
      this.line = line;
    } else if (ipVersion === 6) {
      this.line6 = line;
    }
  }

  /**
   * returns true if net1 is larger than net2 or equal to it
   * 
   * @param {*} net1 
   * @param {*} net2 
   */
  compareNets = (net1, net2) => {
    const netSize1 = net1[1] - net1[0];
    const netSize2 = net2[1] - net2[0];
    return netSize1 >= netSize2;
  }

  netSize = (net) => {
    return net[1] - net[0];
  }

  isInNet = (ipInt, net) => {
    return net[0] <= ipInt && net[1] >= ipInt;
  }

  getLineEntry = (index, ipVersion) => {
    if (this.loadedFromPersisted) {
      if (ipVersion === 4) {
        return this.getBinaryLineElement(index);
      } else if (ipVersion === 6) {
        const line6Element = this.getBinaryLineElement6(index);
        return line6Element;
      }
    } else {
      if (ipVersion === 4) {
        return this.line[index];
      } else if (ipVersion === 6) {
        return this.line6[index];
      }
    }
  }

  getLineLength = (ipVersion) => {
    if (this.loadedFromPersisted) {
      if (ipVersion === 4) {
        if (this.line.length % 11 !== 0) {
          throw new Error('Line length is not a multiple of 11');
        }
        return this.line.length / 11;
      } else if (ipVersion === 6) {
        if (this.line6.length % 23 !== 0) {
          throw new Error('Line6 length is not a multiple of 23');
        }
        return this.line6.length / 23;
      }
    } else if (ipVersion === 4) {
      return this.line.length;
    } else if (ipVersion === 6) {
      return this.line6.length;
    }

    throw new Error(`Invalid IP version: ${ipVersion}`);
  }

  binarySearch = (target) => {
    let left = 0;
    let right = this.getLineLength(4) - 1;

    while (left <= right) {
      const mid = Math.floor((left + right) / 2);
      const midVal = this.getLineEntry(mid, 4)[1];

      if (midVal === target) {
        return mid;
      } else if (midVal < target) {
        left = mid + 1;
      } else {
        right = mid - 1;
      }
    }

    return left;
  }

  binarySearch6 = (targetVal) => {
    let left = 0;
    let right = this.getLineLength(6) - 1;

    while (left <= right) {
      const mid = Math.floor((left + right) / 2);
      let midVal = this.getLineEntry(mid, 6)[1];

      if (midVal === targetVal) {
        return mid;
      } else if (midVal < targetVal) {
        left = mid + 1;
      } else {
        right = mid - 1;
      }
    }

    return left;
  }

  checkOverlapping = (ipVersion, ipInt, index) => {
    if (this.ignoreOverlapping) {
      return -1;
    }

    const overlapping = ipVersion === 4 ? this.overlapping[index] : this.overlapping6[index];

    if (this.onMultiMatch === ON_MULTI_ALL) {
      let allMatches = new Set();
      if (overlapping) {
        const firstNet = this.getNetwork(ipVersion, this.getLineIndex(ipVersion, index));
        if (this.isInNet(ipInt, firstNet)) {
          allMatches.add(index);
        }

        let idx = 0;

        for (const oIndex of overlapping) {
          const net = this.getNetwork(ipVersion, this.getLineIndex(ipVersion, oIndex));
          if (this.isInNet(ipInt, net)) {
            allMatches.add(oIndex);
          }
          if (idx >= this.overlappingCutoff) {
            return allMatches;
          }
          idx++;
        }
      }
      return allMatches;
    }

    if (overlapping) {
      const firstNet = this.getNetwork(ipVersion, this.getLineIndex(ipVersion, index));
      const inFirstNet = this.isInNet(ipInt, firstNet);

      if (this.onMultiMatch === ON_MULTI_FIRST) {
        if (inFirstNet) {
          return index;
        }
      }

      let idx = 0;

      for (const oIndex of overlapping) {
        const net = this.getNetwork(ipVersion, this.getLineIndex(ipVersion, oIndex));
        if (this.isInNet(ipInt, net)) {
          if (this.onMultiMatch === ON_MULTI_SMALLEST) {
            if (inFirstNet && this.compareNets(net, firstNet)) {
              return index;
            } else {
              return oIndex;
            }
          } else if (this.onMultiMatch === ON_MULTI_LARGEST) {
            if (this.compareNets(net, firstNet)) {
              return oIndex;
            } else if (inFirstNet) {
              return index;
            }
          } else {
            return oIndex;
          }
        }

        if (idx >= this.overlappingCutoff) {
          return -1;
        }
        idx++;

      }
    }

    return -1;
  }

  findUncoveredRanges = (ipVersion = 4) => {
    const uncoveredRanges = [];
    let openCount = 0;
    let prevIpInt = null;

    for (let i = 1; i < this.getLineLength(ipVersion); i++) {
      const [type, ipInt, num] = this.getLineEntry(i, ipVersion);
      if (type === START_RANGE) {
        if (openCount === 0) {
          // This is the beginning of an uncovered range.
          if (Math.abs(ipInt - prevIpInt) > 1) {
            uncoveredRanges.push([prevIpInt, ipInt]);
          }
        }
        openCount++;
      } else if (type === END_RANGE) {
        openCount--;
        if (openCount === 0) {
          // This is the end of an uncovered range.
          prevIpInt = ipInt;
        }
      }
    }

    return uncoveredRanges;
  }

  isStraightMatch = (ipVersion, ipInt, index) => {
    let straightMatch = false;

    if (index >= 0 && index < this.getLineLength(ipVersion)) {
      const lineElement = this.getLineEntry(index, ipVersion)[1];
      straightMatch = (lineElement === ipInt);
    }

    return straightMatch;
  }

  // Function to get a value from where with a certain key
  getWhereValue(buffer, key) {
    const offset = parseInt(key) * 4;
    // check bounds
    if (offset >= buffer.length) {
      throw new Error('Index out of range in buffer');
    }
    return buffer.readUInt32LE(offset);
  }

  getLineIndex = (ipVersion, index) => {
    const where = ipVersion === 4 ? this.where : this.where6;
    if (this.loadedFromPersisted) {
      return this.getWhereValue(where, index);
    } else {
      return parseInt(where[index]);
    }
  }

  getNetwork = (ipVersion, lineIndex) => {
    const [type, _range, _index, relativeIndex] = this.getLineEntry(lineIndex, ipVersion);
    const getRelLineEl = this.getLineEntry(relativeIndex, ipVersion);

    if (type === START_RANGE) {
      return [_range, getRelLineEl[1]];
    } else if (type === END_RANGE) {
      return [getRelLineEl[1], _range];
    }
  }

  getObject = (ipVersion, rangeIndex) => {
    return ipVersion === 4 ? this.objects[rangeIndex] : this.objects6[rangeIndex];
  }

  finalize = (ipVersion, index = null, allMatches = null, returnNetwork = false, directLookupHit = null) => {
    if (directLookupHit) {
      // ON_MULTI_ALL always requires an array as return value
      if (returnNetwork) {
        if (this.onMultiMatch === ON_MULTI_ALL) {
          return [directLookupHit,];
        } else {
          return directLookupHit;
        }
      } else {
        if (this.onMultiMatch === ON_MULTI_ALL) {
          return [directLookupHit.obj,];
        } else {
          return directLookupHit.obj;
        }
      }
    }

    if (index !== null) {
      if (returnNetwork) {
        return {
          obj: this.getObject(ipVersion, index),
          network: this.getNetwork(ipVersion, this.getLineIndex(ipVersion, index)),
        };
      } else {
        return ipVersion === 4 ? this.objects[index] : this.objects6[index];
      }
    } else if (allMatches !== null) {
      if (returnNetwork) {
        return [...allMatches].map((index) => {
          return {
            obj: this.getObject(ipVersion, index),
            network: this.getNetwork(ipVersion, this.getLineIndex(ipVersion, index))
          };
        });
      } else {
        return [...allMatches].map((index) => this.getObject(ipVersion, index));
      }
    }
  }

  fastLookup = (ip, returnNetwork = false) => {
    let line = null;
    let ipInt = -1;
    let index = -1;
    let straightMatch = false;
    let rangeIndex = -1;
    let deltaIndex = -1;
    let inOpenRange = false;

    const ipVersion = isIP(ip);
    if (ipVersion === 0) {
      return;
    }

    if (ipVersion === 4) {
      ipInt = IPv4ToInt(ip);
    } else if (ipVersion === 6) {
      ipInt = IPv6.fromString(ip).value
    }

    // In case of IPv4, the directLut contains IPv4 Integer representation as keys in order to save RAM
    // In case of IPv6, the stringified IP version is used
    const directLookup = (ipVersion === 4) ? this.directLut[ipInt] : this.directLut[ip];
    if (directLookup) {
      const hit = {
        network: [ipInt, ipInt],
        obj: directLookup,
      };
      return this.finalize(ipVersion, deltaIndex, null, returnNetwork, hit);
    }

    if (ipVersion === 4) {
      index = this.binarySearch(ipInt);
      line = this.line;
    } else if (ipVersion === 6) {
      index = this.binarySearch6(ipInt);
      line = this.line6;
    }

    straightMatch = this.isStraightMatch(ipVersion, ipInt, index);

    // special case: index === (line.length - 1)
    // we are at the very end and cannot be in any range
    if (!straightMatch && index >= line.length) {
      return null;
    }

    // special case: index === 0
    // we are at the very beginning and cannot be in any range
    if (!straightMatch && index === 0) {
      return null;
    }

    // special case: ipInt matches an element in the line
    if (straightMatch) {
      rangeIndex = this.getLineEntry(index, ipVersion)[2];
    } else {
      // if left in the line is a START_RANGE element
      // then we are in this range
      const left = this.getLineEntry(index - 1, ipVersion);
      rangeIndex = left[2];
      if (left[0] === START_RANGE) {
        inOpenRange = true;
      } else {
        // if left in the line is a END_RANGE element
        // then we could be in an overlapping range 
        // or we are not in any range at all
        // In order to find out if we are in a overlapping range, 
        // find all overlapping ranges of the END_RANGE element
      }
    }

    if (this.onMultiMatch === ON_MULTI_FIRST) {
      if (straightMatch) {
        return this.finalize(ipVersion, rangeIndex, null, returnNetwork);
      }

      if (inOpenRange) {
        if (rangeIndex !== -1) {
          return this.finalize(ipVersion, rangeIndex, null, returnNetwork);
        }
      }
    }

    if (this.onMultiMatch === ON_MULTI_ALL) {
      let allMatches = this.checkOverlapping(ipVersion, ipInt, rangeIndex);
      if (inOpenRange || straightMatch) {
        allMatches.add(rangeIndex);
      }
      return this.finalize(ipVersion, null, allMatches, returnNetwork);
    }

    if (rangeIndex !== -1) {
      deltaIndex = this.checkOverlapping(ipVersion, ipInt, rangeIndex);
    }

    if (deltaIndex !== -1) {
      return this.finalize(ipVersion, deltaIndex, null, returnNetwork);
    }

    if (rangeIndex !== -1) {
      const lineIndex = this.getLineIndex(ipVersion, rangeIndex);
      if (!isNaN(lineIndex)) {
        const net = this.getNetwork(ipVersion, lineIndex);
        if (this.isInNet(ipInt, net)) {
          return this.finalize(ipVersion, rangeIndex, null, returnNetwork);
        }
      }
    }

    return null;
  }

  lookupRange = (startIp, endIp, ipVersion = 4, returnLutObjects = false) => {
    let entries = [];
    let startIpInt, endIpInt;

    if (ipVersion === 4) {
      startIpInt = IPv4ToInt(startIp);
      endIpInt = IPv4ToInt(endIp);
    } else if (ipVersion === 6) {
      startIpInt = IPv6.fromString(startIp).value;
      endIpInt = IPv6.fromString(endIp).value;
    } else {
      return entries;
    }

    let startIndex, endIndex;
    let line;

    if (ipVersion === 4) {
      startIndex = this.binarySearch(startIpInt);
      endIndex = this.binarySearch(endIpInt);
      line = this.line;
    } else if (ipVersion === 6) {
      startIndex = this.binarySearch6(startIpInt);
      endIndex = this.binarySearch6(endIpInt);
      line = this.line6;
    }

    const seen = new Set();
    for (let index = startIndex; index <= endIndex; index++) {
      const entry = this.getLineEntry(index, ipVersion);
      if (entry) {
        if (returnLutObjects) {
          const net = this.getNetwork(ipVersion, entry[3]);
          const netStr = networkToStr(net, ipVersion);
          const key = JSON.stringify({ object: this.getObject(ipVersion, entry[2]), network: netStr });
          if (!seen.has(key)) {
            entries.push({ object: this.getObject(ipVersion, entry[2]), network: netStr });
            seen.add(key);
          }
        } else {
          const key = JSON.stringify(entry);
          if (!seen.has(key)) {
            entries.push(entry);
            seen.add(key);
          }
        }
      }
    }

    return entries;
  }

  getEntriesForNetworkRange = (network, returnLutObjects = false) => {
    const [firstIp, lastIp] = getFirstAndLastIpOfNetwork(network);
    const ipVersion = isIP(firstIp);
    if (ipVersion === 0) {
      return [];
    }
    const entries = this.lookupRange(firstIp, lastIp, ipVersion, returnLutObjects);
    return entries;
  }

  getOverlapping = (ipVersion = 4, humanReadable = false) => {
    let maxBucket = -Infinity;
    let minBucket = Infinity;
    let overlapping = ipVersion === 4 ? this.overlapping : this.overlapping6;
    let overlappingNetworks = {};

    for (const index in overlapping) {
      const lineIndex = this.getLineIndex(ipVersion, index);
      const net = this.getNetwork(ipVersion, lineIndex);
      const netStr = networkToStr(net, ipVersion);
      overlappingNetworks[netStr] = [];
      maxBucket = Math.max(maxBucket, overlapping[index].length);
      minBucket = Math.min(minBucket, overlapping[index].length);
      for (const overlapIndex of overlapping[index]) {
        const lineIndexOverlap = this.getLineIndex(ipVersion, overlapIndex);
        const netOverlap = this.getNetwork(ipVersion, lineIndexOverlap);
        if (humanReadable) {
          overlappingNetworks[netStr].push(networkToStr(netOverlap, ipVersion));
        } else {
          overlappingNetworks[netStr].push(netOverlap);
        }
      }
    }

    return {
      overlappingNetworks,
      maxBucket,
      minBucket
    };
  }

  printOverlapping = (ipVersion = 4) => {
    const { overlappingNetworks, maxBucket, minBucket } = this.getOverlapping(ipVersion);
    for (const netStr in overlappingNetworks) {
      log(netStr, 'overlaps with');
      const overlappingNets = overlappingNetworks[netStr];
      for (const overlaps in overlappingNets) {
        log('\t', networkToStr(overlappingNets[overlaps], ipVersion), this.netSize(overlappingNets[overlaps]));
      }
    }
  }

  prepareLut = (lutType = null) => {
    if (lutType === 4 || lutType === null) {
      this.sweepLine(this.ranges, 4);
      if (this.overlapping) {
        const numOverlapping = Object.keys(this.overlapping).length;
        if (this.verbose) {
          log(`${numOverlapping}/${this.ranges.length} ranges are overlapping`);
        }
      }
      this.duplicateCheck = null;
      this.lutLocked = true;
    }

    if (lutType === 6 || lutType === null) {
      this.sweepLine(this.ranges6, 6);
      if (this.overlapping6) {
        const numOverlapping6 = Object.keys(this.overlapping6).length;
        if (this.verbose) {
          log(`${numOverlapping6}/${this.ranges6.length} ranges6 are overlapping`);
        }
      }
      this.duplicateCheck6 = null;
      this.lutLocked6 = true;
    }

    // de-duplicate this.directLut if ON_MULTI_ALL is used
    if (this.onMultiMatch === ON_MULTI_ALL) {
      for (const key in this.directLut) {
        if (Array.isArray(this.directLut[key])) {
          const withoutDuplicates = [...new Set(this.directLut[key])];
          if (withoutDuplicates.length === 1) {
            this.directLut[key] = withoutDuplicates[0];
          } else {
            this.directLut[key] = withoutDuplicates;
          }
        }
      }
    }

    if (this.verbose) {
      log(`Inserted networks: ${JSON.stringify(this.netsAdded, null, 2)}`);
      log(`Not added networks: ${JSON.stringify(this.notAdded, null, 2)}`);
    }
  }

  writeTimestampSync() {
    try {
      const filePath = path.join(this.ramDbStoreDir, 'tsCreated.json');
      // Ensure unique timestamp by adding a small random component
      // This prevents race conditions when multiple instances persist simultaneously
      const fileLutVersion = Date.now() + Math.floor(Math.random() * 100);
      fs.writeFileSync(filePath, JSON.stringify({ lutVersion: fileLutVersion }));
      log(`[${this.name}] Timestamp file written to ${filePath}`, 'DEBUG');
    } catch (err) {
      log(`[${this.name}] Error writing timestamp file: ${err}`, 'ERROR');
    }
  }

  convertLineToBinary(line) {
    const buffer = Buffer.alloc(line.length * 11); // 2 bits + 32 bits + 27 bits + 27 bits = 11 bytes per entry

    line.forEach((entry, index) => {
      const byteOffset = index * 11;
      const firstValue = entry[0] & 0x03; // 2 bits for the first element
      const secondValue = entry[1] >>> 0; // 32 bits for the IPv4 address
      const thirdValue = entry[2] & 0x07FFFFFF; // 27 bits for the first index
      const fourthValue = entry[3] & 0x07FFFFFF; // 27 bits for the second index

      buffer.writeUInt8(firstValue, byteOffset); // Write the first 2 bits
      buffer.writeUInt32LE(secondValue, byteOffset + 1); // Write the next 32 bits
      buffer.writeUIntLE(thirdValue, byteOffset + 5, 3); // Write the next 27 bits
      buffer.writeUIntLE(fourthValue, byteOffset + 8, 3); // Write the last 27 bits
    });

    return buffer;
  }

  convertLineToBinary6(line6) {
    const buffer = Buffer.alloc(line6.length * 23); // 2 bits + 128 bits + 27 bits + 27 bits = 23 bytes per entry

    line6.forEach((entry, index) => {
      const byteOffset = index * 23;
      const firstValue = entry[0] & 0x03; // 2 bits for the first element
      const secondValue = entry[1]; // 128 bits for the IPv6 address
      const thirdValue = entry[2] & 0x07FFFFFF; // 27 bits for the first index
      const fourthValue = entry[3] & 0x07FFFFFF; // 27 bits for the second index

      buffer.writeUInt8(firstValue, byteOffset); // Write the first 2 bits
      buffer.writeBigUInt64LE(BigInt(secondValue) >> 64n, byteOffset + 1); // Write the first 64 bits of the IPv6 address
      buffer.writeBigUInt64LE(BigInt(secondValue) & 0xFFFFFFFFFFFFFFFFn, byteOffset + 9); // Write the next 64 bits of the IPv6 address
      buffer.writeUIntLE(thirdValue, byteOffset + 17, 3); // Write the next 27 bits
      buffer.writeUIntLE(fourthValue, byteOffset + 20, 3); // Write the last 27 bits
    });

    return buffer;
  }

  getBinaryLineElement(index) {
    const byteOffset = index * 11;
    if (byteOffset >= this.line.length) {
      throw new Error('Index out of range in line');
    }

    const firstValue = this.line.readUInt8(byteOffset) & 0x03; // 2 bits for the first element
    const secondValue = this.line.readUInt32LE(byteOffset + 1); // 32 bits for the IPv4 address
    const thirdValue = this.line.readUIntLE(byteOffset + 5, 3) & 0x07FFFFFF; // 27 bits for the first index
    const fourthValue = this.line.readUIntLE(byteOffset + 8, 3) & 0x07FFFFFF; // 27 bits for the second index

    return [
      firstValue,
      secondValue,
      thirdValue,
      fourthValue
    ];
  }

  getBinaryLineElement6(index) {
    const byteOffset = index * 23;
    if (byteOffset >= this.line6.length) {
      throw new Error('Index out of range in line6');
    }

    const firstValue = this.line6.readUInt8(byteOffset) & 0x03; // 2 bits for the first element
    const secondValue = (BigInt(this.line6.readBigUInt64LE(byteOffset + 1)) << 64n) | BigInt(this.line6.readBigUInt64LE(byteOffset + 9)); // 128 bits for the IPv6 address
    const thirdValue = this.line6.readUIntLE(byteOffset + 17, 3) & 0x07FFFFFF; // 27 bits for the first index
    const fourthValue = this.line6.readUIntLE(byteOffset + 20, 3) & 0x07FFFFFF; // 27 bits for the second index

    return [
      firstValue,
      secondValue,
      thirdValue,
      fourthValue
    ];
  }

  // Function to convert JSON to binary format
  convertWhereToBinary(whereAsJson) {
    const values = Object.values(whereAsJson);
    const buffer = Buffer.alloc(values.length * 4); // 4 bytes per 32-bit integer

    for (let i = 0; i < values.length; i++) {
      buffer.writeUInt32LE(values[i], i * 4);
    }

    return buffer;
  }

  sanitizeOverlappingMap(overlap, validLength) {
    if (!overlap || typeof overlap !== 'object' || !Number.isInteger(validLength) || validLength <= 0) {
      return {};
    }

    const sanitized = {};

    for (const key of Object.keys(overlap)) {
      const numericKey = Number(key);
      if (!Number.isInteger(numericKey) || numericKey < 0 || numericKey >= validLength) {
        continue;
      }

      const neighbours = overlap[key];
      if (!Array.isArray(neighbours)) {
        continue;
      }

      const filtered = neighbours
        .map((val) => Number(val))
        .filter((val) => Number.isInteger(val) && val >= 0 && val < validLength);

      if (filtered.length > 0) {
        sanitized[numericKey] = filtered;
      }
    }

    return sanitized;
  }

  dump(prop, bufOrObj, isBin) {
    const file = path.join(this.ramDbStoreDir, `${prop}.${isBin ? 'bin' : 'json'}`);
    if (isBin) {
      fs.writeFileSync(file, bufOrObj);
    } else {
      fs.writeFileSync(file, JSON.stringify(bufOrObj));
    }
    if (this.verbose) log(`Wrote ${file} (${isBin ? bufOrObj.length : 'JSON'} bytes)`, 'DEBUG');
  }

  readBin(filePath) {
    return fs.existsSync(filePath) ? fs.readFileSync(filePath) : null;
  }

  readJson(filePath) {
    return fs.existsSync(filePath) ? JSON.parse(fs.readFileSync(filePath, 'utf-8')) : null;
  }

  /* -------------------------------------------------------------------
   * Persist LUT – now stores overlapping*.bin in binary
   * ---------------------------------------------------------------- */
  persistLut() {
    /* 1. encode sweep-line arrays & where-maps exactly as before ------- */
    if (!Buffer.isBuffer(this.line)) {
      this.line = this.convertLineToBinary(this.line || []);
    }
    if (!Buffer.isBuffer(this.line6)) {
      this.line6 = this.convertLineToBinary6(this.line6 || []);
    }
    if (!Buffer.isBuffer(this.where)) {
      this.where = this.convertWhereToBinary(this.where || {});
    }
    if (!Buffer.isBuffer(this.where6)) {
      this.where6 = this.convertWhereToBinary(this.where6 || {});
    }

    createDirectoryIfNotExists(this.ramDbStoreDir);

    /* 2. encode overlapping maps -------------------------------------- */
    if (this.overlapping && !this.ignoreOverlapping) {
      const overlapBuf = overlappingToBinary(this.overlapping);
      this.dump('overlapping', overlapBuf, true);
    }
    if (this.overlapping6 && !this.ignoreOverlapping) {
      const overlapBuf6 = overlappingToBinary(this.overlapping6);
      this.dump('overlapping6', overlapBuf6, true);
    }

    /* 3. encode other maps -------------------------------------------- */
    this.dump('line', this.line, true);
    this.dump('line6', this.line6, true);
    this.dump('where', this.where, true);
    this.dump('where6', this.where6, true);
    this.dump('objects', this.objects, false);
    this.dump('objects6', this.objects6, false);
    this.dump('directLut', this.directLut, false);

    /* timestamp file -------------------------------------------------- */
    this.writeTimestampSync();
    return 'success';
  }

  loadPersistedLut = () => {
    if (!fs.existsSync(this.ramDbStoreDir)) {
      log(`loadPersistedLut() failed, file ${this.ramDbStoreDir} does not exist`, 'ERROR');
      return 'ramDbStoreDirDoesNotExist';
    }

    let fileLutVersion = null;
    // first read the tsCreated file
    const timestampFile = path.join(this.ramDbStoreDir, 'tsCreated.json');
    if (fs.existsSync(timestampFile)) {
      const fileData = JSON.parse(fs.readFileSync(timestampFile, 'utf-8'));
      fileLutVersion = fileData.lutVersion;

      if (this.lutVersion === null) {
        log(`[${this.name}] Initially loading database from disk`, 'DEBUG');
      } else {
        if (this.lutVersion === fileLutVersion) {
          log(`[${this.name}] Reload not needed, database on disk same as in memory.`, 'DEBUG');
          return 'reloadNotNeeded';
        } else if (this.lutVersion < fileLutVersion) {
          log(`[${this.name}] Reloading, database on disk is more recent.`, 'DEBUG');
        }
      }
    } else {
      log(`[${this.name}] Timestamp file in Ram database not found. Trying to load anyway.`, 'DEBUG');
    }

    this.line = this.readBin(path.join(this.ramDbStoreDir, 'line.bin')) || [];
    this.line6 = this.readBin(path.join(this.ramDbStoreDir, 'line6.bin')) || [];
    this.where = this.readBin(path.join(this.ramDbStoreDir, 'where.bin')) || [];
    this.where6 = this.readBin(path.join(this.ramDbStoreDir, 'where6.bin')) || [];
    this.objects = this.readJson(path.join(this.ramDbStoreDir, 'objects.json')) || [];
    this.objects6 = this.readJson(path.join(this.ramDbStoreDir, 'objects6.json')) || [];
    this.directLut = this.readJson(path.join(this.ramDbStoreDir, 'directLut.json')) || {};

    /* overlapping ----------------------------------------------------- */
    if (!this.ignoreOverlapping) {
      const o4 = this.readBin(path.join(this.ramDbStoreDir, 'overlapping.bin'));
      const o6 = this.readBin(path.join(this.ramDbStoreDir, 'overlapping6.bin'));
      if (o4) {
        this.overlapping = this.sanitizeOverlappingMap(binaryToOverlapping(o4), this.objects.length);
      } else {
        this.overlapping = {};
      }
      if (o6) {
        this.overlapping6 = this.sanitizeOverlappingMap(binaryToOverlapping(o6), this.objects6.length);
      } else {
        this.overlapping6 = {};
      }
    }

    this.loadedFromPersisted = true;
    this.lutLocked = this.lutLocked6 = true;
    this.lutVersion = fileLutVersion;
    return 'success';
  }

  iterLut = (callback, what = 'both', directLut = true) => {
    let ipVersions = [];

    if (what === 4) {
      ipVersions = [4];
    } else if (what === 6) {
      ipVersions = [6];
    } else if (what === 'both') {
      ipVersions = [4, 6];
    }

    for (const ipVersion of ipVersions) {
      let alreadySeenNets = {};
      const lineLength = this.getLineLength(ipVersion);
      for (let lineIdx = 0; lineIdx < lineLength; lineIdx++) {
        const net = this.getNetwork(ipVersion, lineIdx);
        if (net in alreadySeenNets) {
          continue;
        }
        const objectIdx = this.getLineEntry(lineIdx, ipVersion)[2];
        const network = networkToStr(net, ipVersion, true);
        const obj = this.getObject(ipVersion, objectIdx);
        callback(network, obj, ipVersion);
        alreadySeenNets[net] = 1;
      }
    }

    if (directLut) {
      for (const ip in this.directLut) {
        const value = this.directLut[ip];
        let type = null;
        let ipStr = ip;
        if (isInteger(ip)) {
          type = 4;
          ipStr = IntToIPv4(ip);
        } else {
          type = 6;
        }
        callback(ipStr, value, type);
      }
    }
  }

  getRandomLutEntries = (num = 100, ipVersion = 4) => {
    let randomEntries = [];
    const lineLength = this.getLineLength(ipVersion);

    if (lineLength && lineLength > 0) {
      for (let i = 0; i < num; i++) {
        const randomIndex = getRandomInt(0, lineLength - 1);
        let [startRange, endRange] = this.getNetwork(ipVersion, randomIndex);
        const randomIP = getRandomInt(Number(startRange), Number(endRange));
        randomEntries.push(ipVersion === 4 ? IntToIPv4(randomIP) : IntToIPv6(randomIP))
      }
    } else {
      const ips = Object.keys(this.directLut);
      for (let i = 0; i < num; i++) {
        const randomIndex = getRandomInt(0, ips.length - 1);
        const ip = ips[randomIndex];
        let ipStr = ip;
        if (isInteger(ip)) {
          ipStr = IntToIPv4(ip);
        }
        randomEntries.push(ipStr);
      }
    }

    return randomEntries;
  }

  getEntriesForLargestNets = (limit = 200, ipVersion = 4) => {
    let netObjects = [];

    this.iterLut((network, obj, _ipVersion) => {
      const netSize = numHostsInNet(network);
      netObjects.push([netSize, obj]);
    }, ipVersion, false);

    netObjects.sort((net1, net2) => net2[0] - net1[0]);
    return netObjects.slice(0, limit);
  }
}

module.exports = {
  FastLut,
  ON_MULTI_FIRST,
  ON_MULTI_SMALLEST,
  ON_MULTI_LARGEST,
  ON_MULTI_ALL
};
