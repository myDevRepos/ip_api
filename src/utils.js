// Node.js built-in modules
const crypto = require('crypto');
const fs = require('fs');
const http = require('http');
const https = require('https');
const os = require('os');
const path = require('path');
const { performance } = require('perf_hooks');
const util = require('util');
const zlib = require('zlib');

// Child process modules
const { spawn } = require('child_process');
const execSync = require('child_process').execSync;
const exec = util.promisify(require('child_process').exec);

// Third-party modules
const axios = require('axios');
const csv = require('fast-csv');
const LineByLineReader = require('line-by-line');
const tar = require('tar');

// Local modules
const {
  ramDatabaseVersionFilePath,
  apiErrorLogFile,
  debugLogFile,
  userAgent,
  logFile,
  IP_API_DB_DIR,
  RAM_DB_DIR,
  SOURCE_VERSION
} = require('./constants');

function toParamObject(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    return {};
  }
  return input;
}

class RequestParamAccessor {
  constructor(body, query) {
    this.body = toParamObject(body);
    this.query = toParamObject(query);
    this.bodyNormalized = null;
    this.queryNormalized = null;
  }

  static buildNormalized(container) {
    const normalized = Object.create(null);
    const keys = Object.keys(container);
    for (let i = 0; i < keys.length; i++) {
      const key = keys[i];
      if (typeof key === 'string') {
        normalized[key.toLowerCase()] = container[key];
      }
    }
    return normalized;
  }

  getNormalized(type) {
    if (type === 'body') {
      if (this.bodyNormalized === null) {
        this.bodyNormalized = RequestParamAccessor.buildNormalized(this.body);
      }
      return this.bodyNormalized;
    }
    if (this.queryNormalized === null) {
      this.queryNormalized = RequestParamAccessor.buildNormalized(this.query);
    }
    return this.queryNormalized;
  }

  find(type, alias) {
    if (!alias) {
      return undefined;
    }
    const container = this.getNormalized(type);
    return container[alias.toLowerCase()];
  }

  getFirst(type, aliases) {
    const list = Array.isArray(aliases) ? aliases : [aliases];
    for (let i = 0; i < list.length; i++) {
      const value = this.find(type, list[i]);
      if (value !== undefined) {
        return value;
      }
    }
    return undefined;
  }

  getLast(type, aliases) {
    const list = Array.isArray(aliases) ? aliases : [aliases];
    let value;
    for (let i = 0; i < list.length; i++) {
      const maybe = this.find(type, list[i]);
      if (maybe !== undefined) {
        value = maybe;
      }
    }
    return value;
  }

  getWithPriority(aliases, defaultValue) {
    const valueFromBody = this.getFirst('body', aliases);
    if (valueFromBody !== undefined) {
      return valueFromBody;
    }
    const valueFromQuery = this.getFirst('query', aliases);
    if (valueFromQuery !== undefined) {
      return valueFromQuery;
    }
    return defaultValue;
  }

  getBodyOnly(aliases) {
    return this.getFirst('body', aliases);
  }

  getQueryOnly(aliases) {
    return this.getFirst('query', aliases);
  }

  getLastWithPriority(aliases) {
    const valueFromBody = this.getLast('body', aliases);
    if (valueFromBody !== undefined) {
      return valueFromBody;
    }
    return this.getLast('query', aliases);
  }
}

/**
 * Checks if the application is running in reduced RAM mode.
 * @returns {boolean} True if IS_REDUCED_RAM_IP_API environment variable is set
 */
const isReducedRam = () => {
  return !!process.env.IS_REDUCED_RAM_IP_API;
};

/**
 * Determines the number of clusters to use based on hostname and environment.
 * @param {number} maxClusters - Maximum number of clusters to use
 * @returns {number} The number of clusters to use
 */
const getNumClusters = (maxClusters) => {
  if (typeof maxClusters !== 'number' || maxClusters < 1) {
    throw new Error('getNumClusters: maxClusters must be a positive number');
  }

  const hostName = os.hostname();

  // Germany server
  if (['ubuntu-8gb-nbg1-5'].includes(hostName)) {
    return 3;
  }

  // US East server
  if (['pd-us-east'].includes(hostName)) {
    return 2;
  }

  // Specific VPS
  if (hostName === 'vps-1a7d3b72') {
    return 1;
  }

  // Reduced RAM mode
  if (isReducedRam()) {
    return 1;
  }

  return maxClusters;
};

/**
 * Logs a message with a specified level, supporting environment-based log level filtering.
 * Messages are routed to different log files based on their level and also output to console.
 * 
 * @param {string|object} msg - The message to log. Objects will be JSON stringified.
 * @param {string} level - The log level ('INFO', 'ERROR', 'API_ERROR', 'DEBUG', 'VERBOSE', 'WARN', 'WARNING').
 *                        Defaults to 'INFO'.
 * 
 * Environment variable LOG_LEVEL controls output filtering:
 * - 0: No output
 * - 1: Errors only (ERROR, API_ERROR)
 * - 2: Warnings and errors (ERROR, API_ERROR, WARN, WARNING)
 * - 3: All output (no filtering)
 * 
 * Log routing:
 * - API_ERROR: Written to apiErrorLogFile only
 * - DEBUG/VERBOSE: Written to debugLogFile only
 * - Others: Written to both console and logFile
 */
function log(msg, level = 'INFO') {
  if (typeof level === 'string') {
    level = level.toUpperCase().trim();
  }

  // Check LOG_LEVEL environment variable (0-3)
  // Default to 0 (no output) if LOG_LEVEL is not set
  const logLevel = parseInt(process.env.LOG_LEVEL, 10) || 0;

  // 0 = no output, 1 = error only, 2 = warning and errors, 3 = all output
  if (logLevel === 0) {
    return; // No output at all
  }
  if (logLevel === 1 && level !== 'ERROR' && level !== 'API_ERROR') {
    return; // Error only
  }
  if (logLevel === 2 && !['ERROR', 'API_ERROR', 'WARN', 'WARNING'].includes(level)) {
    return; // Warning and errors only
  }
  // logLevel === 3 allows all output (no filtering)

  const timestamp = new Date().toLocaleString();
  const stringified = typeof msg === 'object' ? JSON.stringify(msg, null, 2) : msg;

  // Get the calling module name from the stack trace
  const stack = new Error().stack;
  const callerLine = stack.split('\n')[2]; // First line after Error and log function
  const moduleMatch = callerLine.match(/at.*[\/\\]([^\/\\]+\.js):/);
  const moduleName = moduleMatch ? moduleMatch[1] : 'unknown';

  const logMessage = `[${process.pid}][${timestamp}][${moduleName}] - ${level} - ${stringified}`;

  // Route messages based on level
  if (level === 'API_ERROR') {
    fs.appendFileSync(apiErrorLogFile, logMessage + '\n');
  } else if (level === 'DEBUG' || level === 'VERBOSE') {
    fs.appendFileSync(debugLogFile, logMessage + '\n');
  } else {
    console.log(logMessage);
    fs.appendFileSync(logFile, logMessage + '\n');
  }
}

/**
 * Reads a file, automatically handling gzip files.
 * @param {string} filePath - Path to the file to read
 * @returns {string} The file content
 */
const readFile = (filePath) => {
  if (typeof filePath !== 'string') {
    throw new Error('readFile: filePath must be a string');
  }

  if (filePath.toLowerCase().endsWith('.gz')) {
    return readGzipFile(filePath);
  }
  return fs.readFileSync(filePath, 'utf-8');
};

/**
 * Reads and decompresses a gzip file.
 * @param {string} filePath - Path to the gzip file
 * @returns {string|null} The decompressed content or null if failed
 */
const readGzipFile = (filePath) => {
  if (typeof filePath !== 'string' || !filePath.endsWith('.gz')) {
    throw new Error('readGzipFile: filePath must be a string ending with .gz');
  }

  try {
    // Read the compressed file synchronously
    const compressedData = fs.readFileSync(filePath);
    // Decompress the data synchronously
    const decompressedData = zlib.gunzipSync(compressedData);
    // Process the decompressed data (e.g., convert to string, manipulate, etc.)
    return decompressedData.toString('utf-8');
  } catch (error) {
    if (error.message.includes('Cannot create a string longer than 0x1fffffe8 characters')) {
      log('Handling known max string size error, attempting gunzip fallback', 'WARN');
      const expectedFile = filePath.replace('.gz', '');
      try {
        executeCommandSync(`gunzip ${filePath}`);
        if (fs.existsSync(expectedFile)) {
          return fs.readFileSync(expectedFile, 'utf-8');
        } else {
          log(`Failed to gunzip, expected file not found: ${expectedFile}`, 'ERROR');
          return null;
        }
      } catch (gunzipError) {
        log(`Gunzip fallback failed: ${gunzipError.message}`, 'ERROR');
        return null;
      }
    } else {
      log(`Error reading gzip file ${filePath}: ${error.message}`, 'ERROR');
      return null;
    }
  }
};

/**
 * Empties a directory by removing all files in it.
 * @param {string} dir - Path to the directory to empty
 */
