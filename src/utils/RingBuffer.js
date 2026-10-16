// Fixed-capacity ring buffer. Used for the vision-frame buffer and the
// ParamBus/vision debug log.
export class RingBuffer {
  constructor(capacity) {
    this.capacity = capacity;
    this.items = [];
  }

  push(item) {
    this.items.push(item);
    if (this.items.length > this.capacity) this.items.shift();
  }

  toArray() {
    return this.items.slice();
  }

  get length() {
    return this.items.length;
  }

  clear() {
    this.items.length = 0;
  }
}
