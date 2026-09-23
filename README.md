# qr-connector-gms

Publishes decoded scans from a USB HID keyboard-emulation QR/barcode scanner to the
GMS lane hardware NATS bus, on `lane.{LANE_NUMBER}.qrcode`. This is the connector
`lane-controller-gms`'s `message_qr_handler` has been waiting for — everything
downstream of that subject (matching a queued vehicle, requesting an access decision
from GMS with `credentialType=QR`) already exists and works.

Unlike GMS's other hardware connectors (RFID reader, drop-arm barrier, ANPR camera,
ADAM I/O controller), this one talks to a **USB HID device**, not a networked one —
it can run either as a plain Node process on the host, or containerized with the
host's USB device passed through (see Docker below). Either way it's not part of
`docker-compose.yml`'s default `simulated` profile — like `anpr-connector-gms`, a
real scanner can't be faked in compose, so it only starts when asked for explicitly.

## Setup

```
npm install
cp .env.example .env
```

Find your scanner's real USB vendor/product ID (the `.env.example` defaults —
0x05e0/0x1200 — are Symbol Technologies' example from the original driver this is
based on, almost certainly not your device):

```
lsusb
```

Look for your scanner in the list (`Bus ... ID <vendor>:<product> <description>`) and
set `SCANNER_VENDOR_ID`/`SCANNER_PRODUCT_ID` in `.env` accordingly.

Point `NATS_URL` at wherever GMS's `nats` service is reachable from this host — the
project's own `docker-compose.yml` publishes it to `localhost:4222` by default.

## Running

Against the real scanner:

```
npm start
```

Without hardware — type or pipe a QR token in and it flows through the exact same
publish path as a real scan (useful for testing the NATS → lane-controller-gms → GMS
decision chain on its own):

```
SCANNER_MODE=stdin npm start
# then type a token and press Enter, or:
echo "VIS-XXXXXXXXXXXXXXXX" | SCANNER_MODE=stdin npm start
```

## Running in Docker

From the GMS repo root (`docker-compose.yml` builds this connector via
`context: ../qr-connector-gms`):

```
docker compose --profile qr up --build qr-connector-gms
```

The `devices:` mapping in `docker-compose.yml` (`/dev/hidraw0:/dev/hidraw0` by
default) is **host-specific** — it almost certainly isn't your actual scanner's
device node. Find the right one:

```
ls /dev/hidraw*        # candidate device nodes
lsusb                  # match one to your scanner's vendor/product ID
```

then edit the `devices:` line (and `SCANNER_VENDOR_ID`/`SCANNER_PRODUCT_ID` in the
compose service's `environment:`) to match. The image is `node:20-bookworm-slim`
(glibc, not alpine) so `node-hid`'s prebuilt native bindings install without a
from-source compile; build tools are included as a fallback in case they're ever
needed for a platform without a prebuilt binary.

To test the publish path in a container without real hardware, override the mode
instead of relying on the `devices:` mapping:

```
docker compose --profile qr run --rm -e SCANNER_MODE=stdin qr-connector-gms
# then type a token and press Enter (Ctrl+D to end)
```

## Building a Windows executable

```
npm ci
npm run build-windows
```

Produces `dist/windows/qr-connector.exe` via `@yao-pkg/pkg`. Unlike PyInstaller (used
for the other connectors), `pkg` doesn't need to run on Windows — it fetches a
prebuilt Windows Node 18 binary and a matching Linux one (to compile your code to V8
bytecode on this host) and splices the two together, so this build was run and
verified for real on this Linux dev machine, producing a genuine `PE32+ x86-64`
Windows executable. Verified end-to-end under Wine: it started, read `.env`,
connected to NATS, and correctly reached `node-hid`'s native USB binding (failing
only with "scanner not found", the expected error with no physical device attached
— not a native-module load error, which was the real risk with a native addon like
this one).

Two `package.json` details make the native `node-hid` addon work inside the
packaged exe:
- `"bin": "index.js"` — `pkg` requires this field to know the entrypoint.
- `"assets": ["node_modules/node-hid/prebuilds/**/*.node"]` — node-hid resolves its
  native binary path dynamically at runtime (via the `pkg-prebuilds` package), so
  `pkg`'s static `require()` analysis can't auto-detect it; it must be declared
  explicitly. node-hid ships prebuilt `.node` binaries for every platform (including
  `win32-x64`) directly in the npm package, so this works regardless of which OS you
  run `npm ci`/`pkg` on.

Copy a real `.env` (see `.env.example`) next to the `.exe` before running it. Wine's
USB/HID emulation isn't identical to real Windows, so still test the built exe
against a real scanner on actual Windows hardware before relying on it in
production — that's the one thing this verification can't fully prove from Linux.

## How it works

- `src/hidScanner.js` — opens the USB HID device by vendor/product ID, decodes the
  raw HID keyboard reports it sends (the scanner presents itself as a keyboard) back
  into the text it scanned, and emits a `scan` event once a full read completes
  (flushed on ENTER, or after a short debounce if the scanner doesn't send one).
- `src/stdinScanner.js` — the test-injection alternative, same shape, reads lines
  from stdin instead of a HID device.
- `src/natsPublisher.js` — publishes each `scan` to `lane.{N}.qrcode`, plus a
  connectivity heartbeat every 30s to `lane.{N}.device.connection.status`
  (`device_type: "qr"`, `ip: "usb-hid-local"` — a fixed sentinel, not a real address,
  used purely as this device's lookup key) so it shows up in GMS's Device Health like
  every other device type.
- `index.js` wires the two together and handles startup/shutdown.
