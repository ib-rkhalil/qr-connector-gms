const readline = require('readline');
const { EventEmitter } = require('events');

// Test-injection input source: same public shape as HidScanner (start/stop, emits
// 'scan') but reads newline-delimited tokens from stdin instead of a real USB
// device. Lets the NATS-publish path, lane-controller-gms, and the GMS decision
// API all be exercised end-to-end without physical hardware — swap in via
// SCANNER_MODE=stdin.
class StdinScanner extends EventEmitter {
  constructor() {
    super();
    this.rl = null;
  }

  start() {
    this.rl = readline.createInterface({ input: process.stdin });
    this.rl.on('line', (line) => {
      const token = line.trim();
      if (token) this.emit('scan', token);
    });
  }

  stop() {
    if (this.rl) {
      this.rl.close();
      this.rl = null;
    }
  }
}

module.exports = { StdinScanner };
