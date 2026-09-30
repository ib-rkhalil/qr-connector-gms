const HID = require('node-hid');
const { EventEmitter } = require('events');

// USB HID keycode -> ASCII, standard US keyboard layout. A HID keyboard-emulation
// scanner sends the decoded barcode/QR text as a stream of USB keyboard reports
// (the device *is* a keyboard, as far as the host is concerned) — this table is
// how those keycodes get turned back into characters.
const HID_TO_ASCII = {
  0x04: { normal: 'a', shift: 'A' },
  0x05: { normal: 'b', shift: 'B' },
  0x06: { normal: 'c', shift: 'C' },
  0x07: { normal: 'd', shift: 'D' },
  0x08: { normal: 'e', shift: 'E' },
  0x09: { normal: 'f', shift: 'F' },
  0x0a: { normal: 'g', shift: 'G' },
  0x0b: { normal: 'h', shift: 'H' },
  0x0c: { normal: 'i', shift: 'I' },
  0x0d: { normal: 'j', shift: 'J' },
  0x0e: { normal: 'k', shift: 'K' },
  0x0f: { normal: 'l', shift: 'L' },
  0x10: { normal: 'm', shift: 'M' },
  0x11: { normal: 'n', shift: 'N' },
  0x12: { normal: 'o', shift: 'O' },
  0x13: { normal: 'p', shift: 'P' },
  0x14: { normal: 'q', shift: 'Q' },
  0x15: { normal: 'r', shift: 'R' },
  0x16: { normal: 's', shift: 'S' },
  0x17: { normal: 't', shift: 'T' },
  0x18: { normal: 'u', shift: 'U' },
  0x19: { normal: 'v', shift: 'V' },
  0x1a: { normal: 'w', shift: 'W' },
  0x1b: { normal: 'x', shift: 'X' },
  0x1c: { normal: 'y', shift: 'Y' },
  0x1d: { normal: 'z', shift: 'Z' },
  0x1e: { normal: '1', shift: '!' },
  0x1f: { normal: '2', shift: '@' },
  0x20: { normal: '3', shift: '#' },
  0x21: { normal: '4', shift: '$' },
  0x22: { normal: '5', shift: '%' },
  0x23: { normal: '6', shift: '^' },
  0x24: { normal: '7', shift: '&' },
  0x25: { normal: '8', shift: '*' },
  0x26: { normal: '9', shift: '(' },
  0x27: { normal: '0', shift: ')' },
  0x28: { normal: 'ENTER', shift: 'ENTER' },
  0x2c: { normal: ' ', shift: ' ' },
  0x2d: { normal: '-', shift: '_' },
  0x2e: { normal: '=', shift: '+' },
  0x2f: { normal: '[', shift: '{' },
  0x30: { normal: ']', shift: '}' },
  0x31: { normal: '\\', shift: '|' },
  0x33: { normal: ';', shift: ':' },
  0x34: { normal: "'", shift: '"' },
  0x35: { normal: '`', shift: '~' },
  0x36: { normal: ',', shift: '<' },
  0x37: { normal: '.', shift: '>' },
  0x38: { normal: '/', shift: '?' },
};

// Reads a USB HID keyboard-emulation barcode/QR scanner and emits a 'scan' event
// with the fully decoded string. A scan is flushed immediately on ENTER (the
// terminator virtually every such scanner sends); the debounce timeout is a
// fallback for a scanner configured without one, so a read still surfaces instead
// of sitting in currentString forever.
class HidScanner extends EventEmitter {
  // devicePath (node-hid's own `path` field, e.g. a Windows HID instance path) is
  // required to tell apart two scanners of the *same* make/model on one machine —
  // vendorId/productId alone can't, since both devices report identical values there.
  // Optional: most sites have exactly one scanner per box, where vendorId/productId
  // is unambiguous and simpler to configure.
  constructor({ vendorId, productId, devicePath = null, flushDebounceMs = 50 }) {
    super();
    this.vendorId = vendorId;
    this.productId = productId;
    this.devicePath = devicePath;
    this.flushDebounceMs = flushDebounceMs;
    this.device = null;
    this.currentString = '';
    this.activeKeys = new Set();
    this.flushTimer = null;
  }

  start() {
    const devices = HID.devices();

    if (this.devicePath) {
      const scannerInfo = devices.find((d) => d.path === this.devicePath);
      if (!scannerInfo) {
        throw new Error(
          `Scanner not found at device path "${this.devicePath}". It may have been ` +
            'unplugged, or moved to a different USB port (some platforms tie the path ' +
            'to the physical port) -- run with --list-devices to see current paths.',
        );
      }
      this.device = new HID.HID(scannerInfo.path);
      this.device.on('data', (buffer) => this._handleReport(buffer));
      this.device.on('error', (err) => this.emit('error', err));
      return;
    }

    const matches = devices.filter(
      (d) => d.vendorId === this.vendorId && d.productId === this.productId,
    );
    if (matches.length === 0) {
      throw new Error(
        `Scanner not found (vendorId=0x${this.vendorId.toString(16)}, productId=0x${this.productId.toString(16)}). ` +
          'Check the USB connection, or that SCANNER_VENDOR_ID/SCANNER_PRODUCT_ID match your device (see README, "lsusb").',
      );
    }
    if (matches.length > 1) {
      console.warn(
        `Warning: ${matches.length} HID devices match vendorId=0x${this.vendorId.toString(16)}/` +
          `productId=0x${this.productId.toString(16)} -- picking the first one found. If this ` +
          'machine has two identical scanners (e.g. one per lane), set SCANNER_DEVICE_PATH ' +
          'instead so each connector instance binds to its own physical device (run with ' +
          '--list-devices to find each one\'s path).',
      );
    }

    this.device = new HID.HID(matches[0].path);
    this.device.on('data', (buffer) => this._handleReport(buffer));
    this.device.on('error', (err) => this.emit('error', err));
  }

  stop() {
    clearTimeout(this.flushTimer);
    if (this.device) {
      this.device.close();
      this.device = null;
    }
  }

  _flush() {
    if (this.currentString.length > 0) {
      this.emit('scan', this.currentString);
      this.currentString = '';
    }
  }

  _handleReport(buffer) {
    const modifier = buffer[0];
    const isShift = (modifier & 0x02) > 0 || (modifier & 0x20) > 0;

    // Extract all currently pressed key codes from bytes 2..7 of the HID report.
    const currentKeys = new Set();
    for (let i = 2; i < buffer.length; i++) {
      const code = buffer[i];
      if (code !== 0x00) {
        currentKeys.add(code);
      }
    }

    // Process only keys newly pressed in this report (vs. the previous one).
    for (const keyCode of currentKeys) {
      if (!this.activeKeys.has(keyCode)) {
        const charMap = HID_TO_ASCII[keyCode];
        if (charMap) {
          const char = isShift ? charMap.shift : charMap.normal;
          if (char === 'ENTER') {
            clearTimeout(this.flushTimer);
            this._flush();
          } else {
            this.currentString += char;
            clearTimeout(this.flushTimer);
            this.flushTimer = setTimeout(() => this._flush(), this.flushDebounceMs);
          }
        }
      }
    }
    this.activeKeys = currentKeys;
  }
}

module.exports = { HidScanner, HID_TO_ASCII };
