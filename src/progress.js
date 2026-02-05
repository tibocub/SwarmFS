/**
 * Progress display utilities
 */

/**
 * Create a simple progress bar
 */
export class ProgressBar {
  constructor(total, label = 'Progress') {
    this.total = total;
    this.current = 0;
    this.label = label;
    this.width = 40;
    this.lastUpdate = 0;
  }

  update(current) {
    this.current = current;
    
    // Throttle updates (max every 100ms)
    const now = Date.now();
    if (now - this.lastUpdate < 100 && current < this.total) {
      return;
    }
    this.lastUpdate = now;
    
    this.render();
  }

  render() {
    const percentage = Math.min(100, (this.current / this.total) * 100);
    const filled = Math.floor((percentage / 100) * this.width);
    const empty = this.width - filled;
    
    const bar = '█'.repeat(filled) + '░'.repeat(empty);
    const percent = percentage.toFixed(1).padStart(5);
    const size = this.formatBytes(this.current);
    const totalSize = this.formatBytes(this.total);
    
    // Use \r to overwrite the same line
    process.stdout.write(`\r${this.label}: [${bar}] ${percent}% (${size}/${totalSize})`);
    
    // Add newline when complete
    if (this.current >= this.total) {
      process.stdout.write('\n');
    }
  }

  complete() {
    this.current = this.total;
    this.render();
  }

  formatBytes(bytes) {
    if (bytes === 0) return '0 B';
    const k = 1024;
    const sizes = ['B', 'KB', 'MB', 'GB'];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return (bytes / Math.pow(k, i)).toFixed(1) + ' ' + sizes[i];
  }
}

/**
 * Simple percentage display (lighter weight)
 */
export function displayProgress(current, total, label = 'Downloading') {
  const percentage = Math.min(100, (current / total) * 100).toFixed(1);
  process.stdout.write(`\r${label}: ${percentage}%`);
  
  if (current >= total) {
    process.stdout.write('\n');
  }
}
