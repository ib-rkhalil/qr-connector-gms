const { connect, JSONCodec } = require('nats');

const jsonCodec = JSONCodec();

// Publishes scans and connectivity heartbeats to the same NATS subjects
// lane_events_consumer.py already subscribes to — see message_qr_handler
// (lane.{N}.qrcode, expects {"token": ..., "ts": ...}) and
// message_device_connectivity_handler (lane.{N}.device.connection.status,
// expects {"ip"/"status"/"timestamp"/"device_type"}; "qr" isn't a registered
// device_type there yet, so this heartbeat is published for future use only —
// see TECHNICAL_PLAN.md's Device-Health-parity scope note for this connector.
class NatsPublisher {
  constructor({ natsUrl, laneNumber }) {
    this.natsUrl = natsUrl;
    this.laneNumber = laneNumber;
    this.nc = null;
  }

  async connect() {
    this.nc = await connect({ servers: this.natsUrl });
  }

  async publishScan(token) {
    const subject = `lane.${this.laneNumber}.qrcode`;
    const payload = { token, ts: new Date().toISOString() };
    this.nc.publish(subject, jsonCodec.encode(payload));
    return payload;
  }

  async publishHeartbeat(status) {
    const subject = `lane.${this.laneNumber}.device.connection.status`;
    const payload = {
      ip: 'usb-hid-local',
      status,
      timestamp: new Date().toISOString(),
      device_type: 'qr',
    };
    this.nc.publish(subject, jsonCodec.encode(payload));
  }

  async close() {
    if (this.nc) {
      await this.nc.drain();
      this.nc = null;
    }
  }
}

module.exports = { NatsPublisher };
