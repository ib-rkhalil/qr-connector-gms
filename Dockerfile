# node:*-slim (Debian/glibc), not alpine — node-hid ships prebuilt native bindings
# for glibc targets; alpine's musl libc would force a from-source compile every build
# and is more likely to fail without the exact right toolchain.
FROM node:20-bookworm-slim

WORKDIR /usr/src/app

# Build tools + libudev, as a fallback only: used if node-hid's prebuilt binary for
# this exact platform isn't available on npm install and it has to compile from
# source. udev is how node-hid enumerates/opens HID devices on Linux.
RUN apt-get update && apt-get install -y --no-install-recommends \
    python3 make g++ libudev-dev pkg-config \
    && rm -rf /var/lib/apt/lists/*

COPY package.json ./
RUN npm install --omit=dev

COPY . .

CMD ["node", "index.js"]
