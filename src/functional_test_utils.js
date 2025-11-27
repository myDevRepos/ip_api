const fs = require('fs');
const path = require('path');
const net = require('net');
const readline = require('readline');
const { round, log } = require('./utils');

const DATA_ROOT = '/Users/nikolaitschacher/projects/ip_api_data/ipapi_database';
const MAX_DATA_AGE_MS = 7 * 24 * 60 * 60 * 1000;
const MAX_DYNAMIC_SAMPLES = 3;

class TestReporter {
  constructor() {
    this.passed = 0;
    this.failed = 0;
    this.labelStats = new Map();
    this.capturing = false;
    this.originalLog = null;
    this.originalError = null;
    this.summaryPrinted = false;
  }

  start() {
    if (this.capturing) {
      return;
    }
    this.summaryPrinted = false;
    this.originalLog = console.log;
    this.originalError = console.error;
    console.log = (...args) => {
      const shouldLog = this.capture(args);
      if (shouldLog !== false) {
        this.originalLog.apply(console, args);
      }
    };
    console.error = (...args) => {
      this.capture(args);
      this.originalError.apply(console, args);
    };
    this.capturing = true;
  }

  stop() {
    if (!this.capturing) {
      return;
    }
    console.log = this.originalLog;
    console.error = this.originalError;
    this.capturing = false;
  }

  capture(args) {
    const message = args.map((arg) => this.stringify(arg)).join(' ');
    const labelMatch = message.match(/^\[([^\]]+)\]/);
    if (!labelMatch) {
      return true;
    }
    const label = labelMatch[1];
    if (this.isPassMessage(message)) {
      this.record(label, true);
      return false;
    }
    if (this.isFailMessage(message)) {
      this.record(label, false);
    }
    return true;
  }

  stringify(arg) {
    if (typeof arg === 'string') {
      return arg;
    }
    if (arg instanceof Error) {
      return arg.stack || arg.message;
    }
    try {
      return JSON.stringify(arg);
    } catch (err) {
      return String(arg);
    }
  }

  isPassMessage(message) {
    return /test passed/i.test(message) || /\[SUCCESS\]/i.test(message);
  }

  isFailMessage(message) {
    return /\[fail\]/i.test(message) || /test failed/i.test(message) || /\[FAILED\]/i.test(message) || /\[FAILURE\]/i.test(message);
  }

  record(label, isPass) {
    const stats = this.labelStats.get(label) || { passed: 0, failed: 0 };
    if (isPass) {
      this.passed++;
      stats.passed++;
    } else {
      this.failed++;
      stats.failed++;
    }
    this.labelStats.set(label, stats);
  }

  printSummary() {
    if (this.summaryPrinted) {
      return;
    }
    this.summaryPrinted = true;
    const total = this.passed + this.failed;
    const passRate = total === 0 ? 0 : round((this.passed / total) * 100, 2);
    const summaryLines = [
      '[Test Summary]',
      '  totals:',
      `    total=${total}`,
      `    passed=${this.passed}`,
      `    failed=${this.failed}`,
      `    passRate=${passRate}%`,
    ];
    const ordered = Array.from(this.labelStats.entries()).sort((a, b) => {
      const totalA = a[1].passed + a[1].failed;
      const totalB = b[1].passed + b[1].failed;
      return totalB - totalA || a[0].localeCompare(b[0]);
    });
    if (ordered.length > 0) {
      summaryLines.push('  byLabel:');
      for (const [label, stats] of ordered) {
        const labelTotal = stats.passed + stats.failed;
        const labelPassRate = labelTotal === 0 ? 0 : round((stats.passed / labelTotal) * 100, 2);
        summaryLines.push(`    - ${label}: passed=${stats.passed}, failed=${stats.failed}, total=${labelTotal}, passRate=${labelPassRate}%`);
      }
    }
    log(summaryLines.join('\n'));
  }
}

function isRecentFile(filePath) {
  try {
    const stats = fs.statSync(filePath);
    return stats.isFile() && (Date.now() - stats.mtimeMs) <= MAX_DATA_AGE_MS;
  } catch (err) {
    return false;
  }
}

function getRecentFiles(dirPath) {
  try {
    return fs.readdirSync(dirPath).map((name) => path.join(dirPath, name)).filter((filePath) => {
      try {
        const stats = fs.statSync(filePath);
        return stats.isFile() && (Date.now() - stats.mtimeMs) <= MAX_DATA_AGE_MS;
      } catch (err) {
        return false;
      }
    });
  } catch (err) {
    return [];
  }
}

function selectRandomItems(items, count) {
  const cloned = items.slice();
  const result = [];
  while (cloned.length > 0 && result.length < count) {
    const index = Math.floor(Math.random() * cloned.length);
    result.push(cloned.splice(index, 1)[0]);
  }
  return result;
}

