const path = require('path');
const fs = require('fs');

// Database directories
// Check for alternative paths first
const alternativeIPApiDbDir = path.join(__dirname, './../../ip_api_data/ipapi_database/');
const alternativeRamDbDir = path.join(__dirname, './../../ip_api_data/ipapi_database_ram/');

const IP_API_DB_DIR = fs.existsSync(alternativeIPApiDbDir)
  ? alternativeIPApiDbDir
  : path.join(__dirname, './../ipapi_database/');

const RAM_DB_DIR = fs.existsSync(alternativeRamDbDir)
  ? alternativeRamDbDir
  : path.join(__dirname, './../ipapi_database_ram/');

const localWhoisDataDir = path.join(__dirname, './../../ip_api_data/WHOIS_CRAWL/');
const remoteWhoisDataDir = '/var/WHOIS_CRAWL/';
const WHOIS_DATA_DIR = fs.existsSync(localWhoisDataDir)
  ? localWhoisDataDir
  : remoteWhoisDataDir;

// RAW ASN table files
const ASN_RAW_TABLE_FILE = path.join(IP_API_DB_DIR, 'asn_data/data-raw-table');
const ASN_USED_AUTNUMS_FILE = path.join(IP_API_DB_DIR, 'asn_data/data-used-autnums');
const ASN_IPV6_RAW_TABLE_FILE = path.join(IP_API_DB_DIR, 'asn_data/ipv6-raw-table');
const ASN_USED_AUTNUMS_DB_FILE = path.join(IP_API_DB_DIR, 'asn_data/data-used-autnums.json');

const ASN_USED_AUTNUMS_RAM_DB_FILE = path.join(RAM_DB_DIR, 'AsnLut/data-used-autnums.json');
const ASN_ABUSER_SCORE_FILE = path.join(RAM_DB_DIR, 'AsnLut/asnAbuserScore.json');
const ASN_DATA_RAM_DB_FILE = path.join(RAM_DB_DIR, 'AsnLut/ASN_data.json');

const ACTIVE_ASNS_FILE = path.join(IP_API_DB_DIR, 'asn_data/activeASNs.json');
const ACTIVE_IPV4_IP_RANGES_FILE = path.join(IP_API_DB_DIR, 'asn_data/activeIpv4IPRanges.json');
const ASN_META_FILE = path.join(IP_API_DB_DIR, 'asn_data/ASN_meta.json');

// Company Lut
const COMPANY_LUT_FILE = path.join(RAM_DB_DIR, 'LookupTables/companyIdLut.json');
const COMPANY_ORG_ABUSER_SCORE_FILE = path.join(RAM_DB_DIR, 'CompanyLut/orgAbuserScore.json');

// Geolocation Lut
const GEONAME_ID_LUT_FILE = path.join(RAM_DB_DIR, 'LookupTables/geonameIdLut.json');

// version format is "YYYY-MM-DD"
const SOURCE_VERSION = '2025-11-27';
const APIEndpoint = 'https://api.ipapi.is/';
const defaultOrigin = 'ipapi.is';
const POS_VAL = 1;
const projectPath = path.dirname(__dirname);
const databasePath = IP_API_DB_DIR;
const ramDatabasePath = RAM_DB_DIR;
const whoisDataPath = path.join(IP_API_DB_DIR, 'whois_data/');
const delegatedFilesDir = path.join(whoisDataPath, 'DELEGATED_FILES/');
const ramDatabaseVersionFilePath = path.join(ramDatabasePath, 'version.json');
const logDir = path.join(__dirname, '../log');
const logFile = path.join(logDir, 'ipapi.log');
const apiErrorLogFile = path.join(logDir, 'ipapi_api_errors.err');
const debugLogFile = path.join(logDir, 'ipapi_debug.log');
const runDir = path.join(__dirname, './run');
const MASTER_PID_FILE = path.join(runDir, 'master.pid');
const userAgent = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36";

if (!fs.existsSync(logDir)) {
  fs.mkdirSync(logDir, { recursive: true });
}

if (!fs.existsSync(runDir)) {
  fs.mkdirSync(runDir, { recursive: true });
}

module.exports = {
  // Database directories
  IP_API_DB_DIR,
  RAM_DB_DIR,

  // ASN data files
  ASN_USED_AUTNUMS_FILE,
  ASN_RAW_TABLE_FILE,
  ASN_IPV6_RAW_TABLE_FILE,
  ASN_USED_AUTNUMS_DB_FILE,
  ASN_USED_AUTNUMS_RAM_DB_FILE,
  ASN_DATA_RAM_DB_FILE,
  ACTIVE_ASNS_FILE,
  ACTIVE_IPV4_IP_RANGES_FILE,
  ASN_META_FILE,
  ASN_ABUSER_SCORE_FILE,

  // Path constants
  delegatedFilesDir,
  ramDatabasePath,
  whoisDataPath,
  databasePath,
  projectPath,
  ramDatabaseVersionFilePath,
  logDir,
  logFile,
  apiErrorLogFile,
  debugLogFile,
  userAgent,
  MASTER_PID_FILE,

  // API constants
  SOURCE_VERSION,
  POS_VAL,
  defaultOrigin,
  APIEndpoint,

  // WHOIS data directory
  WHOIS_DATA_DIR,

  // Company Lut
  COMPANY_LUT_FILE,
  COMPANY_ORG_ABUSER_SCORE_FILE,

  // Geolocation Lut
  GEONAME_ID_LUT_FILE,
};