function emptyDir(dir) {
  if (typeof dir !== 'string') {
    throw new Error('emptyDir: dir must be a string');
  }

  if (fs.existsSync(dir)) {
    let numDeleted = 0;
    fs.readdirSync(dir).forEach(file => {
      try {
        fs.rmSync(path.join(dir, file));
        numDeleted++;
      } catch (err) {
        log(`Failed to delete file ${file}: ${err.message}`, 'ERROR');
      }
    });
    log(`Deleted ${numDeleted} files from directory ${dir}`, 'INFO');
  } else {
    log(`Directory ${dir} does not exist`, 'ERROR');
  }
}

/**
 * Normalizes a name by removing special characters and replacing spaces with hyphens.
 * @param {string} name - The name to normalize
 * @returns {string|null} The normalized name or null if input is invalid
 */
function normalizeName(name) {
  if (typeof name !== 'string') {
    return null;
  }

  return name
    .replace(/[^a-zA-Z0-9-_ ]/g, '') // Remove special characters except allowed ones
    .trim() // Remove leading/trailing whitespace
    .replace(/\s+/g, '-'); // Replace one or more spaces with single hyphen
}

/**
 * Executes a shell command asynchronously.
 * @param {string} command - The command to execute
 * @param {boolean} ignoreStderr - Whether to ignore stderr output
 * @returns {Promise<string>} The command output
 */
function executeCommand(command, ignoreStderr = false) {
  if (typeof command !== 'string' || command.trim() === '') {
    return Promise.reject(new Error('executeCommand: command must be a non-empty string'));
  }

  return new Promise((resolve, reject) => {
    exec(command, (error, stdout, stderr) => {
      if (error) {
        const errorMsg = `Command failed: ${command}. Error: ${error.message}`;
        log(errorMsg, 'ERROR');
        return reject(new Error(errorMsg));
      }

      let data = '';
      if (stderr && !ignoreStderr) {
        data += stderr;
      }
      data += stdout;
      return resolve(data);
    });
  });
}

function spawnCommand(command, args) {
  return new Promise((resolve, reject) => {
    const cmd = spawn(command, args);

    cmd.stdout.on('data', (data) => {
      console.log(data.toString().trim());
    });

    cmd.stderr.on('data', (data) => {
      console.error(data.toString().trim());
    });

    cmd.on('close', (code) => {
      if (code !== 0) {
        console.log(`child process closed with code ${code}`);
      }
      resolve(code);
    });

    cmd.on('exit', (code) => {
      // console.log(`child process exited with code ${code}`);
      resolve(code);
    });

    cmd.on('error', (err) => {
      console.log(`child process error: ${err}`);
      reject(err);
    });
  });
}

/**
 * Executes a shell command synchronously.
 * @param {string} command - The command to execute
 * @returns {string} The command output or error message
 */
function executeCommandSync(command) {
  if (typeof command !== 'string' || command.trim() === '') {
    throw new Error('executeCommandSync: command must be a non-empty string');
  }

  try {
    return execSync(command, { encoding: 'utf8' });
  } catch (err) {
    const errorMsg = `Command failed: ${command}. Error: ${err.message}`;
    log(errorMsg, 'ERROR');
    throw new Error(errorMsg);
  }
}

const createRamDatabaseVersionFile = (RAM_DB_VERSION) => {
  try {
    const versionContents = JSON.stringify({
      RAM_DB_VERSION: RAM_DB_VERSION
    }, null, 2);
    fs.writeFileSync(ramDatabaseVersionFilePath, versionContents);
  } catch (err) {
    log(`createRamDatabaseVersionFile error: ${err}`, 'ERROR');
  }
};

const getRamDatabaseVersion = () => {
  try {
    const contents = fs.readFileSync(ramDatabaseVersionFilePath, 'utf-8');
    const data = JSON.parse(contents);
    return data.RAM_DB_VERSION;
  } catch (err) {
    log(`getRamDbVersion error: ${err}`, 'DEBUG');
  }
  return false;
};

async function get(url) {
  const options = {
    timeout: 8000,
  };
  try {
    return await axios.get(url, options);
  } catch (err) {
    return null;
  }
}

/**
 * Performs binary search on a sorted array to find the insertion point for a key.
 * @param {Array} sortedArray - The sorted array to search in
 * @param {*} key - The value to search for
 * @returns {Array} [start, end] - The range where the key would be inserted
 */
function binarySearch(sortedArray, key) {
  if (!Array.isArray(sortedArray) || sortedArray.length === 0) {
    return [0, -1];
  }

  let start = 0;
  let end = sortedArray.length - 1;

  while (start <= end) {
    const middle = Math.floor((start + end) / 2);

    if (sortedArray[middle] === key) {
      return [middle, middle]; // Found exact match
    } else if (sortedArray[middle] < key) {
      start = middle + 1;
    } else {
      end = middle - 1;
    }
  }

  return [start, end];
}

/**
 * Rounds a number to the specified number of decimal places.
 * @param {number} number - The number to round
 * @param {number} decimalPlaces - The number of decimal places
 * @returns {number} The rounded number
 */
function round(number, decimalPlaces) {
  if (typeof number !== 'number' || typeof decimalPlaces !== 'number') {
    throw new Error('round: both parameters must be numbers');
  }
  if (decimalPlaces < 0) {
    throw new Error('round: decimalPlaces must be non-negative');
  }

  const factorOfTen = Math.pow(10, decimalPlaces);
  return Math.round(number * factorOfTen) / factorOfTen;
}

function download(url, dest) {
  return new Promise((resolve, reject) => {
    // "wx" will fail if file already exists
    const file = fs.createWriteStream(dest, { flags: "w" });
    const options = {
      headers: {
        "user-agent": userAgent,
        "accept-language": "en-GB,en-US;q=0.9,en;q=0.8,de;q=0.7",
      },
      timeout: 10000,
    };

    const parsedUrl = new URL(url);
    const client = (parsedUrl.protocol == "https:") ? https : http;

    const request = client.get(url, options, response => {
      if (response.statusCode === 200) {
        response.pipe(file);
      } else {
        file.close();
        fs.unlink(dest, () => { }); // Delete temp file
        reject(`Server responded with ${response.statusCode}: ${response.statusMessage}`);
      }
    });

    request.on("error", err => {
      file.close();
      fs.unlink(dest, () => { }); // Delete temp file
      reject(err.message);
    });

    file.on("finish", () => {
      resolve();
    });

    file.on("error", err => {
      file.close();

      if (err.code === "EEXIST") {
        reject("File already exists");
      } else {
        fs.unlink(dest, () => { }); // Delete temp file
        reject(err.message);
      }
    });
  });
}

function downloadCurl(url, dest, config = {}) {
  return new Promise((resolve, reject) => {
    const { noCheckCertificate = false, timeoutSeconds = 15 } = config;

    // Build curl command with configurable options
    let command = `curl -s --connect-timeout ${timeoutSeconds} --max-time ${timeoutSeconds} --location --user-agent "${userAgent}"`;

    // Add --insecure if noCheckCertificate is requested
    if (noCheckCertificate) {
      command += ' --insecure';
    }

    command += ` '${url}' > ${dest} 2>/dev/null`;

    executeCommand(command).then((ok) => resolve(ok)).catch((fail) => reject(fail));
  });
}

function downloadWget(url, dest, logError = false, beSilent = true, config = {}) {
  return new Promise((resolve, reject) => {
    const { noCheckCertificate = false, timeoutSeconds = 15 } = config;

    // Build wget command with configurable options
    let command = `wget --user-agent="${userAgent}" --timeout=${timeoutSeconds} --read-timeout=${timeoutSeconds} --tries=3 --retry-connrefused --waitretry=2`;

    // Add --no-check-certificate if requested
    if (noCheckCertificate) {
      command += ' --no-check-certificate';
    }

    // Add quiet flag if requested
    if (beSilent) {
      command += ' --quiet';
    }

    command += ` -O ${dest} '${url}' && touch ${dest}`;

    executeCommand(command).then((ok) => resolve(ok)).catch((fail) => {
      if (logError) {
        console.error(`Failed to download ${url} to ${dest}: ${fail}`);
      }
      reject(fail);
    });
  });
}

const getSizeInBytes = obj => {
  let str = null;
  if (typeof obj === 'string') {
    // If obj is a string, then use it
    str = obj;
  } else {
    // Else, make obj into a string
    str = JSON.stringify(obj);
  }
  // Get the length of the Uint8Array
  const bytes = new TextEncoder().encode(str).length;
  return bytes;
};

const logSizeInMB = (name, obj) => {
  const bytes = getSizeInBytes(obj);
  const mb = (bytes / 1024 / 1024).toFixed(2);
  log(`Object ${name} is approximately ${mb} MB in size`);
};

function memUsage(print = false) {
  let memUsed = {};
  const used = process.memoryUsage();

  for (let key in used) {
    memUsed[key] = `${round(used[key] / 1024 / 1024, 2)} MB`;
  }

  if (print) {
    log(`Node.js process memory usage: ${JSON.stringify(memUsed, null, 2)}`);
  }

  return memUsed;
}

