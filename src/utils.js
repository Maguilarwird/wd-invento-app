// src/utils.js

export class Semaphore {
  constructor(max) {
    this.max = max;
    this.waiting = [];
    this.current = 0;
  }

  acquire(callback) {
    if (this.current < this.max) {
      this.current++;
      callback();
    } else {
      this.waiting.push(callback);
    }
  }

  release() {
    if (this.waiting.length > 0) {
      const next = this.waiting.shift();
      next();
    } else {
      this.current--;
    }
  }
}