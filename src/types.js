const TYPE_ISP = 1;
const TYPE_HOSTING = 2;
const TYPE_BANKING = 3;
const TYPE_EDUCATION = 4;
const TYPE_GOVERNMENT = 5;
const TYPE_BUSINESS = 6;

const encodeType = (typeStr) => {
  if (typeof typeStr === 'string') {
    typeStr = typeStr.toLowerCase().trim();
    switch (typeStr) {
      case 'isp': return TYPE_ISP;
      case 'hosting': return TYPE_HOSTING;
      case 'banking': return TYPE_BANKING;
      case 'education': return TYPE_EDUCATION;
      case 'government': return TYPE_GOVERNMENT;
      case 'business': return TYPE_BUSINESS;
    };
  }
  return 0;
};

const decodeType = (typeInt) => {
  if (typeof typeInt === 'string') {
    typeInt = parseInt(typeInt.trim());
    switch (typeInt) {
      case TYPE_ISP: return 'isp';
      case TYPE_HOSTING: return 'hosting';
      case TYPE_BANKING: return 'banking';
      case TYPE_EDUCATION: return 'education';
      case TYPE_GOVERNMENT: return 'government';
      case TYPE_BUSINESS: return 'business';
    };
  }
};

const RIR_ARIN = '1';
const RIR_AFRINIC = '2';
const RIR_APNIC = '3';
const RIR_LACNIC = '4';
const RIR_RIPE = '5';
const RIR_JPNIC = '6';
const RIR_TWNIC = '7';
const RIR_KRNIC = '8';
const RIR_RWHOIS = '9';
const RIR_ARIN_CUST = 'x';

const encodeRir = (rirStr) => {
  if (typeof rirStr === 'string') {
    rirStr = rirStr.toLowerCase().trim();
    switch (rirStr) {
      case 'arin': return RIR_ARIN;
      case 'arin_cust': return RIR_ARIN_CUST;
      case 'afrinic': return RIR_AFRINIC;
      case 'apnic': return RIR_APNIC;
      case 'lacnic': return RIR_LACNIC;
      case 'ripe': return RIR_RIPE;
      case 'jpnic': return RIR_JPNIC;
      case 'twnic': return RIR_TWNIC;
      case 'krnic': return RIR_KRNIC;
      case 'rwhois': return RIR_RWHOIS;
    };
  }
  return 0;
};

const decodeRir = (rirChar) => {
  switch (rirChar) {
    case RIR_ARIN: return 'ARIN';
    case RIR_ARIN_CUST: return 'ARIN_CUST';
    case RIR_AFRINIC: return 'AFRINIC';
    case RIR_APNIC: return 'APNIC';
    case RIR_LACNIC: return 'LACNIC';
    case RIR_RIPE: return 'RIPE';
    case RIR_JPNIC: return 'JPNIC';
    case RIR_TWNIC: return 'TWNIC';
    case RIR_KRNIC: return 'KRNIC';
    case RIR_RWHOIS: return 'RWHOIS';
  };
};

module.exports = {
  encodeType,
  decodeType,
  encodeRir,
  decodeRir
};