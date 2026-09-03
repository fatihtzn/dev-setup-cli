const net = require('net');

// Belirtilen host:port'a tek seferlik TCP bağlantısı dener.
// HTTP'ye özgü davranmaz (200 OK aramaz) — amaç, servisin protokolünden
// bağımsız olarak portun gerçekten dinlemede olduğunu doğrulamak
// (web sunucusu, API, DB fark etmez).
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

// Port hazır olana kadar belirli aralıklarla dener, timeout'a kadar bekler.
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
