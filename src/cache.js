class ListNode {
  constructor(key, value) {
    this.key = key;
    this.value = value;
    this.freq = 1;
    this.prev = null;
    this.next = null;
  }
}

class DoublyLinkedList {
  constructor() {
    this.head = new ListNode(); // Dummy head
    this.tail = new ListNode(); // Dummy tail
    this.head.next = this.tail;
    this.tail.prev = this.head;
  }

  addNode(node) {
    node.next = this.head.next;
    node.prev = this.head;
    this.head.next.prev = node;
    this.head.next = node;
  }

  removeNode(node) {
    node.prev.next = node.next;
    node.next.prev = node.prev;
  }

  popTail() {
    if (this.head.next === this.tail) {
      return null;
    }
    const tailNode = this.tail.prev;
    this.removeNode(tailNode);
    return tailNode;
  }

  isEmpty() {
    return this.head.next === this.tail;
  }
}

class LFUCache {
  constructor(maxSize = 100) {
    this.maxSize = maxSize;
    this.size = 0;
    this.cache = new Map(); // Key to node
    this.freqMap = new Map(); // Frequency to doubly linked list
    this.minFreq = 0;
    this.hits = 0; // Cache hit counter
    this.misses = 0; // Cache miss counter
  }

  get(key) {
    if (!this.cache.has(key)) {
      this.misses++; // Increment miss counter
      return null;
    }

    const node = this.cache.get(key);
    this._updateNode(node);
    this.hits++; // Increment hit counter
    return node.value;
  }

  set(key, value) {
    if (this.maxSize === 0) {
      return;
    }

    if (this.cache.has(key)) {
      const node = this.cache.get(key);
      node.value = value;
      this._updateNode(node);
    } else {
      if (this.size >= this.maxSize) {
        // Evict the least frequently used node
        const list = this.freqMap.get(this.minFreq);
        const nodeToRemove = list.popTail();
        this.cache.delete(nodeToRemove.key);
        this.size--;
      }

      const newNode = new ListNode(key, value);
      this.cache.set(key, newNode);
      if (!this.freqMap.has(1)) {
        this.freqMap.set(1, new DoublyLinkedList());
      }
      this.freqMap.get(1).addNode(newNode);
      this.minFreq = 1;
      this.size++;
    }
  }

  _updateNode(node) {
    const oldFreq = node.freq;
    node.freq++;
    const list = this.freqMap.get(oldFreq);
    list.removeNode(node);

    if (list.isEmpty() && oldFreq === this.minFreq) {
      this.minFreq++;
    }

    if (!this.freqMap.has(node.freq)) {
      this.freqMap.set(node.freq, new DoublyLinkedList());
    }
    this.freqMap.get(node.freq).addNode(node);
  }

  _estimateSizeInBytes(value) {
    if (value === null || value === undefined) {
      return 0;
    }
    if (Buffer.isBuffer(value)) {
      return value.length;
    }
    const valueType = typeof value;
    if (valueType === 'string') {
      return Buffer.byteLength(value, 'utf8');
    }
    if (valueType === 'number' || valueType === 'boolean' || valueType === 'bigint') {
      return Buffer.byteLength(String(value), 'utf8');
    }
    if (valueType === 'object') {
      try {
        return Buffer.byteLength(JSON.stringify(value), 'utf8');
      } catch (err) {
        return 0;
      }
    }
    return 0;
  }

  // Method to get cache statistics
  getStats() {
    let totalBytes = 0;
    for (const node of this.cache.values()) {
      totalBytes += this._estimateSizeInBytes(node.key);
      totalBytes += this._estimateSizeInBytes(node.value);
    }

    return {
      hits: this.hits,
      misses: this.misses,
      hitRate: this.hits + this.misses === 0
        ? '0%'
        : ((this.hits / (this.hits + this.misses)) * 100).toFixed(2) + '%',
      itemCount: this.size,
      cacheSizeMB: Number((totalBytes / (1024 * 1024)).toFixed(2))
    };
  }
}

exports.LFUCache = LFUCache;
