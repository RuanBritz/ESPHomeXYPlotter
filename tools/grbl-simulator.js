// Simulated GRBL plotter on a TCP port, for trying the UI without hardware.
//   node tools/grbl-simulator.js [port]      (default 1234)
// Then connect the UI to 127.0.0.1:<port>. Lines are acknowledged after a short
// delay, position is tracked so status reports (?) and the preview marker move.
// Env: SIM_DELAY_MS (per-line processing time, default 5), SIM_LATENCY_MS (reply delay,
// mimics WiFi), SIM_RX_BUFFER (warn when more unanswered bytes than this, default 128).

import net from 'node:net';
import { ModalState, cleanLine } from '../shared/gcode.js';

const port = Number(process.argv[2] || process.env.SIM_PORT || 1234);
const LINE_DELAY_MS = Number(process.env.SIM_DELAY_MS || 5);
const RX_BUFFER = Number(process.env.SIM_RX_BUFFER || 128); // like GRBL on an Uno
const LATENCY_MS = Number(process.env.SIM_LATENCY_MS || 0); // extra delay on replies, to mimic WiFi

const server = net.createServer((socket) => {
  const peer = `${socket.remoteAddress}:${socket.remotePort}`;
  console.log(`client connected ${peer}`);
  let state = new ModalState();
  let wco = { x: 0, y: 0 };
  let hold = false;
  let buf = '';
  let buffered = 0; // bytes received but not yet answered, like GRBL's serial RX buffer
  const pending = [];

  const write = (text) => !socket.destroyed && socket.write(text + '\r\n');
  const reply = (text) => (LATENCY_MS ? setTimeout(write, LATENCY_MS, text) : write(text));
  const status = () =>
    reply(
      `<${hold ? 'Hold' : 'Idle'}|MPos:${(state.x + wco.x).toFixed(3)},${(state.y + wco.y).toFixed(3)},0.000` +
        `|FS:0,0|WCO:${wco.x.toFixed(3)},${wco.y.toFixed(3)},0.000>`,
    );

  reply("Grbl 1.1h ['$' for help]");

  const execute = (line) => {
    if (!line) return 'ok';
    if (line === '$$') return '$0=10\r\n$1=25\r\n$100=80.000\r\n$101=80.000\r\n$110=5000.000\r\n$111=5000.000\r\nok';
    if (line === '$X') return '[MSG:Caution: Unlocked]\r\nok';
    if (line === '$I') return '[VER:1.1h.simulator]\r\nok';
    if (line.startsWith('$J=')) {
      state.apply(line.slice(3));
      state.absolute = true; // $J= does not change the modal state
      return 'ok';
    }
    if (line.startsWith('$')) return 'ok';
    if (/^G10\b.*L20/.test(line)) {
      wco = { x: wco.x + state.x, y: wco.y + state.y };
      state.x = 0;
      state.y = 0;
      return 'ok';
    }
    if (/^[A-Z]/.test(line) === false) return 'error:1';
    state.apply(line);
    return 'ok';
  };

  const pump = () => {
    if (hold || !pending.length) return;
    const { line, bytes } = pending.shift();
    setTimeout(() => {
      buffered -= bytes;
      reply(execute(line));
      pump();
    }, LINE_DELAY_MS);
  };

  socket.setEncoding('utf8');
  socket.on('data', (chunk) => {
    buf += chunk;
    buf = buf.replace(/[!~?\x18]/g, (c) => {
      if (c === '?') status();
      else if (c === '!') hold = true;
      else if (c === '~') { hold = false; pump(); }
      else if (c === '\x18') {
        pending.length = 0;
        buffered = 0;
        hold = false;
        state = new ModalState();
        reply("Grbl 1.1h ['$' for help]");
      }
      return '';
    });
    let i;
    while ((i = buf.indexOf('\n')) !== -1) {
      const raw = buf.slice(0, i + 1);
      buf = buf.slice(i + 1);
      const bytes = Buffer.byteLength(raw);
      buffered += bytes;
      if (buffered > RX_BUFFER) console.warn(`RX buffer overflow: ${buffered} > ${RX_BUFFER} bytes (a real GRBL would drop data)`);
      const idle = pending.length === 0;
      pending.push({ line: cleanLine(raw), bytes });
      if (idle) pump();
    }
  });
  socket.on('close', () => console.log(`client disconnected ${peer}`));
  socket.on('error', () => {});
});

server.listen(port, '0.0.0.0', () => console.log(`GRBL simulator listening on 0.0.0.0:${port}`));
