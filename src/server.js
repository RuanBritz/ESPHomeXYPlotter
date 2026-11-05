import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import express from 'express';
import { config } from './config.js';
import { TcpConnection } from './transport/tcp-connection.js';
import { GrblController } from './grbl/controller.js';
import { JobRunner } from './job/runner.js';
import { createApiRouter } from './api/routes.js';
import { attachWebSocket } from './api/ws.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

export function createApp(cfg = config) {
  const controller = new GrblController({
    connection: new TcpConnection({ connectTimeoutMs: cfg.connectTimeoutMs }),
    lineTimeoutMs: cfg.lineTimeoutMs,
  });
  const runner = new JobRunner(controller);

  const app = express();
  app.disable('x-powered-by');
  app.use('/api', createApiRouter({ controller, runner, config: cfg }));
  app.use('/shared', express.static(path.join(root, 'shared')));
  app.use(express.static(path.join(root, 'public')));

  const server = http.createServer(app);
  const { wss } = attachWebSocket(server, { controller, runner });

  const close = () =>
    new Promise((resolve) => {
      controller.disconnect();
      for (const ws of wss.clients) ws.terminate();
      wss.close();
      server.close(() => resolve());
      server.closeAllConnections();
    });

  return { app, server, controller, runner, close };
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  const { server, close } = createApp();
  server.listen(config.port, config.host, () => {
    const shown = config.host === '0.0.0.0' ? 'localhost' : config.host;
    console.log(`XY Plotter UI running at http://${shown}:${config.port}`);
  });

  const shutdown = () => {
    close().then(() => process.exit(0));
    setTimeout(() => process.exit(0), 1000).unref();
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}
