class MinHeap {
  constructor() {
    this.heap = [];
  }

  swap(index1, index2) {
    [this.heap[index1], this.heap[index2]] = [this.heap[index2], this.heap[index1]];
  }

  parentIndex(index) {
    return Math.floor((index - 1) / 2);
  }

  leftChildIndex(index) {
    return 2 * index + 1;
  }

  rightChildIndex(index) {
    return 2 * index + 2;
  }

  add(element) {
    this.heap.push(element);
    let index = this.heap.length - 1;
    let parent = this.parentIndex(index);

    while (index > 0 && this.heap[parent].runtime > this.heap[index].runtime) {
      this.swap(parent, index);
      index = parent;
      parent = this.parentIndex(index);
    }

    if (this.heap.length > 50) {
      this.heap[0] = this.heap.pop();
      this.heapify(0);
    }
  }

  heapify(index) {
    let smallest = index;
    const leftChild = this.leftChildIndex(index);
    const rightChild = this.rightChildIndex(index);

    if (leftChild < this.heap.length && this.heap[leftChild].runtime < this.heap[smallest].runtime) {
      smallest = leftChild;
    }

    if (rightChild < this.heap.length && this.heap[rightChild].runtime < this.heap[smallest].runtime) {
      smallest = rightChild;
    }

    if (smallest !== index) {
      this.swap(index, smallest);
      this.heapify(smallest);
    }
  }

  // New method to retrieve the contents of the heap
  getTopRequests() {
    // This will return a copy of the heap array
    return [...this.heap];
  }
}

// Usage
const requestHeap = new MinHeap();

// Simulate adding 100 requests with random runtimes
for (let i = 1; i <= 100; i++) {
  const runtime = Math.floor(Math.random() * 500) + 1; // Random runtime between 1 and 500
  requestHeap.add({ id: `request${i}`, kind: 'normal', runtime: runtime });
}

// Retrieve the top 50 most expensive requests
const topRequests = requestHeap.getTopRequests();

// Sort the top requests for display, since the heap is not necessarily in sorted order
topRequests.sort((a, b) => b.runtime - a.runtime);

// Display the sorted top requests
console.log('Top 50 most expensive requests:', topRequests);
