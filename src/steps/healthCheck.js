const net = require('net');

// Attempts a single TCP connection to the given host:port.
// Not HTTP-specific (doesn't look for a 200 OK) — the goal is to verify the
// port is actually listening, regardless of the service's protocol
// (web server, API, DB, doesn't matter).
function checkPortOnce(port, host, timeoutMs) {
  return new Promise((resolve) => {
    const socket = new net.Socket();
    const finish = (ok) => {
      socket.destroy();
      resolve(ok);
    };
    socket.setTimeout(timeoutMs);
    socket.once('connect', () => finish(true));
    socket.once('timeout', () => finish(false));
    socket.once('error', () => finish(false));
    socket.connect(port, host);
  });
}

// Retries at fixed intervals until the port is ready, up to the timeout.
// host defaults to the IPv4 loopback address, not the "localhost" NAME:
// Node's DNS resolver can return "localhost" as IPv6 (::1) first (observed
// directly on a real Mac: `dns.lookup('localhost')` -> ::1), and a dev
// server bound only to the IPv4 interface (the common case) then never
// accepts that connection — the health check times out and reports the
// service as down even though it's genuinely up and reachable at 127.0.0.1.
async function waitForPort(port, { host = '127.0.0.1', timeoutMs = 90000, intervalMs = 1500 } = {}) {
  const start = Date.now();
  do {
    const ok = await checkPortOnce(port, host, Math.min(intervalMs, 2000));
    if (ok) return { ok: true, elapsedMs: Date.now() - start };
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  } while (Date.now() - start < timeoutMs);
  return { ok: false, elapsedMs: Date.now() - start };
}

module.exports = { waitForPort };
