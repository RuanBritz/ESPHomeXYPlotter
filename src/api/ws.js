import { WebSocketServer, WebSocket } from 'ws';

const HISTORY_SIZE = 300;

/**
 * Push-only WebSocket: the server broadcasts typed JSON messages, clients send
 * nothing (actions go through the REST API).
 *
 *   { type: 'hello', connection, job, log: LogEntry[] }   on connect
 *   { type: 'connection', ...controller.snapshot() }
 *   { type: 'job', ...runner.snapshot() }
 *   { type: 'progress', line, totalLines, elapsedMs }
 *   { type: 'machine', state, wpos, mpos, feed, estimated? }  status report, or a position estimate
 *   { type: 'log', dir, text, source, t }
 */
export function attachWebSocket(server, { controller, runner }) {
  const wss = new WebSocketServer({ server, path: '/ws' });
  const history = [];

  const broadcast = (msg) => {
    const data = JSON.stringify(msg);
    for (const client of wss.clients) {
      if (client.readyState === WebSocket.OPEN) client.send(data);
    }
  };

  const log = (entry) => {
    const msg = { type: 'log', t: Date.now(), ...entry };
    // Job line traffic would push everything useful out of the history new tabs receive.
    const jobTraffic = entry.source === 'job' && (entry.dir === 'tx' || entry.dir === 'rx');
    if (!jobTraffic) {
      history.push(msg);
      if (history.length > HISTORY_SIZE) history.shift();
    }
    if (entry.dir === 'error' || entry.dir === 'info') console.log(`[${entry.dir}] ${entry.text}`);
    broadcast(msg);
  };

  controller.on('log', log);
  runner.on('log', log);
  controller.on('state', (s) => broadcast({ type: 'connection', ...s }));
  controller.on('status', (s) => broadcast({ type: 'machine', ...s }));
  controller.on('estimate', (s) => broadcast({ type: 'machine', ...s }));
  runner.on('state', (s) => broadcast({ type: 'job', ...s }));
  runner.on('progress', (p) => broadcast({ type: 'progress', ...p }));

  wss.on('connection', (ws) => {
    ws.send(JSON.stringify({ type: 'hello', connection: controller.snapshot(), job: runner.snapshot(), log: history }));
  });

  // Drop clients that vanished without closing (sleeping phones, closed lids).
  const interval = setInterval(() => {
    for (const ws of wss.clients) {
      if (ws.isAlive === false) {
        ws.terminate();
        continue;
      }
      ws.isAlive = false;
      ws.ping();
    }
  }, 30_000);
  interval.unref();
  wss.on('connection', (ws) => {
    ws.isAlive = true;
    ws.on('pong', () => (ws.isAlive = true));
  });
  wss.on('close', () => clearInterval(interval));

  return { wss, broadcast, log };
}
