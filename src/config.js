// Runtime configuration, from environment variables (see .env.example).

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// Load .env from the project root if it exists. Variables already set in the environment win.
// (Done here rather than with `node --env-file-if-exists`, which breaks `--watch` when .env is missing.)
const envFile = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '.env');
if (fs.existsSync(envFile)) process.loadEnvFile(envFile);

const env = process.env;

function int(name, fallback) {
  const value = Number.parseInt(env[name] ?? '', 10);
  return Number.isFinite(value) ? value : fallback;
}

export const config = Object.freeze({
  /** Interface the web UI listens on. Use 127.0.0.1 to allow this computer only. */
  host: env.HOST || '0.0.0.0',
  port: int('PORT', 3000),
  /** Give up waiting for `ok` after this long (0 disables). Long slow moves can legitimately take minutes. */
  lineTimeoutMs: int('LINE_TIMEOUT_MS', 300_000),
  connectTimeoutMs: int('CONNECT_TIMEOUT_MS', 5000),
  /** Largest G-code upload accepted. */
  maxUploadBytes: int('MAX_UPLOAD_MB', 50) * 1024 * 1024,
  /**
   * Which plotter addresses the server may open TCP connections to.
   * 'private' (default): only LAN / loopback addresses. 'any': no restriction.
   * Or a comma-separated list of hosts/IPs.
   */
  allowedTargets: env.ALLOWED_TARGETS || 'private',
});
