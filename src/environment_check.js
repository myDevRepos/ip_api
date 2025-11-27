const fs = require('fs');
const { log } = require('./utils');
const {
  RAM_DB_DIR,
  WHOIS_DATA_DIR,
  ASN_USED_AUTNUMS_RAM_DB_FILE,
  ASN_ABUSER_SCORE_FILE,
  ASN_DATA_RAM_DB_FILE,
  COMPANY_LUT_FILE,
  COMPANY_ORG_ABUSER_SCORE_FILE,
  GEONAME_ID_LUT_FILE
} = require('./constants');

/**
 * Environment validation for ip_api startup
 * Checks that required directories and files exist, are not empty, and are not older than 4 weeks
 */

const FOUR_WEEKS_IN_MS = 4 * 7 * 24 * 60 * 60 * 1000; // 4 weeks in milliseconds

/**
 * Check if a directory exists
 * @param {string} dirPath - Path to the directory
 * @param {string} dirName - Name of the directory for error messages
 * @throws {Error} If directory doesn't exist
 */
function checkDirectoryExists(dirPath, dirName) {
  if (!fs.existsSync(dirPath)) {
    throw new Error(`Environment check failed: ${dirName} directory does not exist at ${dirPath}`);
  }

  if (!fs.statSync(dirPath).isDirectory()) {
    throw new Error(`Environment check failed: ${dirName} path exists but is not a directory at ${dirPath}`);
  }
}

/**
 * Check if a directory exists, but only warn if it doesn't (don't throw error)
 * @param {string} dirPath - Path to the directory
 * @param {string} dirName - Name of the directory for warning messages
 */
function checkDirectoryExistsWithWarning(dirPath, dirName) {
  if (!fs.existsSync(dirPath)) {
    log(`Warning: ${dirName} directory does not exist at ${dirPath}`, 'WARN');
    return;
  }

  if (!fs.statSync(dirPath).isDirectory()) {
    log(`Warning: ${dirName} path exists but is not a directory at ${dirPath}`, 'WARN');
  }
}

/**
 * Check if a file exists, is not empty, and is not older than 4 weeks
 * @param {string} filePath - Path to the file
 * @param {string} fileName - Name of the file for error messages
 * @throws {Error} If file doesn't exist, is empty, or is too old
 */
function checkFileExistsAndValid(filePath, fileName) {
  // Check if file exists
  if (!fs.existsSync(filePath)) {
    throw new Error(`Environment check failed: ${fileName} does not exist at ${filePath}`);
  }

  // Check if it's actually a file
  const stats = fs.statSync(filePath);
  if (!stats.isFile()) {
    throw new Error(`Environment check failed: ${fileName} path exists but is not a file at ${filePath}`);
  }

  // Check if file is not empty
  if (stats.size === 0) {
    throw new Error(`Environment check failed: ${fileName} is empty at ${filePath}`);
  }

  // Check if file is not older than 4 weeks
  const now = new Date();
  const fileAge = now.getTime() - stats.mtime.getTime();

  if (fileAge > FOUR_WEEKS_IN_MS) {
    const fileAgeDays = Math.floor(fileAge / (24 * 60 * 60 * 1000));
    const maxAgeDays = Math.floor(FOUR_WEEKS_IN_MS / (24 * 60 * 60 * 1000));
    throw new Error(`Environment check failed: ${fileName} is too old (${fileAgeDays} days) at ${filePath}. Maximum allowed age is ${maxAgeDays} days (4 weeks)`);
  }
}

/**
 * Perform all environment checks
 * @throws {Error} If any check fails
 */
function performEnvironmentChecks() {
  // Check required directories
  checkDirectoryExists(RAM_DB_DIR, 'RAM_DB_DIR');
  checkDirectoryExistsWithWarning(WHOIS_DATA_DIR, 'WHOIS_DATA_DIR');

  // Check ASN files
  checkFileExistsAndValid(ASN_USED_AUTNUMS_RAM_DB_FILE, 'ASN_USED_AUTNUMS_RAM_DB_FILE');
  checkFileExistsAndValid(ASN_ABUSER_SCORE_FILE, 'ASN_ABUSER_SCORE_FILE');
  checkFileExistsAndValid(ASN_DATA_RAM_DB_FILE, 'ASN_DATA_RAM_DB_FILE');

  // Check Company and Geolocation files
  checkFileExistsAndValid(COMPANY_LUT_FILE, 'COMPANY_LUT_FILE');
  checkFileExistsAndValid(COMPANY_ORG_ABUSER_SCORE_FILE, 'COMPANY_ORG_ABUSER_SCORE_FILE');
  checkFileExistsAndValid(GEONAME_ID_LUT_FILE, 'GEONAME_ID_LUT_FILE');

  log('All environment checks passed successfully!', 'DEBUG');
}

/**
 * Main function to run environment checks
 * Can be called directly or imported as a module
 */
if (require.main === module) {
  try {
    performEnvironmentChecks();
    process.exit(0);
  } catch (error) {
    log(error.message, 'ERROR');
    process.exit(1);
  }
}

module.exports = {
  performEnvironmentChecks,
  checkDirectoryExists,
  checkDirectoryExistsWithWarning,
  checkFileExistsAndValid
};