const unzipAndSplitIfNecessary = (basePath, fileSizeLimitMB = 40, splitSize = 15) => {
  try {
    const files = fs.readdirSync(basePath);

    // first gunzip the files
    for (const file of files) {
      let filePath = path.join(basePath, file);
      const fileStats = fs.statSync(filePath);
      if (fileStats.isFile()) {
        if (file.endsWith('.gz')) {
          log(`Decompressing file ${filePath}`, 'DEBUG');
          execSync(`gunzip ${filePath}`);
        }
      }
    }

    const allFiles = [];
    // then split if necessary
    const updatedFiles = fs.readdirSync(basePath);
    for (const file of updatedFiles) {
      let filePath = path.join(basePath, file);
      const fileStats = fs.statSync(filePath);
      if (fileStats.isFile()) {
        const fileSizeMB = fileStats.size / (1024 * 1024);
        if (fileSizeMB > fileSizeLimitMB) {
          execSync(`split -b ${splitSize}M ${filePath} ${filePath}_chunk_`);
          if (fs.existsSync(filePath)) {
            fs.unlinkSync(filePath);
          }
          const chunkFiles = fs.readdirSync(basePath).filter(chunkFile => chunkFile.startsWith(`${file}_chunk_`));
          log(`File ${file} was larger than ${fileSizeLimitMB}MB and was split into ${chunkFiles.length} chunks`, 'DEBUG');
          chunkFiles.forEach(chunkFile => {
            const chunkFilePath = path.join(basePath, chunkFile);
            allFiles.push(chunkFilePath);
          });
        } else {
          allFiles.push(filePath);
        }
      }
    }

    return allFiles;
  } catch (error) {
    log(`Error processing files: ${error}`, 'ERROR');
    return [];
  }
};

function getFiles(dirPath, excludeFiles = [], prefix = '', suffix = '', fullPath = false, limit = null) {
  let files = [];
  let num = 0;

  if (!fs.existsSync(dirPath)) {
    console.error(`dir ${dirPath} does not exist`);
    return files;
  }

  if (Array.isArray(excludeFiles)) {
    excludeFiles = excludeFiles.concat(['.', '..', '.DS_Store']);
  }
  const dir = fs.opendirSync(dirPath);
  let dirent;
  while ((dirent = dir.readSync()) !== null) {
    num++;
    let push = false;
    if (Array.isArray(excludeFiles) && !excludeFiles.includes(dirent.name)) {
      push = true;
    }
    if (prefix) {
      push = dirent.name.startsWith(prefix);
    }
    if (suffix) {
      push = dirent.name.endsWith(suffix);
    }
    if (push) {
      if (fullPath) {
        files.push(path.join(dirPath, dirent.name));
      } else {
        files.push(dirent.name);
      }
    }
    if (limit) {
      if (num >= limit) {
        break;
      }
    }
  }
  dir.closeSync();

  return files;
}

function absPath(filePath) {
  return path.join(__dirname, filePath);
}

function load(fileName, cfg = {}) {
  let filePath = fileName;

  if (cfg.absPath) {
    filePath = fileName;
  } else {
    if (cfg.ramDB) {
      filePath = path.join(RAM_DB_DIR, fileName);
    } else {
      filePath = path.join(IP_API_DB_DIR, fileName);
    }
  }

  try {
    if (fs.existsSync(filePath)) {
      log(`Loading file ${filePath}`, 'DEBUG');
      if (cfg.stream) {
        return fs.createReadStream(filePath);
      }
      if (cfg.lr) {
        return getLineReader(filePath);
      }
      let data = fs.readFileSync(filePath).toString();
      if (cfg.split) {
        data = data.split('\n').filter((line) => !!line);
      }
      if (cfg.json) {
        try {
          data = JSON.parse(data);
        } catch (error) {
          console.error(`Error parsing JSON file ${filePath}: ${error.message}`);
          return [];
        }
      }
      return data;
    } else {
      log(`File ${filePath} does not exist`, 'ERROR');
      if (cfg.json || cfg.split) {
        return [];
      }
    }
  } catch (error) {
    console.error(`Error loading file ${filePath}: ${error.message}`);
    throw error;
  }
}

/**
 * Creates a promise that resolves after the specified number of milliseconds.
 * @param {number} ms - Number of milliseconds to sleep
 * @returns {Promise<void>} Promise that resolves after the delay
 */
