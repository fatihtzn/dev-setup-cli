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
async function waitForPort(port, { host = 'localhost', timeoutMs = 90000, intervalMs = 1500 } = {}) {
  const start = Date.now();
  do {
    const ok = await checkPortOnce(port, host, Math.min(intervalMs, 2000));
    if (ok) return { ok: true, elapsedMs: Date.now() - start };
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  } while (Date.now() - start < timeoutMs);
  return { ok: false, elapsedMs: Date.now() - start };
}

module.exports = { waitForPort };
