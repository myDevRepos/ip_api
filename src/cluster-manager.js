const cluster = require("cluster");
const os = require("os");
const numCPUs = os.cpus().length;

process.on("message", (msg) => {
  if (msg === "shutdown") {
    console.log("Graceful shutdown in progress...");
    setTimeout(() => {
      console.log("Worker shutdown complete.");
      process.exit(0);
    }, 1000); // Give some time to finish current tasks before exit
  }
});

if (cluster.isMaster) {
  console.log(`🟢 Master ${process.pid} is running`);

  // Fork workers
  for (let i = 0; i < numCPUs; i++) {
    cluster.fork();
  }

  // Restart worker if it dies
  cluster.on("exit", (worker, code, signal) => {
    console.log(`⚠️ Worker ${worker.process.pid} died. Restarting...`);
    cluster.fork();
  });

} else {
  require("./ipapi_is_worker"); // Worker process
}