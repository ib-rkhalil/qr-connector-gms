// Load a .env file if one exists (a no-op otherwise, real environment variables
// still win — dotenv never overrides an already-set var by default) before reading
// any of the config below. A bare dotenv.config() resolves ".env" against
// process.cwd(), which for a pkg-packaged .exe depends entirely on how it was
// launched, not reliably the folder the .exe itself sits in — the same class of
// gotcha already found and fixed in lane-controller-gms's own PyInstaller build.
// process.pkg is only defined when actually running inside a pkg bundle.
const path = require('path');
require('dotenv').config({
  path: process.pkg ? path.join(path.dirname(process.execPath), '.env') : '.env',
});

const { HidScanner } = require('./src/hidScanner');
const { StdinScanner } = require('./src/stdinScanner');
const { NatsPublisher } = require('./src/natsPublisher');

const SCANNER_MODE = process.env.SCANNER_MODE || 'hid';
const NATS_URL = process.env.NATS_URL || 'nats://localhost:4222';
const LANE_NUMBER = process.env.LANE_NUMBER || '1';
// Symbol Technologies is just the example from the original driver snippet —
// find your actual scanner's IDs with `lsusb` (see README).
const SCANNER_VENDOR_ID = parseInt(process.env.SCANNER_VENDOR_ID || '0x05e0', 16);
const SCANNER_PRODUCT_ID = parseInt(process.env.SCANNER_PRODUCT_ID || '0x1200', 16);
// Only needed when two scanners of the same make/model are plugged into one box (e.g.
// a 2-lane LaneController) — vendorId/productId can't tell them apart, but node-hid's
// own device `path` is unique per physical device. Leave unset for the common
// single-scanner case. Find a device's path with --list-devices.
const SCANNER_DEVICE_PATH = process.env.SCANNER_DEVICE_PATH || null;
const HEARTBEAT_INTERVAL_MS = 30_000;

// `qr-connector.exe --list-devices` — there's no Windows equivalent of `lsusb` that
// shows node-hid's own path format, so this is the practical way to find the right
// SCANNER_DEVICE_PATH value when a box has two identical scanners installed.
if (process.argv.includes('--list-devices')) {
  const HID = require('node-hid');
  for (const d of HID.devices()) {
    console.log(
      `vendorId=0x${d.vendorId.toString(16).padStart(4, '0')} ` +
        `productId=0x${d.productId.toString(16).padStart(4, '0')} ` +
        `product=${JSON.stringify(d.product || '')} ` +
        `path=${d.path}`,
    );
  }
  process.exit(0);
}

async function main() {
  const publisher = new NatsPublisher({ natsUrl: NATS_URL, laneNumber: LANE_NUMBER });
  await publisher.connect();
  console.log(`Connected to NATS at ${NATS_URL} (lane ${LANE_NUMBER})`);

  const scanner =
    SCANNER_MODE === 'stdin'
      ? new StdinScanner()
      : new HidScanner({
          vendorId: SCANNER_VENDOR_ID,
          productId: SCANNER_PRODUCT_ID,
          devicePath: SCANNER_DEVICE_PATH,
        });

  scanner.on('scan', async (token) => {
    try {
      const payload = await publisher.publishScan(token);
      console.log(`Published scan: ${JSON.stringify(payload)}`);
    } catch (err) {
      console.error('Failed to publish scan:', err);
    }
  });
  scanner.on('error', (err) => {
    console.error('Scanner error:', err);
  });

  scanner.start();
  console.log(
    SCANNER_MODE === 'stdin'
      ? 'Scanner initialized in stdin test mode. Type or pipe a token and press Enter.'
      : `Scanner initialized (vendorId=0x${SCANNER_VENDOR_ID.toString(16)}, productId=0x${SCANNER_PRODUCT_ID.toString(16)}). Waiting for scans...`,
  );

  await publisher.publishHeartbeat('ONLINE');
  const heartbeat = setInterval(() => {
    publisher.publishHeartbeat('ONLINE').catch((err) => console.error('Heartbeat publish failed:', err));
  }, HEARTBEAT_INTERVAL_MS);

  async function shutdown() {
    console.log('\nShutting down...');
    clearInterval(heartbeat);
    scanner.stop();
    await publisher.close();
    process.exit(0);
  }
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

main().catch((err) => {
  console.error('Fatal error:', err);
  process.exit(1);
});