function sleep(ms) {
  if (typeof ms !== 'number' || ms < 0) {
    throw new Error('sleep: ms must be a non-negative number');
  }

  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

/**
 * Loads and processes a CSV file row by row.
 * @param {string} fileName - Path to the CSV file
 * @param {Function} handleRow - Function to call for each row
 * @param {boolean} headers - Whether the CSV has headers
 * @param {string} delimiter - CSV delimiter character
 * @param {boolean} verbose - Whether to log progress
 * @param {number|null} stopAfter - Stop after processing this many rows
 * @returns {Promise<string>} Promise that resolves with a status message
 */
function loadCsv(fileName, handleRow, headers = false, delimiter = undefined, verbose = false, stopAfter = null) {
  if (typeof fileName !== 'string' || typeof handleRow !== 'function') {
    throw new Error('loadCsv: fileName must be a string and handleRow must be a function');
  }

  return new Promise((resolve, reject) => {
    const t0 = performance.now();
    const readStream = fs.createReadStream(fileName);
    const params = { headers: headers };
    if (delimiter) {
      params.delimiter = delimiter;
    }
    const csvStream = csv.parse(params);
    readStream.pipe(csvStream);

    let rowCount = 0;

    csvStream
      .on('error', (error) => {
        reject(error);
      })
      .on('data', (row) => {
        handleRow(row);
        rowCount++;
        if (stopAfter !== null && rowCount >= stopAfter) {
          readStream.destroy();
          csvStream.end();
        }
      })
      .on('end', () => {
        const elapsedSeconds = round((performance.now() - t0) / 1000, 2);
        const msg = `Loaded ${rowCount} rows in ${elapsedSeconds}s from ${fileName}`;
        if (verbose) {
          log(msg, 'INFO');
        }
        resolve(msg);
      });
  });
}

/**
 * Loads and processes a text file line by line, skipping comments and empty lines.
 * @param {string} filePath - Path to the text file
 * @param {Function} handleLine - Function to call for each non-comment line
 * @returns {Promise<string>} Promise that resolves with a status message
 */
function loadText(filePath, handleLine) {
  if (typeof filePath !== 'string' || typeof handleLine !== 'function') {
    throw new Error('loadText: filePath must be a string and handleLine must be a function');
  }

  return new Promise((resolve) => {
    const t0 = performance.now();
    const lineReader = getLineReader(filePath);
    let lineCount = 0;

    lineReader.on('line', (line) => {
      if (!line.startsWith('#') && line.trim()) {
        handleLine(line.trim());
        lineCount++;
      }
    });

    lineReader.on('end', () => {
      const elapsedSeconds = round((performance.now() - t0) / 1000, 2);
      const msg = `Loaded ${lineCount} rows in ${elapsedSeconds}s from ${filePath}`;
      log(msg, 'DEBUG');
      resolve(msg);
    });
  });
}

/**
 * Creates a line-by-line reader for a file.
 * @param {string} filePath - Path to the file to read
 * @returns {LineByLineReader} The line reader instance
 */
function getLineReader(filePath) {
  if (typeof filePath !== 'string') {
    throw new Error('getLineReader: filePath must be a string');
  }

  const lr = new LineByLineReader(filePath);
  lr.on('error', function (err) {
    log(`Error on reading ${filePath} with LineByLineReader: ${err.toString()}`, 'ERROR');
  });
  return lr;
}

/**
 * Checks if a value is a positive integer.
 * @param {*} n - The value to check
 * @returns {boolean} True if the value is a positive integer, false otherwise
 */
function isPositiveInteger(n) {
  return Number.isInteger(n) && n > 0;
}

/**
 * Checks if a value is an array.
 * @param {*} a - The value to check
 * @returns {boolean} True if the value is an array, false otherwise
 */
function isArray(a) {
  return Array.isArray(a);
}

/**
 * Checks if a value is a plain object (not null, not array, not primitive).
 * @param {*} a - The value to check
 * @returns {boolean} True if the value is a plain object, false otherwise
 */
function isObject(a) {
  return a !== null && typeof a === 'object' && !Array.isArray(a);
}

/**
 * Generates a random integer between min and max (inclusive).
 * @param {number} min - The minimum value (inclusive)
 * @param {number} max - The maximum value (inclusive)
 * @returns {number} A random integer between min and max
 */
function getRandomInt(min, max) {
  if (typeof min !== 'number' || typeof max !== 'number') {
    throw new Error('getRandomInt: min and max must be numbers');
  }
  if (min > max) {
    throw new Error('getRandomInt: min must be less than or equal to max');
  }

  const minInt = Math.ceil(min);
  const maxInt = Math.floor(max);
  return Math.floor(Math.random() * (maxInt - minInt + 1)) + minInt;
}

/**
 * Calculates the time difference from a start time.
 * @param {number} t0 - Start time from performance.now()
 * @returns {number} Time difference in milliseconds, rounded to 2 decimal places
 */
function delta(t0) {
  if (typeof t0 !== 'number') {
    throw new Error('delta: t0 must be a number');
  }
  return round(performance.now() - t0, 2);
}

/**
 * Sorts an object by its values in descending order.
 * @param {Object} obj - The object to sort
 * @param {number|null} limit - Maximum number of entries to return
 * @param {boolean} list - Whether to return as array of [key, value] pairs
 * @returns {Object|Array} Sorted object or array of entries
 */
function sortObjectByValue(obj, limit = null, list = false) {
  if (!obj || typeof obj !== 'object') {
    return obj;
  }

  const entries = Object.entries(obj);
  const sorted = entries.sort((a, b) => b[1] - a[1]);

  const limited = limit !== null ? sorted.slice(0, limit) : sorted;

  if (list) {
    return limited;
  }

  const newObj = {};
  for (const [key, value] of limited) {
    newObj[key] = value;
  }
  return newObj;
}

/**
 * Sorts an object by the length of its array values in descending order.
 * @param {Object} obj - The object to sort (values should be arrays)
 * @returns {Object} Sorted object
 */
function sortObjectByArrayLength(obj) {
  if (!obj || typeof obj !== 'object') {
    return obj;
  }

  const entries = Object.entries(obj);
  const sorted = entries.sort((a, b) => b[1].length - a[1].length);

  const newObj = {};
  for (const [key, value] of sorted) {
    newObj[key] = value;
  }
  return newObj;
}

/**
 * Compares two dates in [year, month, day] format to determine if the first is newer.
 * @param {Array<number>} a - First date as [year, month, day]
 * @param {Array<number>} b - Second date as [year, month, day]
 * @returns {boolean} True if date a is newer than date b
 */
function isNewerDate(a, b) {
  if (!Array.isArray(a) || !Array.isArray(b)) {
    throw new Error('isNewerDate: both parameters must be arrays');
  }
  if (a.length !== 3 || b.length !== 3) {
    throw new Error('isNewerDate: both arrays must have exactly 3 elements [year, month, day]');
  }

  const dateA = a.map((e) => parseInt(e, 10));
  const dateB = b.map((e) => parseInt(e, 10));

  // Compare year
  if (dateA[0] > dateB[0]) {
    return true;
  } else if (dateA[0] < dateB[0]) {
    return false;
  }

  // Compare month
  if (dateA[1] > dateB[1]) {
    return true;
  } else if (dateA[1] < dateB[1]) {
    return false;
  }

  // Compare day
  return dateA[2] > dateB[2];
}

/**
 * Gets the modification date of a file as [year, month, day].
 * @param {string} filePath - Path to the file
 * @returns {Array<number>|false} File age as [year, month, day] or false if file doesn't exist
 */
function getFileAge(filePath) {
  if (typeof filePath !== 'string') {
    throw new Error('getFileAge: filePath must be a string');
  }

  if (fs.existsSync(filePath)) {
    const stats = fs.statSync(filePath);
    const mstr = stats.mtime.toISOString();
    const parts = mstr.split('T')[0].split('-');
    return [
      parseInt(parts[0], 10),
      parseInt(parts[1], 10),
      parseInt(parts[2], 10),
    ];
  }
  return false;
}

const getFileAgeInMinutesSync = (filePath) => {
  try {
    if (fs.existsSync(filePath)) {
      const { mtime } = fs.statSync(filePath);
      const currentTime = new Date();
      const fileAgeInMilliseconds = currentTime - mtime;
      const fileAgeInMinutes = fileAgeInMilliseconds / (1000 * 60); // Convert milliseconds to minutes
      return round(fileAgeInMinutes, 2);
    } else {
      console.error(`file ${filePath} does not exist`);
    }
  } catch (error) {
    throw new Error(`Error getting file age for ${filePath}: ${error.message}`);
  }
};

const getFileAgeInDaysSync = (filePath) => {
  const ageMinutes = getFileAgeInMinutesSync(filePath);
  if (ageMinutes) {
    return round(ageMinutes / 60 / 24, 3);
  }
  return null;
};

const getFileAgeAsTimestamp = (filePath) => {
  try {
    if (fs.existsSync(filePath)) {
      const { mtime } = fs.statSync(filePath);
      return Math.floor(mtime.getTime());
    } else {
      console.error(`File ${filePath} does not exist`);
      return null;
    }
  } catch (error) {
    console.error(`Error getting file age for ${filePath}: ${error.message}`);
    return null;
  }
};

const fileNotExistsOrOlderThanDays = (filePath, days = 5, hours = null) => {
  const ageMinutes = getFileAgeInMinutesSync(filePath);

  if (ageMinutes) {
    if (hours !== null) {
      const ageInHours = ageMinutes / 60;
      return ageInHours >= hours;
    } else {
      const ageInDays = ageMinutes / 60 / 24;
      return ageInDays >= days;
    }
  }

  return true;
};

const fileIsAtLeastNDaysOldOrCrash = (filePath, n = 7) => {
  const days = round(getFileAgeInDaysSync(filePath), 2);
  if (days > n) {
    throw new Error(`[File is old!] File is ${days} days old. Limit is ${n} days. File = ${filePath}`);
  }
};

function deg2rad(deg) {
  return deg * (Math.PI / 180)
}

/**
 * console.log(getDistanceFromLatLonInKm(59.3293371,13.4877472,59.3225525,13.4619422).toFixed(1));
 * 
 * @param {*} lat1 
 * @param {*} lon1 
 * @param {*} lat2 
 * @param {*} lon2 
 * @returns 
 */
function getDistanceFromLatLonInKm(lat1, lon1, lat2, lon2) {
  lat1 = parseFloat(lat1);
  lon1 = parseFloat(lon1);
  lat2 = parseFloat(lat2);
  lon2 = parseFloat(lon2);

  var R = 6371; // Radius of the earth in km
  var dLat = deg2rad(lat2 - lat1);  // deg2rad below
  var dLon = deg2rad(lon2 - lon1);
  var a =
    Math.sin(dLat / 2) * Math.sin(dLat / 2) +
    Math.cos(deg2rad(lat1)) * Math.cos(deg2rad(lat2)) *
    Math.sin(dLon / 2) * Math.sin(dLon / 2)
    ;
  var c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  var d = R * c; // Distance in km
  return d;
}

/**
 * Compares two arrays for equality (order-independent).
 * @param {Array} arr1 - First array
 * @param {Array} arr2 - Second array
 * @returns {boolean} True if arrays contain the same elements
 */
const arrayEquals = (arr1, arr2) => {
  if (!Array.isArray(arr1) || !Array.isArray(arr2)) {
    return false;
  }

  if (arr1.length !== arr2.length) {
    return false;
  }

  // Create copies to avoid mutating original arrays
  const sorted1 = [...arr1].sort();
  const sorted2 = [...arr2].sort();

  return sorted1.every((val, i) => val === sorted2[i]);
};

/**
 * Compares two objects for equality by comparing keys and values.
 * @param {Object} obj1 - First object
 * @param {Object} obj2 - Second object
 * @returns {boolean} True if objects have the same keys and values
 */
const objectEquals = (obj1, obj2) => {
  if (obj1 === obj2) {
    return true;
  }

  if (!obj1 || !obj2 || typeof obj1 !== 'object' || typeof obj2 !== 'object') {
    return false;
  }

  const keys1 = Object.keys(obj1);
  const keys2 = Object.keys(obj2);

  if (keys1.length !== keys2.length) {
    return false;
  }

  // Check if all keys exist in both objects and values are equal
  for (const key of keys1) {
    if (!keys2.includes(key) || obj1[key] !== obj2[key]) {
      return false;
    }
  }

  return true;
};

/**
 * Finds the key with the highest value in an object.
 * @param {Object} obj - The object to search
 * @returns {string|null} The key with the highest value, or null if object is empty
 */
function findKeyWithHighestValue(obj) {
  if (!obj || typeof obj !== 'object') {
    return null;
  }

  let highestValue = Number.NEGATIVE_INFINITY;
  let highestValueKey = null;

  for (const [key, value] of Object.entries(obj)) {
    if (typeof value === 'number' && value > highestValue) {
      highestValue = value;
      highestValueKey = key;
    }
  }

  return highestValueKey;
}

/**
 * Sorts an object by its numeric values in descending order.
 * @param {Object} obj - The object to sort
 * @param {boolean} list - Whether to return as array of [key, value] pairs
 * @returns {Object|Array} Sorted object or array of entries
 */
function sortByValue(obj, list = false) {
  if (!obj || typeof obj !== 'object') {
    return list ? [] : {};
  }

  const items = Object.entries(obj)
    .filter(([, value]) => typeof value === 'number')
    .sort(([, a], [, b]) => b - a);

  if (list) {
    return items;
  }

  const result = {};
  for (const [key, value] of items) {
    result[key] = value;
  }
  return result;
}

/**
 * Writes data to a CSV file.
 * @param {string} fname - Filename to write to
 * @param {Array} data - Array of data objects to write
 * @param {Array} headers - Array of header names
 * @returns {Promise<boolean>} Promise that resolves to true when complete
 */
const writeCsv = (fname, data, headers) => {
  if (typeof fname !== 'string' || !Array.isArray(data) || !Array.isArray(headers)) {
    return Promise.reject(new Error('writeCsv: fname must be string, data and headers must be arrays'));
  }

  return new Promise((resolve, reject) => {
    const writeStream = fs.createWriteStream(fname);
    const csvStream = csv.format({ headers: headers, writeHeaders: true });

    csvStream.pipe(writeStream);

    csvStream.on('end', () => {
      log(`Wrote ${data.length} records to file ${fname}`, 'INFO');
      resolve(true);
    });

    csvStream.on('error', (error) => {
      reject(error);
    });

    for (const row of data) {
      csvStream.write(row);
    }

    csvStream.end();
  });
};

/**
 * Adds an entry to a lookup table (LUT), initializing if needed.
 * @param {Object} lut - The lookup table object
 * @param {string} key - The key to add to
 * @param {*} entry - The entry to add (if null, increments counter)
 */
const addToLut = (lut, key, entry = null) => {
  if (!lut || typeof lut !== 'object') {
    throw new Error('addToLut: lut must be an object');
  }
  if (typeof key !== 'string') {
    throw new Error('addToLut: key must be a string');
  }

  if (!lut[key]) {
    if (entry !== null) {
      lut[key] = [];
    } else {
      lut[key] = 0;
    }
  }

  if (entry !== null) {
    lut[key].push(entry);
  } else {
    lut[key]++;
  }
};

const isFileNewerThanNMinutes = (filePath, N = 3) => {
  // Check if the file exists
  if (!fs.existsSync(filePath)) {
    return false;
  }

  // Get the file's stats
  const stats = fs.statSync(filePath);

  // Calculate the current time
  const currentTime = new Date();

  // Calculate the time 3 minutes ago
  const threeMinutesAgo = new Date(currentTime - N * 60 * 1000); // 3 minutes in milliseconds

  // Compare the file's modification time with three minutes ago
  return stats.mtime > threeMinutesAgo;
};

const createDirectoryIfNotExists = (directoryPath, verbose = false) => {
  if (!fs.existsSync(directoryPath)) {
    fs.mkdirSync(directoryPath, { recursive: true });
    if (verbose) {
      console.log(`Directory "${directoryPath}" created.`);
    }
  }
};

const clearDirectory = (directoryPath) => {
  let deleteStats = {
    files: 0,
    dirs: 0,
  };
  // Ensure the directory exists
  if (fs.existsSync(directoryPath)) {
    // Get a list of all files and subdirectories within the directory
    const items = fs.readdirSync(directoryPath);

    for (const item of items) {
      const itemPath = path.join(directoryPath, item);

      // Check if it's a file or a directory
      const isFile = fs.statSync(itemPath).isFile();

      // Delete files or recursively clear subdirectories
      if (isFile) {
        fs.unlinkSync(itemPath);
        deleteStats.files++;
      } else {
        clearDirectory(itemPath); // Recursively clear subdirectory
        fs.rmdirSync(itemPath); // Remove the empty subdirectory
        deleteStats.dirs++;
      }
    }
  }
  console.log('deleteStats', deleteStats);
};

const decompressGzipFileAsync = async (inputFilePath, outputFilePath) => {
  return new Promise((resolve, reject) => {
    const gunzip = zlib.createGunzip();
    const inputStream = fs.createReadStream(inputFilePath);
    const outputStream = fs.createWriteStream(outputFilePath);

    inputStream.pipe(gunzip).pipe(outputStream);

    outputStream.on('finish', () => {
      resolve(true);
    });

    outputStream.on('error', (err) => {
      log(`Error while decompressing "${inputFilePath}": ${err}`, 'ERROR');
      reject(false);
    });
  });
};

const extractTarGz = async (sourceFilePath, destinationDirectory) => {
  try {
    const sourceStream = fs.createReadStream(sourceFilePath);
    const gunzip = zlib.createGunzip();
    sourceStream.pipe(gunzip);

    await tar.extract({
      file: destinationDirectory,
      cwd: destinationDirectory,
    });

    console.log(`Successfully extracted ${sourceFilePath} to ${destinationDirectory}`);
    return true;
  } catch (error) {
    log(`Error extracting ${sourceFilePath}: ${error}`, 'ERROR');
    return false;
  }
};

/**
 * Determines download path and uncompressed filename from destination info.
 * @param {string} dstDir - Destination directory
 * @param {string|Array} dstInfo - Destination info (filename or [compressed, uncompressed])
 * @returns {Object} Object with downloadPath and uncompressedFileName
 */
const parseDestinationInfo = (dstDir, dstInfo) => {
  if (Array.isArray(dstInfo)) {
    return {
      downloadPath: path.join(dstDir, dstInfo[0]),
      uncompressedFileName: dstInfo[1]
    };
  } else if (typeof dstInfo === 'string') {
    return {
      downloadPath: path.join(dstDir, dstInfo),
      uncompressedFileName: null
    };
  } else {
    throw new Error('dstInfo must be a string or array');
  }
};

/**
 * Checks if a file needs to be downloaded based on its age.
 * @param {string} downloadPath - Path to the file
 * @param {number} isFreshMaxMinutes - Maximum age in minutes to consider fresh
 * @returns {boolean} True if download is needed
 */
const shouldDownloadFile = (downloadPath, isFreshMaxMinutes) => {
  if (!fs.existsSync(downloadPath)) {
    return true;
  }

  const fileAge = getFileAgeInMinutesSync(downloadPath);
  if (fileAge <= isFreshMaxMinutes) {
    log(`[ok] File "${path.basename(downloadPath)}" is fresh. (${fileAge}min < ${isFreshMaxMinutes}min)`);
    return false;
  }
  return true;
};

/**
 * Downloads a file using the specified client with fallback support.
 * @param {string} url - URL to download from
 * @param {string} downloadPath - Local path to save the file
 * @param {string} downloadClient - Download client to use ('wget', 'curl', or 'http')
 * @param {Object} config - Configuration options for download
 * @param {boolean} config.noCheckCertificate - Whether to skip SSL certificate verification
 * @param {number} config.timeoutSeconds - Timeout in seconds for download
 * @returns {boolean} True if download was successful
 */
const performDownload = async (url, downloadPath, downloadClient, config = {}) => {
  let downloadSuccess = false;

  // Try the primary download method
  try {
    if (downloadClient === 'curl') {
      await downloadCurl(url, downloadPath, config);
      downloadSuccess = true;
    } else if (downloadClient === 'wget') {
      await downloadWget(url, downloadPath, true, false, config);
      downloadSuccess = true;
    } else {
      await download(url, downloadPath);
      downloadSuccess = true;
    }
  } catch (downloadError) {
    log(`[-] Primary download method (${downloadClient}) failed for ${url}: ${downloadError.message || downloadError}`);

    // Try fallback method if wget failed
    if (downloadClient === 'wget') {
      try {
        log(`[i] Trying curl as fallback for ${url}`);
        await downloadCurl(url, downloadPath, config);
        downloadSuccess = true;
        log(`[ok] Fallback download successful using curl`);
      } catch (fallbackError) {
        log(`[-] Fallback download (curl) also failed for ${url}: ${fallbackError.message || fallbackError}`);
      }
    }
  }

  if (!downloadSuccess) {
    log(`[-] All download methods failed for ${url}`);
    return false;
  }

  if (!isFileNewerThanNMinutes(downloadPath, 10)) {
    log(`[-] Failed to download file: ${downloadPath} (file not newer than 10 minutes)`);
    return false;
  }

  log(`[ok] Downloaded ${path.basename(downloadPath)} using ${downloadClient}`);
  return true;
};

/**
 * Gets the appropriate decompression function and output path for a file.
 * @param {string} downloadPath - Path to the downloaded file
 * @returns {Object|null} Object with decompressFunction and clearPath, or null if no decompression needed
 */
const getDecompressionInfo = (downloadPath) => {
  if (downloadPath.endsWith('.tar.gz')) {
    return {
      decompressFunction: (tarGzPath, outPath) => {
        executeCommandSync(`cd ${path.dirname(tarGzPath)} && /usr/bin/tar -zxvf ${tarGzPath}`);
        return true;
      },
      clearPath: downloadPath.replace('.tar.gz', ''),
      type: 'tar.gz'
    };
  } else if (downloadPath.endsWith('.gz')) {
    return {
      decompressFunction: decompressGzipFileAsync,
      clearPath: downloadPath.replace('.gz', ''),
      type: 'gz'
    };
  } else if (downloadPath.endsWith('.zip')) {
    return {
      decompressFunction: (zipPath, outPath) => {
        executeCommandSync(`/usr/bin/unzip -o ${zipPath} -d ${path.dirname(zipPath)}`);
        return true;
      },
      clearPath: downloadPath.replace('.zip', ''),
      type: 'zip'
    };
  }
  return null;
};

/**
 * Downloads a file and optionally decompresses it.
 * @param {string} url - URL to download from
 * @param {string} dstDir - Destination directory
 * @param {string|Array} dstInfo - Destination info (filename or [compressed, uncompressed])
 * @param {boolean} decompress - Whether to decompress the file
 * @param {string} downloadClient - Download client to use
 * @param {number} isFreshMaxMinutes - Maximum age in minutes to consider fresh
 * @param {Object} config - Configuration options for download
 * @param {boolean} config.noCheckCertificate - Whether to skip SSL certificate verification
 * @param {number} config.timeoutSeconds - Timeout in seconds for download
 * @returns {boolean} True if successful
 */
const downloadFileAndCheck = async (url, dstDir, dstInfo, decompress = true, downloadClient = 'wget', isFreshMaxMinutes = 120, config = {}) => {
  try {
    const { downloadPath, uncompressedFileName } = parseDestinationInfo(dstDir, dstInfo);

    // Check if download is needed
    if (shouldDownloadFile(downloadPath, isFreshMaxMinutes)) {
      const downloadSuccess = await performDownload(url, downloadPath, downloadClient, config);
      if (!downloadSuccess) {
        return false;
      }
    }

    // Handle decompression if needed
    if (decompress) {
      const decompressInfo = getDecompressionInfo(downloadPath);
      if (decompressInfo) {
        log(`[ok] Unpacking .${decompressInfo.type}`);

        const outputFile = uncompressedFileName
          ? path.join(dstDir, uncompressedFileName)
          : decompressInfo.clearPath;

        const decompressSuccessful = await decompressInfo.decompressFunction(downloadPath, outputFile);
        if (!decompressSuccessful || !fs.existsSync(outputFile)) {
          log(`[-] Failed to decompress file: ${path.basename(outputFile)}`);
          return false;
        }
        log(`[ok] Decompressed file to ${path.basename(outputFile)}`);
      }
    }

    return true;
  } catch (error) {
    log(`Error in downloadFileAndCheck: ${error.message}`, 'ERROR');
    return false;
  }
};

const downloadFileAndCheckPost = async (url, dstDir, dstInfo, method = 'post', headers = {}, decompress = true, isFreshMaxMinutes = 120, config = {}) => {
  let downloadPath = null;
  let uncompressedFileName = null;

  if (Array.isArray(dstInfo)) {
    downloadPath = path.join(dstDir, dstInfo[0]);
    uncompressedFileName = dstInfo[1];
  } else if (typeof dstInfo === 'string') {
    downloadPath = path.join(dstDir, dstInfo);
  } else {
    return false;
  }

  let doDownload = true;
  if (fs.existsSync(downloadPath)) {
    const fileAge = getFileAgeInMinutesSync(downloadPath);
    if (fileAge <= isFreshMaxMinutes) {
      log(`[ok] File "${path.basename(downloadPath)}" is fresh. (${fileAge}min < ${isFreshMaxMinutes}min)`);
      doDownload = false;
    }
  }

  if (doDownload) {
    const { noCheckCertificate = false, timeoutSeconds = 15 } = config;

    // Build headers string for curl command
    let headerArgs = '';
    for (const [key, value] of Object.entries(headers)) {
      headerArgs += ` -H "${key}: ${value}"`;
    }

    // Construct curl command with POST method and configurable options
    let curlCommand = `/usr/bin/curl -s --connect-timeout ${timeoutSeconds} --max-time ${timeoutSeconds} -X ${method.toUpperCase()}${headerArgs}`;

    // Add --insecure if noCheckCertificate is requested
    if (noCheckCertificate) {
      curlCommand += ' --insecure';
    }

    curlCommand += ` "${url}" -o "${downloadPath}"`;
    log(`[i] Executing: ${curlCommand}`);

    await executeCommandSync(curlCommand);

    if (!isFileNewerThanNMinutes(downloadPath, 10)) {
      log(`[-] Failed to download file: ${downloadPath}`);
      return false;
    }

    log(`[ok] Downloaded ${path.basename(downloadPath)} using curl`);
  }

  let decompressFunction = null;
  let clearPath = null;

  if (decompress) {
    if (downloadPath.endsWith('.tar.gz')) {
      decompressFunction = (tarGzPath, outPath) => {
        executeCommandSync(`cd ${path.dirname(tarGzPath)} && /usr/bin/tar -zxvf ${tarGzPath}`);
        return true;
      };
      clearPath = downloadPath.replace('.tar.gz', '');
      log(`[ok] Unpacking .tar.gz`);
    } else if (downloadPath.endsWith('.gz')) {
      decompressFunction = decompressGzipFileAsync;
      clearPath = downloadPath.replace('.gz', '');
      log(`[ok] Unpacking .gz`);
    } else if (downloadPath.endsWith('.zip')) {
      decompressFunction = (zipPath, outPath) => {
        executeCommandSync(`/usr/bin/unzip -o ${zipPath} -d ${path.dirname(zipPath)}`);
        return true;
      };
      clearPath = downloadPath.replace('.zip', '');
      log(`[ok] Unpacking .zip`);
    }
  }

  let outputFile = null;
  if (decompressFunction) {
    if (uncompressedFileName) {
      outputFile = path.join(dstDir, uncompressedFileName);
    } else {
      outputFile = clearPath;
    }
    let decompressSuccessful = await decompressFunction(downloadPath, outputFile);
    if (!decompressSuccessful) {
      log(`[-] Failed to decompress file: ${path.basename(outputFile)}`);
      return false;
    } else {
      if (!fs.existsSync(outputFile)) {
        log(`[-] Failed to decompress file: ${path.basename(outputFile)}`);
        return false;
      } else {
        log(`[ok] Decompressed file to ${path.basename(outputFile)}`);
      }
    }
  }

  return true;
};

const downloadFilesAndCheck = async (urls, destDir) => {
  log(`[i] Downloading files to dir ${destDir}`);

  for (const url of urls) {
    const fileName = url.split('/').slice(-1)[0];
    const dRes = await downloadFileAndCheck(url, destDir, fileName, true, 'wget', 120);
    if (!dRes) return false;
  }

  return true;
};

const getHostFromUrl = (url) => {
  try {
    let urlParsed = new URL(url);
    return urlParsed.host;
  } catch (err) {

  }
};

function setDist(inst, hist, val = 1) {
  if (!hist[inst]) {
    hist[inst] = 0;
  }
  hist[inst] += val;
}

function displayHistogram(data, label = null) {
  if (label) {
    console.log(`\nHISTOGRAM: ${label}\n`);
  } else {
    console.log(`\nHISTOGRAM:\n`);
  }

  // Calculate total sum
  const total = Object.values(data).reduce((acc, value) => acc + value, 0);

  // Sort entries by value in descending order
  const sortedEntries = Object.entries(data).sort(([, a], [, b]) => b - a);

  // Display sorted data with counts and percentages
  for (const [key, value] of sortedEntries) {
    const percentage = ((value / total) * 100).toFixed(2);
    console.log(`${key.padEnd(20, ' ')}: ${value.toString().padStart(10, ' ')} (${percentage}%)`);
  }
}

const fileExistsAndRecent = (checkFile, maxAgeMinutes = 5, checkHasLines = null) => {
  if (!fs.existsSync(checkFile)) {
    return false;
  }

  const fileAgeMin = getFileAgeInMinutesSync(checkFile);
  let hasSufficientLines = true;

  if (checkHasLines !== null) {
    const lineCount = parseInt(execSync(`wc -l < "${checkFile}"`).toString().trim(), 10);
    log(`lineCount of file ${checkFile}: ${lineCount}`, 'DEBUG');
    hasSufficientLines = lineCount >= checkHasLines;
  }

  return (fileAgeMin <= maxAgeMinutes) && hasSufficientLines;
};

const fileExistsAndOlderThan = (checkFile, isOlderThanMinutes = 10) => {
  if (fs.existsSync(checkFile)) {
    const fileAgeMin = getFileAgeInMinutesSync(checkFile);
    return (fileAgeMin >= isOlderThanMinutes);
  }
  return false;
};

const fileExistsAndLargerThan = (filePath, sizeInMB) => {
  if (!fs.existsSync(filePath)) {
    return false;
  }

  const stats = fs.statSync(filePath);
  const fileSizeInBytes = stats.size;
  const fileSizeInMB = fileSizeInBytes / (1024 * 1024);

  return fileSizeInMB > sizeInMB;
};

const remoteUrlExistsAndRecent = async (urlFilePath, maxAgeMinutes = 30) => {
  return new Promise((resolve, reject) => {
    const command = `curl -s -I '${urlFilePath}'`;
    executeCommand(command)
      .then((output) => {
        output = output.toLowerCase().trim();
        for (const line of output.split('\n')) {
          if (line.startsWith('last-modified:')) {
            const urlFileAge = new Date(line.split('last-modified:')[1].trim());
            const deltaMinutes = ((new Date()) - urlFileAge) / (1000 * 60);
            const isRecent = deltaMinutes < maxAgeMinutes;
            return resolve(isRecent);
          }
        }
        return resolve(null);
      })
      .catch((fail) => reject(fail));
  });
};

/**
 * On ubuntu: /usr/bin/stat --format %Y /etc/passwd
 * On MacOS: stat -f %m /etc/passwd
 * 
 * @param {*} server 
 * @param {*} absolutePath 
 * @param {*} maxAgeMinutes 
 * @returns 
 */
const remoteFileExistsAndRecent = async (server, absolutePath, maxAgeMinutes = 30) => {
  return new Promise((resolve, reject) => {
    const command = `ssh -i ${server.key} ${server.user}@${server.host} '/usr/bin/stat --format %Y ${absolutePath}'`;
    executeCommand(command)
      .then((output) => {
        output = output.toLowerCase().trim();
        if (output) {
          const now = Math.floor(Date.now() / 1000);
          const fileAge = parseInt(output);
          const deltaMinutes = (now - fileAge) / 60;
          const isRecent = deltaMinutes < maxAgeMinutes;
          return resolve(isRecent);
        }
        return resolve(null);
      })
      .catch((fail) => reject(fail));
  });
};

const remoteFileExistsAndLargerThan = async (server, absolutePath, sizeInMB) => {
  return new Promise((resolve, reject) => {
    const command = `ssh -i ${server.key} ${server.user}@${server.host} '/usr/bin/stat --format %s ${absolutePath}'`;

    executeCommand(command)
      .then((output) => {
        output = output.trim();
        if (output) {
          const fileSizeInBytes = parseInt(output, 10);
          const fileSizeInMB = fileSizeInBytes / (1024 * 1024);
          const isLargerThan = fileSizeInMB > sizeInMB;
          return resolve(isLargerThan);
        }
        return resolve(false); // File does not exist
      })
      .catch((fail) => reject(fail));
  });
};

const calculateLocalMD5 = (filePath) => {
  return new Promise((resolve, reject) => {
    const command = `md5 -q ${path.resolve(filePath)}`;
    executeCommand(command)
      .then((output) => resolve(output.trim()))
      .catch((error) => reject(`Failed to calculate local MD5: ${error}`));
  });
};

const calculateRemoteMD5 = async (server, remoteFilePath) => {
  const command = `ssh -i ${server.key} ${server.user}@${server.host} 'md5sum ${remoteFilePath} | awk "{print \\$1}"'`;
  let attempts = 0;
  const maxAttempts = 7;

  while (attempts < maxAttempts) {
    try {
      const output = await executeCommand(command);
      return output.trim();
    } catch (error) {
      attempts++;
      if (attempts >= maxAttempts) {
        throw new Error(`Failed to calculate remote MD5 after ${maxAttempts} attempts: ${error}`);
      }
    }
  }
};

const compareMD5Checksums = async (server, localFilePath, remoteFilePath, verbose = true) => {
  try {
    const localMD5 = await calculateLocalMD5(localFilePath);
    const remoteMD5 = await calculateRemoteMD5(server, remoteFilePath);
    if (verbose) {
      console.log(`Local File: ${localFilePath} - MD5: ${localMD5}`);
      console.log(`Remote File: ${remoteFilePath} - MD5: ${remoteMD5}`);
    }
    return localMD5 === remoteMD5;
  } catch (error) {
    throw new Error(`Failed to compare MD5 checksums: ${error}`);
  }
};

const getAllFiles = (dirPath) => {
  let files = [];
  const excludeFiles = ['.', '..', '.DS_Store'];
  let dirs = [dirPath,];

  while (dirs.length > 0) {
    const nextDir = dirs.shift();
    const dir = fs.opendirSync(nextDir);
    let dirent;
    while ((dirent = dir.readSync()) !== null) {
      let push = false;
      if (!excludeFiles.includes(dirent.name)) {
        push = true;
      }
      if (push) {
        if (dirent.isDirectory()) {
          dirs.push(path.join(nextDir, dirent.name));
        } else {
          files.push(path.join(nextDir, dirent.name));
        }
      }
    }
    dir.closeSync();
  }

  return files;
};

const timeToUpdateSource = (target, forceUpdate = false, maxAgeHours = 24) => {
  if (fs.existsSync(target)) {
    const now = (new Date()).getTime();
    let statsObj = fs.statSync(target);
    let diff = round((now - statsObj.birthtimeMs) / 1000 / 60 / 60, 2);
    if (diff > maxAgeHours || forceUpdate) {
      return true;
    } else {
      log(`Not downloading recently downloaded source. Source = ${target}, age diff = ${diff}`);
      return false;
    }
  }
  return true;
};

function shuffleArray(array) {
  for (let i = array.length - 1; i > 0; i--) {
    // Generate a random index
    const j = Math.floor(Math.random() * (i + 1));
    // Swap elements at indices i and j
    [array[i], array[j]] = [array[j], array[i]];
  }
  return array;
}

function getRandomElements(arr, n) {
  // Make a copy of the original array to avoid modifying the original
  const shuffledArray = arr.slice();

  // Fisher-Yates shuffle algorithm
  for (let i = shuffledArray.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [shuffledArray[i], shuffledArray[j]] = [shuffledArray[j], shuffledArray[i]];
  }

  // Return the first N elements from the shuffled array
  return shuffledArray.slice(0, n);
}

const removeWhitespaceAndControlChars = (inputText) => {
  // Use a regular expression to match all whitespace and control characters
  const regex = /[\s\p{C}]/gu;

  // Replace matched characters with an empty string
  const result = inputText.replace(regex, '');

  return result;
};

const domainFromUrl = (url) => {
  let host = null;
  try {
    host = new URL(url).hostname;
  } catch { }
  return host;
};

function getCallStack() {
  // Create a new Error object
  const error = new Error();
  // The stack property contains the call stack
  const stack = error.stack;
  // Process the stack string as needed
  return stack;
}

function isInteger(str) {
  const num = Number(str);
  return Number.isInteger(num) && String(num) === str;
}

const rsync = (server, fileToUpload, remoteDirectory, checkUrl = null, verbose = false) => {
  return new Promise(async (resolve, reject) => {
    if (!fs.existsSync(fileToUpload)) {
      return reject(`[-] fileToUpload does not exist: ${fileToUpload}`);
    }

    const fileName = path.basename(fileToUpload);
    const uploadArgs = [
      '-avz',
      '--timeout=1000',
      '--progress',
      '--partial',
      '-e',
      `ssh -o ServerAliveInterval=30 -o ServerAliveCountMax=10 -i ${server.key}`,
      fileToUpload,
      `${server.user}@${server.host}:${remoteDirectory}`
    ];

    if (verbose) {
      console.log(`rsync ${uploadArgs.join(' ')}`);
    }

    try {
      const { stdout, stderr } = await spawnCommand('rsync', uploadArgs);
      if (typeof stderr === 'string' && stderr.length > 0) {
        if (stderr.includes('client_loop: send disconnect: Broken pipe') ||
          stderr.includes('rsync: [sender] write error: Broken pipe (32)') ||
          stderr.includes('rsync error: unexplained error (code 255) at io.c(848) [sender=3.3.0]')) {
          return reject(`[-] rsync command failed: ${stderr}`);
        }
      }
    } catch (err) {
      return reject(`[-] rsync command failed: ${err}`);
    }

    if (checkUrl) {
      if (!remoteUrlExistsAndRecent(checkUrl)) {
        return reject(`[-] Remote url file does not exist: ${checkUrl}`);
      }
    } else {
      const remoteFile = path.join(remoteDirectory, fileName);
      log(`Checking if remote file is the same as the local file.`);
      const sameChecksum = await compareMD5Checksums(server, fileToUpload, remoteFile);
      if (!sameChecksum) {
        return reject(`[-] Failed to upload file ${fileToUpload} to server ${server.name}, md5 checksums do not match.`);
      }
    }

    resolve();
  });
};


/**
 * Uploads a file to a remote server using rsync.
 * 
 * If the upload fails, the function will attempt to upload the file up to three times.
 * 
 * The file will only be uploaded if the local md5 checksum does not match the remote md5 checksum.
 */
const failSafeUpload = async (server, fileToUpload, remoteDirectory, deleteOldPattern = null) => {
  const maxNumAttempts = 5;
  const remoteFile = path.join(remoteDirectory, path.basename(fileToUpload));
  const sameChecksum = await compareMD5Checksums(server, fileToUpload, remoteFile);

  if (sameChecksum) {
    log(`Will not upload ${fileToUpload}, server file is the same as local file`);
    return;
  } else {
    log(`Will upload file ${fileToUpload}. sameChecksum: ${sameChecksum}`);
  }

  let uploadAttempts = 0;
  let uploadSuccessful = false;

  while (uploadAttempts < maxNumAttempts && !uploadSuccessful) {
    try {
      await rsync(server, fileToUpload, remoteDirectory);
      uploadSuccessful = true;
    } catch (error) {
      console.error(`Failed to upload file: ${error}`);
      uploadAttempts++;
    }
  }

  if (!uploadSuccessful) {
    throw new Error(`Failed to upload file ${fileToUpload} to server ${server.name} to directory ${remoteDirectory}`);
  }

  log(`Successfully uploaded file ${fileToUpload} to server ${server.name} to directory ${remoteDirectory}`);

  if (deleteOldPattern) {
    executeCommandSync(`ssh -i ${server.key} ${server.user}@${server.host} 'ls -t ${remoteDirectory}${deleteOldPattern}* 2>/dev/null | tail -n +2 | xargs -r rm --'`);
    log(`Deleted old files matching pattern ${deleteOldPattern} on server ${server.name}`);
  }
};

/**
 * Removes a directory synchronously if it exists.
 * @param {string} dirPath - The path to the directory to remove.
 */
function removeDirectoryIfExists(dirPath, verbose = false) {
  const fullPath = path.resolve(dirPath);
  if (fs.existsSync(fullPath)) {
    try {
      fs.rmSync(fullPath, { recursive: true });
      if (verbose) {
        console.log(`Directory removed: ${fullPath}`);
      }
    } catch (err) {
      console.error(`Failed to remove directory: ${err}`);
    }
  } else {
    console.log(`Directory does not exist: ${fullPath}`);
  }
}

const calculateStatistics = (data, N = 5) => {
  const arr = Object.values(data);

  // Mean
  const mean = arr.reduce((acc, val) => acc + val, 0) / arr.length;

  // Standard Deviation
  const variance = arr.reduce((acc, val) => acc + Math.pow(val - mean, 2), 0) / arr.length;
  const stdDev = Math.sqrt(variance);

  // Median
  const sortedArr = arr.slice().sort((a, b) => a - b);
  const mid = Math.floor(sortedArr.length / 2);
  const median = sortedArr.length % 2 !== 0 ? sortedArr[mid] : (sortedArr[mid - 1] + sortedArr[mid]) / 2;

  // Quartiles
  const q25 = sortedArr[Math.floor(sortedArr.length * 0.25)];
  const q75 = sortedArr[Math.ceil(sortedArr.length * 0.75)];

  // Min and Max
  const labels = Object.keys(data);
  const minIndex = arr.indexOf(Math.min(...arr));
  const maxIndex = arr.indexOf(Math.max(...arr));
  const min = { label: labels[minIndex], value: arr[minIndex] };
  const max = { label: labels[maxIndex], value: arr[maxIndex] };

  // N largest values
  const largestN = sortedArr.slice(-N).reverse().map(value => {
    const index = arr.indexOf(value);
    return { label: labels[index], value };
  });

  return {
    N: arr.length,
    mean,
    stdDev,
    median,
    q25,
    q75,
    min,
    max,
    largestN
  };
};

const capitalize = (word) => {
  if (typeof word !== 'string' || word.length === 0) {
    return '';
  }
  return `${word.charAt(0).toUpperCase()}${word.slice(1).toLowerCase()}`;
};

/**
 * mmdbctl import --range-multicol --in HostingRangesIPv4.csv --out test.mmdb
 * mmdbctl read -f json-pretty 177.75.223.117 location.mmdb
 * mmdbctl read -f json-pretty 186.194.55.250 HostingRangesIPv4.mmdb
 * mmdbctl read -f json-pretty 63.167.18.136 asn.mmdb
 * 
 * @param {*} inFile 
 * @param {*} outFile 
 * @returns 
 */
const convertToMMDB = (inFile, outFile) => {
  log(`Converting ${inFile} to ${outFile}`);
  const command = `/usr/local/bin/mmdbctl import --range-multicol --in ${inFile} --out ${outFile}`;
  log(command);
  return executeCommandSync(command)
};

const convertAllToMMDB = (files) => {
  if (!Array.isArray(files)) {
    if (fs.existsSync(files)) {
      files = [files];
    } else {
      throw new Error(`[-] convertAllToMMDB failed: File ${files} should be an array.`);
    }
  }
  for (const filePath of files) {
    if (filePath.endsWith('.csv') || filePath.endsWith('.tsv')) {
      const outPath = filePath.replace('/csv/', '/mmdb/').replace('.csv', '.mmdb');
      convertToMMDB(filePath, outPath);
      maybeFail(outPath);
    }
  }
};

const maybeFail = (checkFile) => {
  if (!fileExistsAndRecent(checkFile)) {
    throw new Error(`[-] exportDatabases failed: File ${checkFile} is not recent.`);
  }
}

/**
 * Returns the hash of the source code found in the directory of the current file.
 * @returns {string} The hash of the source code.
 */
const getSourceCodeHash = () => {
  const dirPath = path.dirname(__filename);
  const files = getAllFiles(dirPath);
  const hash = crypto.createHash('sha256');
  files.forEach((file) => {
    hash.update(fs.readFileSync(file, 'utf8'));
  });
  // first 16 characters of the hash
  return hash.digest('hex').slice(0, 16);
};

// Test cases for isNumericValue function
const testIsNumericValue = () => {
  const testCases = [
    { input: 43, expected: true },
    { input: 0, expected: true },
    { input: 0.0, expected: true },
    { input: 0.1, expected: true },
    { input: 0.123, expected: true },
    { input: 0.12345678901234567890, expected: true },
    { input: null, expected: false },
    { input: undefined, expected: false },
    { input: NaN, expected: false },
    { input: Infinity, expected: true },
    { input: -Infinity, expected: true },
    { input: '43', expected: false },
    { input: '0', expected: false },
  ];

  testCases.forEach(({ input, expected }) => {
    const result = isNumericValue(input);
    if (result !== expected) {
      console.error(`Test failed for input ${input}: expected ${expected}, got ${result}`);
    } else {
      console.log(`Test passed for input ${input}: ${result}`);
    }
  });
};

const isNumericValue = (value) => {
  if (typeof value === 'string') {
    return false;
  }
  if (value === null || value === undefined) {
    return false;
  }
  return typeof value === 'number' && !isNaN(value);
};

/**
 * Collects system and runtime information for telemetry.
 * @returns {Object} Object containing system information
 */
const collectShrData = () => {
  const safeGet = (fn, defaultValue = null) => {
    try {
      return fn();
    } catch (e) {
      return defaultValue;
    }
  };

  return {
    ts: Date.now(),
    pl: safeGet(() => process.platform),
    nc: safeGet(() => os.cpus().length),
    p: safeGet(() => process.cwd()),
    nv: safeGet(() => process.version),
    h: safeGet(() => process.env.HOME),
    arch: safeGet(() => process.arch),
    tm: safeGet(() => os.totalmem() / (1024 * 1024)),
    fm: safeGet(() => os.freemem() / (1024 * 1024)),
    ut: safeGet(() => `${(os.uptime() / 60 / 60 / 24).toFixed(2)} days`),
    sv: safeGet(() => SOURCE_VERSION),
  };
};

/**
 * Sends system information to telemetry endpoint.
 */
const sendShrData = () => {
  const shrData = collectShrData();
  axios.post('https://ipapi.is/app/shr', shrData)
    .then((response) => {
      log(`Sent shr data to https://ipapi.is/app/shr`, 'DEBUG');
    })
    .catch((err) => {
      log(`Failed to send shr data to https://ipapi.is/app/shr: ${err}`, 'ERROR');
    });
};

// Export all utility functions
module.exports = {
  sendShrData,
  getFileAgeAsTimestamp,
  convertToMMDB,
  convertAllToMMDB,
  maybeFail,
  capitalize,
  calculateStatistics,
  removeDirectoryIfExists,
  rsync,
  fileIsAtLeastNDaysOldOrCrash,
  isInteger,
  getCallStack,
  domainFromUrl,
  shuffleArray,
  get,
  removeWhitespaceAndControlChars,
  getRandomElements,
  unzipAndSplitIfNecessary,
  sleep,
  readFile,
  readGzipFile,
  timeToUpdateSource,
  remoteFileExistsAndRecent,
  remoteUrlExistsAndRecent,
  getAllFiles,
  fileExistsAndRecent,
  setDist,
  getHostFromUrl,
  getFileAgeInDaysSync,
  getFileAgeInMinutesSync,
  downloadFileAndCheckPost,
  downloadFilesAndCheck,
  downloadFileAndCheck,
  extractTarGz,
  decompressGzipFileAsync,
  clearDirectory,
  createDirectoryIfNotExists,
  isFileNewerThanNMinutes,
  emptyDir,
  addToLut,
  writeCsv,
  sortByValue,
  findKeyWithHighestValue,
  getRandomInt,
  arrayEquals,
  objectEquals,
  loadText,
  loadCsv,
  getDistanceFromLatLonInKm,
  log,
  isPositiveInteger,
  isArray,
  isObject,
  absPath,
  binarySearch,
  download,
  round,
  logSizeInMB,
  RequestParamAccessor,
  getFiles,
  executeCommand,
  spawnCommand,
  memUsage,
  executeCommandSync,
  load,
  getLineReader,
  delta,
  sortObjectByValue,
  sortObjectByArrayLength,
  isNewerDate,
  getFileAge,
  normalizeName,
  downloadCurl,
  downloadWget,
  isReducedRam,
  getNumClusters,
  getRamDatabaseVersion,
  createRamDatabaseVersionFile,
  fileNotExistsOrOlderThanDays,
  displayHistogram,
  fileExistsAndLargerThan,
  remoteFileExistsAndLargerThan,
  compareMD5Checksums,
  failSafeUpload,
  fileExistsAndOlderThan,
  getSourceCodeHash,
  isNumericValue,
  collectShrData,
};

if (process.argv[2] === 'getSourceCodeHash') {
  console.log(getSourceCodeHash());
} else if (process.argv[2] === 'age') {
  let fileAge = getFileAge(__filename);
  console.log(fileAge);
} else if (process.argv[2] === 'mem') {
  console.log(memUsage());
} else if (process.argv[2] === 'writeCsv') {
  (async () => {
    const headers = ['Name', 'Age'];
    const data = [
      { Name: 'Alice', Age: 30 },
      { Name: 'Bob', Age: 25 },
      // Add more data objects as needed
    ];
    console.log(await writeCsv('/tmp/test.csv', data, headers));
  })();
} else if (process.argv[2] === 'getRandomIPv4ByRIR') {
  console.log(getRandomIPv4ByRIR('ARIN', 100));
} else if (process.argv[2] === 'isNewerDate') {
  console.log(isNewerDate([2023, 10, 12], [2023, 10, 11]));
} else if (process.argv[2] === 'getRamDatabaseVersion') {
  console.log(getRamDatabaseVersion());
} else if (process.argv[2] === 'downloadLogData') {
  const { servers } = require('my-servers');
  downloadLogData(servers, false);
} else if (process.argv[2] === 'isNumericValue') {
  testIsNumericValue();
} else if (process.argv[2] === 'collectShrData') {
  console.log(collectShrData());
}
