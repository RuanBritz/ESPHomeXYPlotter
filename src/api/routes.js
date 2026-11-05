import express from 'express';
import { cleanLine, REALTIME } from '../../shared/gcode.js';
import { validateTarget } from './targets.js';

class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

/**
 * REST API. Every action is a request here; live updates go out over the WebSocket.
 * @param {{ controller: import('../grbl/controller.js').GrblController,
 *           runner: import('../job/runner.js').JobRunner,
 *           config: typeof import('../config.js').config }} deps
 */
export function createApiRouter({ controller, runner, config }) {
  const api = express.Router();
  let macrosRunning = 0;

  api.use(express.json({ limit: '1mb' }));

  const snapshot = () => ({ connection: controller.snapshot(), job: runner.snapshot() });

  api.get('/state', (req, res) => res.json(snapshot()));

  // ---- Connection --------------------------------------------------------

  api.post('/connect', async (req, res) => {
    const { host, port, autoReconnect = true, statusPollMs = 0, streaming, rxBufferSize } = req.body ?? {};
    let target;
    try {
      target = await validateTarget(host, port, config.allowedTargets);
    } catch (err) {
      throw new HttpError(400, err.message);
    }
    if (controller.state === 'connected' || controller.state === 'connecting') {
      throw new HttpError(409, `Already ${controller.state}`);
    }
    try {
      controller.setStreaming({ streaming, rxBufferSize });
    } catch (err) {
      throw new HttpError(400, err.message);
    }
    try {
      await controller.connect(target.host, target.port, {
        autoReconnect: !!autoReconnect,
        address: target.address,
        statusPollMs: Number(statusPollMs) || 0,
      });
    } catch (err) {
      throw new HttpError(502, `Could not connect to ${target.host}:${target.port}: ${err.message}`);
    }
    res.json(snapshot());
  });

  api.patch('/connection/options', (req, res) => {
    const { statusPollMs, autoReconnect, streaming, rxBufferSize } = req.body ?? {};
    try {
      controller.setStreaming({ streaming, rxBufferSize });
    } catch (err) {
      throw new HttpError(400, err.message);
    }
    if (typeof autoReconnect === 'boolean') controller.autoReconnect = autoReconnect;
    if (statusPollMs !== undefined) controller.setStatusPolling(statusPollMs);
    res.json(snapshot());
  });

  api.post('/disconnect', (req, res) => {
    if (runner.isBusy) runner.pause();
    controller.disconnect();
    res.json(snapshot());
  });

  // ---- Commands ----------------------------------------------------------

  /** Run a list of commands in order, stopping at the first error. */
  api.post('/commands', async (req, res) => {
    const commands = req.body?.commands;
    if (!Array.isArray(commands) || !commands.every((c) => typeof c === 'string')) {
      throw new HttpError(400, 'Body must be { "commands": string[] }');
    }
    if (runner.isBusy) throw new HttpError(409, 'A job is running. Pause it first.');
    if (!controller.isConnected) throw new HttpError(409, 'Plotter not connected');

    const lines = commands.map(cleanLine).filter(Boolean);
    const responses = [];
    macrosRunning++;
    try {
      for (const line of lines) {
        try {
          responses.push({ command: line, response: await controller.send(line) });
        } catch (err) {
          responses.push({ command: line, error: err.message });
          return res.status(422).json({ ok: false, error: err.message, responses });
        }
      }
    } finally {
      macrosRunning--;
    }
    res.json({ ok: true, responses });
  });

  api.post('/realtime', (req, res) => {
    const name = req.body?.command;
    const byte = REALTIME[name];
    if (!byte) throw new HttpError(400, `Unknown realtime command. Use one of: ${Object.keys(REALTIME).join(', ')}`);
    if (!controller.isConnected) throw new HttpError(409, 'Plotter not connected');
    // A soft reset aborts whatever the controller was doing, so the job can't continue.
    if (name === 'reset' && (runner.state === 'running' || runner.state === 'paused')) runner.stop();
    controller.realtime(byte);
    res.json({ ok: true });
  });

  // ---- Job ---------------------------------------------------------------

  api.post('/job', express.text({ type: () => true, limit: config.maxUploadBytes }), (req, res) => {
    if (typeof req.body !== 'string' || !req.body.length) throw new HttpError(400, 'Send the G-code as the request body');
    const name = String(req.query.name ?? 'untitled.gcode').slice(0, 200);
    guard(() => runner.load(name, req.body));
    res.json(snapshot());
  });

  api.delete('/job', (req, res) => {
    guard(() => runner.unload());
    res.json(snapshot());
  });

  api.get('/job/gcode', (req, res) => {
    if (runner.state === 'empty') throw new HttpError(404, 'No file loaded');
    res.type('text/plain').send(runner.text);
  });

  api.post('/job/start', (req, res) => {
    if (macrosRunning) throw new HttpError(409, 'Commands are still running');
    guard(() => runner.start(req.body?.fromLine ?? 0));
    res.json(snapshot());
  });

  api.post('/job/pause', (req, res) => {
    guard(() => runner.pause());
    res.json(snapshot());
  });

  api.post('/job/resume', (req, res) => {
    guard(() => runner.resume());
    res.json(snapshot());
  });

  api.post('/job/stop', (req, res) => {
    guard(() => runner.stop());
    res.json(snapshot());
  });

  api.post('/job/line', (req, res) => {
    guard(() => runner.setNextLine(req.body?.line));
    res.json(snapshot());
  });

  api.patch('/job/options', (req, res) => {
    runner.setOptions(req.body ?? {});
    res.json(snapshot());
  });

  api.use((req, res) => res.status(404).json({ error: 'Not found' }));

  // eslint-disable-next-line no-unused-vars
  api.use((err, req, res, next) => {
    const status = err.status ?? err.statusCode ?? 500;
    if (status >= 500 && !(err instanceof HttpError)) console.error(err);
    res.status(status).json({ error: err.message });
  });

  return api;
}

/** Runner methods throw plain Errors for invalid state transitions -> 409. */
function guard(fn) {
  try {
    return fn();
  } catch (err) {
    throw new HttpError(409, err.message);
  }
}
