/**
 * Memory monitoring utilities for debugging memory leaks
 */

import { performance } from 'perf_hooks';

export class MemoryMonitor {
  constructor() {
    this.snapshots = [];
    this.maxSnapshots = 100;
    this.enabled = process.env.SWARMFS_MEMORY_DEBUG === '1';
  }

  takeSnapshot(label) {
    if (!this.enabled) return;
    
    const mem = process.memoryUsage();
    const snapshot = {
      label,
      timestamp: Date.now(),
      hrtime: process.hrtime(),
      rss: mem.rss,          // Resident Set Size - total memory
      heapTotal: mem.heapTotal,
      heapUsed: mem.heapUsed,
      external: mem.external, // C++ objects
      arrayBuffers: mem.arrayBuffers
    };
    
    this.snapshots.push(snapshot);
    
    // Keep only recent snapshots
    if (this.snapshots.length > this.maxSnapshots) {
      this.snapshots.shift();
    }
    
    // Log if memory is growing
    if (this.snapshots.length > 1) {
      const prev = this.snapshots[this.snapshots.length - 2];
      const rssGrowth = mem.rss - prev.rss;
      const heapGrowth = mem.heapUsed - prev.heapUsed;
      
      if (rssGrowth > 50 * 1024 * 1024 || heapGrowth > 50 * 1024 * 1024) {
        console.log(`📈 Memory growth at ${label}:`);
        console.log(`   RSS: ${this._format(mem.rss)} (+${this._format(rssGrowth)})`);
        console.log(`   Heap: ${this._format(mem.heapUsed)} (+${this._format(heapGrowth)})`);
        console.log(`   ArrayBuffers: ${this._format(mem.arrayBuffers)}`);
      }
    }
  }

  getReport() {
    if (!this.enabled || this.snapshots.length < 2) return null;
    
    const first = this.snapshots[0];
    const last = this.snapshots[this.snapshots.length - 1];
    const duration = last.timestamp - first.timestamp;
    
    const report = {
      duration,
      snapshots: this.snapshots.length,
      rssGrowth: last.rss - first.rss,
      heapGrowth: last.heapUsed - first.heapUsed,
      arrayBufferGrowth: last.arrayBuffers - first.arrayBuffers,
      rssGrowthRate: (last.rss - first.rss) / (duration / 1000), // bytes/sec
      heapGrowthRate: (last.heapUsed - first.heapUsed) / (duration / 1000)
    };
    
    return report;
  }

  printReport() {
    const report = this.getReport();
    if (!report) return;
    
    console.log('\n📊 Memory Monitor Report:');
    console.log(`   Duration: ${(report.duration / 1000).toFixed(1)}s`);
    console.log(`   Snapshots: ${report.snapshots}`);
    console.log(`   RSS growth: ${this._format(report.rssGrowth)} (${this._format(report.rssGrowthRate)}/s)`);
    console.log(`   Heap growth: ${this._format(report.heapGrowth)} (${this._format(report.heapGrowthRate)}/s)`);
    console.log(`   ArrayBuffer growth: ${this._format(report.arrayBufferGrowth)}`);
    
    if (report.rssGrowthRate > 10 * 1024 * 1024) { // >10MB/s
      console.log('   ⚠️  High memory growth rate detected!');
    }
  }

  _format(bytes) {
    if (bytes === 0) return '0 B';
    const k = 1024;
    const sizes = ['B', 'KB', 'MB', 'GB'];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return `${(bytes / Math.pow(k, i)).toFixed(1)} ${sizes[i]}`;
  }

  // Track specific objects
  trackObject(obj, label) {
    if (!this.enabled) return;
    
    this.takeSnapshot(`Before ${label}`);
    return new Proxy(obj, {
      get(target, prop) {
        return target[prop];
      },
      set(target, prop, value) {
        if (typeof value === 'object' && value !== null) {
          console.log(`🔍 Object assignment at ${label}.${prop}:`, typeof value);
        }
        return target[prop] = value;
      }
    });
  }
}

// Global instance
export const memoryMonitor = new MemoryMonitor();
