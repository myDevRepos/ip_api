const fs = require('fs');
const path = require('path');
const { download, executeCommandSync, executeCommand,
  getRamDatabaseVersion, get, log } = require('./utils');
const { IP_API_DB_DIR, RAM_DB_DIR } = require('./constants');

const isUpdateNeeded = async () => {
  const ramDbVersion = getRamDatabaseVersion();
  log(`[i] Current RAM database version: ${ramDbVersion || 'unknown'}`);
  let action = 'givenVersionOld';
  if (ramDbVersion) {
    try {
      const response = await get(`https://ipapi.is/app/checkDbVersion?ramDbVersion=${ramDbVersion}`);
      if (response) {
        action = response.data;
        log(`[i] Server response for version check: ${action}`);
      }
    } catch (error) {
      log(`[fail] Error checking database version: ${error.toString()}`);
    }
  }
  return action === 'givenVersionOld';
};

const updateRamDatabase = async () => {
  const parentDir = path.resolve(__dirname, '..');
  const downloadLocation = path.resolve(__dirname, '../ipapi_database_ram.zip');
  const ramDbVersion = getRamDatabaseVersion();
  const checkFile = path.resolve(RAM_DB_DIR, 'SatelliteLut/tsCreated.json');
  const ipapiDatabaseSource = `https://ipapi.is/app/get?type=ramDatabase&apiKey=rd8730s9Yshdxv&ramDbVersion=${ramDbVersion}`;
  const versionStr = ramDbVersion ? ramDbVersion : 'unknown';

  log(`[i] Starting download of RAM database version: ${versionStr}`);
  try {
    await download(ipapiDatabaseSource, downloadLocation);
    log(`[ok] Downloaded ipapi_database_ram.zip to ${downloadLocation}`);
  } catch (err) {
    log(`[fail] Failed to download ipapi_database_ram.zip: ${err.toString()}`);
    return 'update_failed';
  }

  if (fs.existsSync(downloadLocation)) {
    log(`[i] Unzipping database to ${parentDir}`);
    executeCommandSync(`unzip -q -o ${downloadLocation} -d ${parentDir}`);
    if (fs.existsSync(checkFile)) {
      log(`[ok] Successfully updated database to version: ${ramDbVersion}`);
      return 'successfully_updated';
    } else {
      log(`[fail] Failure updating database. Check file ${checkFile} not found.`);
    }
  } else {
    log(`[fail] Download location ${downloadLocation} does not exist.`);
  }

  return 'update_failed';
};

const maybeUpdateRamDatabase = async (forceUpdate = false) => {
  log(`[i] Checking whether a ipapi_database_ram.zip update is needed`);
  const shouldUpdate = await isUpdateNeeded();

  if (!shouldUpdate && !forceUpdate) {
    log(`[i] Local ipapi_database_ram.zip is the most recent one. There is no update needed.`);
    return shouldUpdate;
  } else {
    if (forceUpdate) {
      log(`[i] Force update initiated...`);
    } else {
      log(`[i] Remote database is more recent. Will download remote database...`);
    }
    log(`[i] The download might take 1 to 5 minutes, depending on your Internet connection.`);
    return await updateRamDatabase();
  }
};

const updateRawWhoisData = async () => {
  log(`[i] Attempting to download raw WHOIS data`);

  const downloadLocation = path.resolve(IP_API_DB_DIR, 'whoisData.tar.gz');

  const whoisDataUrl = 'https://ipapi.is/app/get?type=whoisData&apiKey=rd8730s9Yshdxv';
  executeCommandSync(`mkdir -p ${IP_API_DB_DIR}`);

  try {
    await download(whoisDataUrl, downloadLocation);
    log(`[ok] Downloaded whoisData.tar.gz to ${downloadLocation}`);
  } catch (err) {
    log(`[fail] Failed to download whoisData.tar.gz: ${err.toString()}`);
    return 'download_failed';
  }

  if (fs.existsSync(downloadLocation)) {
    log(`[i] Extracting WHOIS data to ${IP_API_DB_DIR}`);
    await executeCommand(`cd ${IP_API_DB_DIR} && tar -xzf whoisData.tar.gz`);
    log(`[ok] Successfully downloaded and extracted raw WHOIS data.`);
  } else {
    log(`[fail] Download location ${downloadLocation} does not exist.`);
  }
};

if (require.main === module) {
  (async () => {
    process.env.LOG_LEVEL = 3;
    const command = process.argv[2];
    if (command === 'rawWhois') {
      log(`[i] Executing command: ${command}`);
      await updateRawWhoisData();
    } else if (command === 'maybeUpdate') {
      log(`[i] Executing command: ${command}`);
      await maybeUpdateRamDatabase();
    } else if (command === 'isUpdateNeeded') {
      log(`[i] Executing command: ${command}`);
      log(await isUpdateNeeded());
    }
  })();
}

module.exports = {
  updateRamDatabase,
  isUpdateNeeded
};