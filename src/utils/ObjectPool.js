// Generic object pool. Zero allocation in the hot loop for particles, crack
// segments, and shatter fragments (spec §0.2 rule 5).
export class ObjectPool {
  constructor(factory, reset, capacity = 1024) {
    this.factory = factory;
    this.reset = reset;
    this.capacity = capacity;
    this.free = [];
    this.active = [];
    for (let i = 0; i < capacity; i++) this.free.push(factory());
  }

  spawn(init) {
    let obj = this.free.pop();
    if (!obj) {
      if (this.active.length >= this.capacity) return null; // hard cap, drop silently
      obj = this.factory();
    }
    this.reset(obj, init);
    this.active.push(obj);
    return obj;
  }

  /** Iterate active objects, calling update(obj, dt); update returns false to reclaim. */
  step(dt, update) {
    for (let i = this.active.length - 1; i >= 0; i--) {
      const obj = this.active[i];
      const alive = update(obj, dt);
      if (!alive) {
        this.active.splice(i, 1);
        if (this.free.length < this.capacity) this.free.push(obj);
      }
    }
  }

  get count() {
    return this.active.length;
  }

  clear() {
    while (this.active.length) {
      const obj = this.active.pop();
      if (this.free.length < this.capacity) this.free.push(obj);
    }
  }
}
