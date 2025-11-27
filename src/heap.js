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

    while (index > 0 && this.heap[parent].elapsed_ms > this.heap[index].elapsed_ms) {
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

    if (leftChild < this.heap.length && this.heap[leftChild].elapsed_ms < this.heap[smallest].elapsed_ms) {
      smallest = leftChild;
    }

    if (rightChild < this.heap.length && this.heap[rightChild].elapsed_ms < this.heap[smallest].elapsed_ms) {
      smallest = rightChild;
    }

    if (smallest !== index) {
      this.swap(index, smallest);
      this.heapify(smallest);
    }
  }

  // New method to retrieve the contents of the heap
  getTopRequests() {
    // Retrieve the top 50 most expensive requests
    const topRequests = [...this.heap];

    // Sort the top requests for display, since the heap is not necessarily in sorted order
    topRequests.sort((a, b) => b.elapsed_ms - a.elapsed_ms);

    return topRequests;
  }
}

exports.MinHeap = MinHeap;
