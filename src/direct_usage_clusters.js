const fs = require("fs"); // Or `import fs from "fs";` with ESM
const { IPAPI } = require('./ip_api');
const { round, absPath } = require('./utils');
const cluster = require("cluster");
const os = require("os");

// USAGE: 
// node --max-old-space-size=14000 src/direct_usage_clusters.js

// this is the file with your IP's to lookup
const inputFile = absPath('./../test/gen.csv');
// each cluster generate's its own output file
// {{PID}} will be replaced with the cluster Process ID
// you will have to join the results from all output files (Sorry)
const outputFileFormat = absPath(`./../test/processed-{{PID}}.csv`);
// This code will distribute the load among `numClusters` clusters
// Increase this number for more clusters
const maxClusters = 2;

function getFileData(file) {
  const buffer = fs.readFileSync(file);
  return buffer.toString().split('\r\n');
}

function runInClusters() {
  const ipsToLookup = getFileData(inputFile).map(ip => ip.replace(/"/g, ''));
  ipsToLookup.shift();
  const N = ipsToLookup.length;

  const numCPUs = os.cpus().length;
  const numClusters = Math.min(numCPUs, maxClusters);
  const batchSize = Math.floor(ipsToLookup.length / numClusters);
  let k = 0;

  if (numClusters > 1) {
    if (cluster.isMaster) {
      console.log(`[+] Master process with PID ${process.pid} is running`);
      console.log(`[+] Distributing ${N} IP's among ${numClusters} clusters (numCPUs=${numCPUs})`);

      // Fork workers.
      for (let i = 0; i < numClusters; i++) {
        cluster.fork();
      }

      cluster.on('exit', (worker, code, signal) => {
        console.log(`cluster ${worker.process.pid} died`);
      });
    } else {
      // start next cluster with next batch of ips
      let nextBatch = ipsToLookup.slice(k * batchSize, (k + 1) * batchSize);
      lookupIpBatch(nextBatch);
      k++;
    }
  } else {
    // only one cluster used
    lookupIpBatch(ipsToLookup);
  }
}

function splitArrayIntoChunks(array, chunkSize) {
  const chunks = [];
  const length = array.length;

  for (let i = 0; i < length; i += chunkSize) {
    const chunk = array.slice(i, i + chunkSize);
    chunks.push(chunk);
  }

  return chunks;
}

/**
 * This function is running on a single cluster.
 * 
 * @param {*} ipBatch 
 */
function lookupIpBatch(ipBatch, maxChunkSize = 500000) {
  console.log(`[+] Lookup batch of ${ipBatch.length} IP's in cluster with PID ${process.pid}`);
  const chunks = splitArrayIntoChunks(ipBatch, maxChunkSize);

  // the API takes some time to load, since
  // a lot of data has to be stored into RAM
  const ipAPI = new IPAPI(true, true, false, true);
  ipAPI.loadAPI().then((loaded) => {
    let t0 = Date.now();

    for (let i = 0; i < chunks.length; i++) {
      const results = [];
      const chunk = chunks[i];
      console.log(`[i] [Cluster: ${process.pid}] Working on chunk ${i}/${chunks.length} with ${chunk.length} IPs`);
      // test how long it takes to lookup the IPs
      for (const ip of chunk) {
        let apiResult = ipAPI.fastLookup(ip);
        results.push(JSON.stringify(apiResult));
      }
      const linesToWrite = results.join('\n');
      fs.appendFileSync(outputFileFormat.replace('{{PID}}', process.pid), linesToWrite);
    }

    let t1 = Date.now();
    const elapsed_ms = t1 - t0;
    const avg = round(elapsed_ms / ipBatch.length, 2);
    console.log(`[+] [Cluster: ${process.pid}] Looked up ${ipBatch.length} IP's in ${elapsed_ms}ms, Average: ${avg}ms per lookup [Time includes writing results to disk!]`);
    process.exit();
  });
}

runInClusters();