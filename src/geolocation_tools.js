const fs = require('fs');
const path = require('path');
const moment = require('moment-timezone');
const { find } = require('geo-tz');
const { createDirectoryIfNotExists, getFileAgeInDaysSync, downloadWget, log } = require('./utils');

/**
 * https://download.geonames.org/export/dump/countryInfo.txt
 */
const readCountryInfo = async (forceUpdate = false) => {
  // Download https://download.geonames.org/export/dump/countryInfo.txt
  // if the local version is older than 10 days
  const dataDir = path.join(__dirname, './data');
  createDirectoryIfNotExists(dataDir);

  const countryInfoFile = path.join(dataDir, 'countryInfo.txt');
  const ageInDays = getFileAgeInDaysSync(countryInfoFile);
  let wasUpdated = false;

  if (!fs.existsSync(countryInfoFile) || forceUpdate || ageInDays >= 10) {
    try {
      log(`Updating countryInfo.txt because the file is ${ageInDays} days old`);
      await downloadWget('https://download.geonames.org/export/dump/countryInfo.txt', countryInfoFile);
      wasUpdated = true;
    } catch (error) {
      log(`Failed to download countryInfo.txt: ${error.message}`, 'ERROR');
      // If download fails and file doesn't exist, create a minimal fallback
      if (!fs.existsSync(countryInfoFile)) {
        log(`Creating minimal countryInfo.txt fallback`, 'WARN');
        fs.writeFileSync(countryInfoFile, '# Minimal country info fallback\nUS\tUSA\t840\tUS\tUnited States\tWashington\tNorth America\n');
      }
    }
  }

  const countryLut = {};
  const EU_ISO_CODES = ['AT', 'BE', 'BG', 'CY', 'CZ', 'DE', 'DK', 'EE', 'ES', 'FI',
    'FR', 'GR', 'HR', 'HU', 'IE', 'IT', 'LT', 'LV',
    'MT', 'NL', 'PL', 'PT', 'RO', 'SE', 'SI', 'SK'];

  const countryCurrencyMap = {
    "AF": "AFN",
    "AL": "ALL",
    "DZ": "DZD",
    "AS": "USD",
    "AD": "EUR",
    "AO": "AOA",
    "AI": "XCD",
    "AQ": "",
    "AG": "XCD",
    "AR": "ARS",
    "AM": "AMD",
    "AW": "AWG",
    "AU": "AUD",
    "AT": "EUR",
    "AZ": "AZN",
    "BS": "BSD",
    "BH": "BHD",
    "BD": "BDT",
    "BB": "BBD",
    "BY": "BYN",
    "BE": "EUR",
    "BZ": "BZD",
    "BJ": "XOF",
    "BM": "BMD",
    "BT": "BTN",
    "IN": "INR",
    "BO": "BOB",
    "BV": "NOK",
    "BR": "BRL",
    "IO": "USD",
    "BN": "BND",
    "BG": "BGN",
    "BF": "XOF",
    "BI": "BIF",
    "CV": "CVE",
    "KH": "KHR",
    "CM": "XAF",
    "CA": "CAD",
    "KY": "KYD",
    "CF": "XAF",
    "TD": "XAF",
    "CL": "CLP",
    "CN": "CNY",
    "CX": "AUD",
    "CC": "AUD",
    "CO": "COP",
    "KM": "KMF",
    "CD": "CDF",
    "CG": "XAF",
    "CK": "NZD",
    "CR": "CRC",
    "HR": "EUR",
    "CU": "CUP",
    "CW": "ANG",
    "CY": "EUR",
    "CZ": "CZK",
    "DK": "DKK",
    "DJ": "DJF",
    "DM": "XCD",
    "DO": "DOP",
    "EC": "USD",
    "EG": "EGP",
    "SV": "USD",
    "GQ": "XAF",
    "ER": "ERN",
    "EE": "EUR",
    "ET": "ETB",
    "EU": "EUR",
    "FK": "FKP",
    "FO": "DKK",
    "FJ": "FJD",
    "FI": "EUR",
    "FR": "EUR",
    "GF": "EUR",
    "PF": "XPF",
    "TF": "EUR",
    "GA": "XAF",
    "GM": "GMD",
    "GE": "GEL",
    "DE": "EUR",
    "GH": "GHS",
    "GI": "GIP",
    "GR": "EUR",
    "GL": "DKK",
    "GD": "XCD",
    "GP": "EUR",
    "GU": "USD",
    "GT": "GTQ",
    "GG": "GBP",
    "GN": "GNF",
    "GW": "XOF",
    "GY": "GYD",
    "HT": "HTG",
    "HM": "AUD",
    "VA": "EUR",
    "HN": "HNL",
    "HK": "HKD",
    "HU": "HUF",
    "IS": "ISK",
    "ID": "IDR",
    "IR": "IRR",
    "IQ": "IQD",
    "IE": "EUR",
    "IM": "GBP",
    "IL": "ILS",
    "IT": "EUR",
    "JM": "JMD",
    "JP": "JPY",
    "JE": "GBP",
    "JO": "JOD",
    "KZ": "KZT",
    "KE": "KES",
    "KI": "AUD",
    "KP": "KPW",
    "KR": "KRW",
    "KW": "KWD",
    "KG": "KGS",
    "LA": "LAK",
    "LV": "EUR",
    "LB": "LBP",
    "LS": "LSL",
    "LR": "LRD",
    "LY": "LYD",
    "LI": "CHF",
    "LT": "EUR",
    "LU": "EUR",
    "MO": "MOP",
    "MG": "MGA",
    "MW": "MWK",
    "MY": "MYR",
    "MV": "MVR",
    "ML": "XOF",
    "MT": "EUR",
    "MH": "USD",
    "MQ": "EUR",
    "MR": "MRU",
    "MU": "MUR",
    "YT": "EUR",
    "MX": "MXN",
    "FM": "USD",
    "MD": "MDL",
    "MC": "EUR",
    "MN": "MNT",
    "ME": "EUR",
    "MS": "XCD",
    "MA": "MAD",
    "MZ": "MZN",
    "MM": "MMK",
    "NA": "NAD",
    "NR": "AUD",
    "NP": "NPR",
    "NL": "EUR",
    "NC": "XPF",
    "NZ": "NZD",
    "NI": "NIO",
    "NE": "XOF",
    "NG": "NGN",
    "NU": "NZD",
    "NF": "AUD",
    "MP": "USD",
    "NO": "NOK",
    "OM": "OMR",
    "PK": "PKR",
    "PW": "USD",
    "PS": "",
    "PA": "PAB",
    "PG": "PGK",
    "PY": "PYG",
    "PE": "PEN",
    "PH": "PHP",
    "PN": "NZD",
    "PL": "PLN",
    "PT": "EUR",
    "PR": "USD",
    "QA": "QAR",
    "MK": "MKD",
    "RO": "RON",
    "RU": "RUB",
    "RW": "RWF",
    "RE": "EUR",
    "BL": "EUR",
    "SH": "SHP",
    "KN": "XCD",
    "LC": "XCD",
    "MF": "EUR",
    "PM": "EUR",
    "VC": "XCD",
    "WS": "WST",
    "SM": "EUR",
    "ST": "STN",
    "SA": "SAR",
    "SN": "XOF",
    "RS": "RSD",
    "SC": "SCR",
    "SL": "SLE",
    "SG": "SGD",
    "SX": "ANG",
    "SK": "EUR",
    "SI": "EUR",
    "SB": "SBD",
    "SO": "SOS",
    "ZA": "ZAR",
    "SS": "SSP",
    "ES": "EUR",
    "LK": "LKR",
    "SD": "SDG",
    "SR": "SRD",
    "SJ": "NOK",
    "SZ": "SZL",
    "SE": "SEK",
    "CH": "CHF",
    "SY": "SYP",
    "TW": "TWD",
    "TJ": "TJS",
    "TZ": "TZS",
    "TH": "THB",
    "TL": "USD",
    "TG": "XOF",
    "TK": "NZD",
    "TO": "TOP",
    "TT": "TTD",
    "TN": "TND",
    "TR": "TRY",
    "TM": "TMT",
    "TC": "USD",
    "TV": "AUD",
    "UG": "UGX",
    "UA": "UAH",
    "AE": "AED",
    "GB": "GBP",
    "US": "USD",
    "UY": "UYU",
    "UZ": "UZS",
    "VU": "VUV",
    "VE": "VED",
    "VN": "VND",
    "VG": "USD",
    "VI": "USD",
    "WF": "XPF",
    "EH": "MAD",
    "YE": "YER",
    "ZM": "ZMW",
    "ZW": "ZWL",
    "AX": "EUR"
  };

  let lines = [];
  try {
    lines = fs.readFileSync(countryInfoFile).toString()
      .split('\n').map((line) => line.trim())
      .filter((line) => !line.startsWith('#'));
  } catch (error) {
    log(`Failed to read countryInfo.txt: ${error.message}`, 'ERROR');
    return {}; // Return empty object if file can't be read
  }

  for (const line of lines) {
    const row = line.split('\t');
    if (row[0]) {
      countryLut[row[0]] = {
        iso: row[0],
        iso3: row[1],
        iso_numeric: row[2],
        fips: row[3],
        country: row[4],
        capital: row[5],
        continent: row[8],
        calling_code: row[12],
        currency_code: countryCurrencyMap[row[0]],
        is_eu_member: EU_ISO_CODES.includes(row[0]),
      };
    }
  }

  if (wasUpdated) {
    fs.writeFileSync(path.join(dataDir, 'countryInfo.json'), JSON.stringify(countryLut, null, 2));
  }

  return countryLut;
};

const getTimeFromLocation = (lat, lon) => {
  let timezone = null;
  let local_time = null;
  let local_time_unix = null;
  let is_dst = null;
  try {
    const timezones = find(lat, lon);
    timezone = timezones[0];
    let translated = moment().tz(timezone);
    local_time_unix = translated.unix();
    is_dst = translated.isDST();
    local_time = translated.format();
  } catch (err) {
    log(`Cannot convert ${lat}, ${lon} to local time: ${err.toString()}`, 'ERROR');
  }
  return {
    timezone: timezone,
    local_time: local_time,
    local_time_unix: local_time_unix,
    is_dst: is_dst,
  };
};

module.exports = {
  readCountryInfo,
  getTimeFromLocation,
};