function parseRangeToIPs(rangeStr) {
  if (!rangeStr) {
    return [];
  }
  const range = rangeStr.trim();
  if (!range) {
    return [];
  }
  if (range.includes('-')) {
    const parts = range.split('-').map((part) => part.trim());
    if (parts.length >= 2 && net.isIP(parts[0])) {
      return [parts[0]];
    }
  }
  if (range.includes('/')) {
    const base = range.split('/')[0].trim();
    if (net.isIP(base)) {
      return [base];
    }
  }
  if (net.isIP(range)) {
    return [range];
  }
  return [];
}

function normalizeTestIP(ip) {
  if (net.isIP(ip) === 4) {
    const parts = ip.split('.');
    const last = Number(parts[parts.length - 1]);
    if (!Number.isNaN(last) && last === 0) {
      parts[parts.length - 1] = '1';
      return parts.join('.');
    }
  }
  return ip;
}

function extractLineIPs(line) {
  if (!line) {
    return [];
  }
  const withoutComments = line.split('#')[0].trim();
  if (!withoutComments) {
    return [];
  }
  const rangeCandidates = parseRangeToIPs(withoutComments);
  if (rangeCandidates.length > 0) {
    return rangeCandidates.map(normalizeTestIP);
  }
  const cleaned = withoutComments.replace(/[\t,;]/g, ' ');
  const tokens = cleaned.split(/\s+/);
  const ips = [];
  for (const token of tokens) {
    const candidate = token.replace(/^[^0-9a-fA-F:.]+|[^0-9a-fA-F:.]+$/g, '');
    if (net.isIP(candidate)) {
      ips.push(normalizeTestIP(candidate));
    }
  }
  return ips;
}

function collectIPsFromFile(filePath, desiredCount) {
  return new Promise((resolve) => {
    const ips = [];
    let finished = false;
    const done = () => {
      if (finished) {
        return;
      }
      finished = true;
      resolve(ips);
    };

    const stream = fs.createReadStream(filePath, { encoding: 'utf8' });
    stream.on('error', () => done());

    const rl = readline.createInterface({ input: stream, crlfDelay: Infinity });
    rl.on('line', (line) => {
      if (finished) {
        return;
      }
      for (const ip of extractLineIPs(line)) {
        if (!ips.includes(ip)) {
          ips.push(ip);
        }
        if (ips.length >= desiredCount) {
          rl.close();
          break;
        }
      }
    });
    rl.on('close', () => done());
  });
}

function loadVpnEntries(filePath, desiredCount) {
  try {
    const raw = fs.readFileSync(filePath, 'utf8');
    const data = JSON.parse(raw);
    if (!Array.isArray(data)) {
      return [];
    }
    const candidates = data.filter((entry) => entry && entry.ip && entry.service && net.isIP(entry.ip));
    const sampleCount = Math.min(desiredCount, candidates.length);
    return selectRandomItems(candidates, sampleCount);
  } catch (err) {
    return [];
  }
}

function formatAxiosError(err) {
  if (!err) {
    return 'Unknown error';
  }
  if (err.response) {
    const { status, statusText, data } = err.response;
    const message = data && (data.error || data.message);
    const parts = [`status=${status}`];
    if (statusText) {
      parts.push(statusText);
    }
    if (message) {
      parts.push(`message=${message}`);
    }
    return parts.join(' ');
  }
  if (err.code) {
    return `${err.code}: ${err.message}`;
  }
  return err.message || 'Unknown error';
}

function summarizeAxiosResponse(response) {
  if (!response) {
    return 'no response';
  }
  const { status, statusText, data } = response;
  const parts = [];
  if (status) {
    parts.push(`status=${status}`);
  }
  if (statusText) {
    parts.push(statusText);
  }
  const message = data && (data.error || data.message);
  if (message) {
    parts.push(`message=${message}`);
  }
  return parts.join(' ') || 'empty response';
}

function logTestFail(label, { input, url, details }) {
  const parts = [`[${label}][fail]`, `input=${input ?? 'n/a'}`, `url=${url ?? 'n/a'}`];
  if (details) {
    parts.push(details);
  }
  log(parts.join(' '));
}

function extractRequestUrl(result, fallback) {
  if (result && typeof result === 'object' && result.__requestUrl) {
    return result.__requestUrl;
  }
  return fallback || 'unknown';
}

module.exports = {
  DATA_ROOT,
  MAX_DATA_AGE_MS,
  MAX_DYNAMIC_SAMPLES,
  TestReporter,
  isRecentFile,
  getRecentFiles,
  selectRandomItems,
  parseRangeToIPs,
  normalizeTestIP,
  extractLineIPs,
  collectIPsFromFile,
  loadVpnEntries,
  formatAxiosError,
  summarizeAxiosResponse,
  logTestFail,
  extractRequestUrl,
};
