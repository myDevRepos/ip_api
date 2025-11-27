const EventEmitter = require('events');

class Worker extends EventEmitter {
  constructor(name) {
    super();
    this.name = name;
    this.isBusy = false;
  }

  startWork(item) {
    this.isBusy = true;
    const processingTime = Math.floor(Math.random() * 1001) + 500;
    console.log(`${this.name} started processing ${item}`);
    setTimeout(() => {
      console.log(`${this.name} finished processing ${item}`);
      this.isBusy = false;
      this.emit('free', this.name);
    }, processingTime);
  }
}

class ProcessingManager {
  constructor() {
    this.workers = [];
    this.items = ['item1', 'item2', 'item3', 'item4', 'item5', 'item6', 'item7', 'item8', 'item9', 'item10'];
    this.concurrentWorkers = 0;
  }

  initializeWorkers() {
    for (let i = 1; i <= 6; i++) {
      const worker = new Worker(`Worker${i}`);
      this.workers.push(worker);
    }

    this.workers.forEach((worker, index) => {
      worker.on('free', (workerName) => {
        this.concurrentWorkers--;
        console.log(`${workerName} is now free. Concurrent workers: ${this.concurrentWorkers}`);
        this.processItems(index);
      });
    });

    for (let i = 0; i < this.workers.length; i++) {
      this.processItems(i);
    }
  }

  processItems(workerIndex) {
    if (this.items.length > 0) {
      const currentWorker = this.workers[workerIndex];
      const currentItem = this.items.shift();
      this.concurrentWorkers++;
      console.log(`Assigning ${currentItem} to ${currentWorker.name}. Concurrent workers: ${this.concurrentWorkers}`);
      currentWorker.startWork(currentItem);
    }
  }
}

// Usage
const manager = new ProcessingManager();
manager.initializeWorkers();
