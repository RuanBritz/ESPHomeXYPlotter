import net from 'node:net';

/**
 * Minimal fake GRBL controller on a TCP port.
 * - replies `ok` to every line (or `error:N` via `respond`)
 * - can split/coalesce responses to exercise line framing
 * - records every line received
 */
export async function startFakeGrbl({ respond = () => 'ok', delayMs = 0 } = {}) {
  const received = [];
  const realtime = [];
  const sockets = new Set();
  let pendingReplies = [];

  const server = net.createServer((socket) => {
    sockets.add(socket);
    socket.setEncoding('utf8');
    let buf = '';
    socket.on('data', (chunk) => {
      buf += chunk;
      // Realtime bytes can arrive anywhere and are not newline-terminated.
      buf = buf.replace(/[!~?\x18]/g, (c) => {
        realtime.push(c);
        if (c === '?') socket.write('<Idle|MPos:1.000,2.000,0.000|FS:0,0|WCO:0.000,0.000,0.000>\r\n');
        return '';
      });
      let idx;
      while ((idx = buf.indexOf('\n')) !== -1) {
        const line = buf.slice(0, idx).trim();
        buf = buf.slice(idx + 1);
        received.push(line);
        const bytes = Buffer.byteLength(line) + 1;
        fake.bufferedBytes += bytes; // bytes sitting in the "RX buffer" until answered
        fake.maxBufferedBytes = Math.max(fake.maxBufferedBytes, fake.bufferedBytes);
        const reply = respond(line, received.length - 1);
        if (reply == null) continue; // never answer this one
        const send = () => {
          fake.bufferedBytes -= bytes;
          if (!socket.destroyed) socket.write(reply + '\r\n');
        };
        if (fake.holdReplies) pendingReplies.push(send);
        else if (delayMs) setTimeout(send, delayMs);
        else send();
      }
    });
    socket.on('close', () => sockets.delete(socket));
    socket.on('error', () => {});
  });

  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));

  const fake = {
    port: server.address().port,
    received,
    realtime,
    holdReplies: false,
    bufferedBytes: 0,
    maxBufferedBytes: 0,
    /** Send all held replies in a single TCP write (coalesced). */
    flushCoalesced() {
      const sends = pendingReplies;
      pendingReplies = [];
      for (const s of sockets) s.cork();
      sends.forEach((send) => send());
      for (const s of sockets) s.uncork();
    },
    write(text) {
      for (const s of sockets) s.write(text);
    },
    dropClients() {
      for (const s of sockets) s.destroy();
    },
    async close() {
      for (const s of sockets) s.destroy();
      await new Promise((resolve) => server.close(resolve));
    },
  };
  return fake;
}

export const until = async (fn, timeoutMs = 3000) => {
  const start = Date.now();
  while (!fn()) {
    if (Date.now() - start > timeoutMs) throw new Error('Timed out waiting for condition');
    await new Promise((r) => setTimeout(r, 5));
  }
};
