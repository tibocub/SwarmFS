/**
 * BitField - Compact representation of chunk availability
 */

export class BitField {
  constructor(size) {
    this.size = size;
    this.buffer = Buffer.alloc(Math.ceil(size / 8));
  }

  set(index) {
    if (index < 0 || index >= this.size) {
      throw new Error(`Index ${index} out of bounds (size: ${this.size})`);
    }
    const byte = Math.floor(index / 8);
    const bit = index % 8;
    this.buffer[byte] |= (1 << bit);
  }

  get(index) {
    if (index < 0 || index >= this.size) {
      return false;
    }
    const byte = Math.floor(index / 8);
    const bit = index % 8;
    return (this.buffer[byte] & (1 << bit)) !== 0;
  }

  has(index) {
    return this.get(index);
  }

  clear(index) {
    if (index < 0 || index >= this.size) {
      return;
    }
    const byte = Math.floor(index / 8);
    const bit = index % 8;
    this.buffer[byte] &= ~(1 << bit);
  }

  getSetIndices() {
    const indices = [];
    for (let i = 0; i < this.size; i++) {
      if (this.get(i)) {
        indices.push(i);
      }
    }
    return indices;
  }

  count() {
    let total = 0;
    for (let i = 0; i < this.size; i++) {
      if (this.get(i)) {
        total++;
      }
    }
    return total;
  }

  isFull() {
    return this.count() === this.size;
  }

  isEmpty() {
    return this.count() === 0;
  }

  static fromBase64(base64String, size) {
    const bitfield = new BitField(size);
    bitfield.buffer = Buffer.from(base64String, 'base64');
    return bitfield;
  }

  toBase64() {
    return this.buffer.toString('base64');
  }

  clone() {
    const clone = new BitField(this.size);
    this.buffer.copy(clone.buffer);
    return clone;
  }

  toString() {
    const chunks = [];
    for (let i = 0; i < Math.min(this.size, 64); i++) {
      chunks.push(this.get(i) ? '1' : '0');
    }
    const suffix = this.size > 64 ? '...' : '';
    return chunks.join('') + suffix;
  }
}
