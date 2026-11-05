import dns from 'node:dns/promises';
import net from 'node:net';

/** Is this a loopback, private (RFC 1918), link-local or unique-local address? */
export function isPrivateAddress(address) {
  if (net.isIPv4(address)) {
    const [a, b] = address.split('.').map(Number);
    return a === 10 || a === 127 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 169 && b === 254);
  }
  if (net.isIPv6(address)) {
    const lower = address.toLowerCase();
    if (lower === '::1') return true;
    if (lower.startsWith('::ffff:')) return isPrivateAddress(lower.slice(7));
    return /^f[cd]/.test(lower) || /^fe[89ab]/.test(lower);
  }
  return false;
}

/**
 * Validate a plotter address before the server connects to it, so the server
 * can't be used as a relay to arbitrary hosts.
 * Returns the address to actually connect to (resolved once, to avoid DNS rebinding).
 * @returns {Promise<{host: string, port: number, address: string}>}
 */
export async function validateTarget(host, port, policy) {
  host = String(host ?? '').trim();
  port = Number(port);
  if (!host || host.length > 253 || !/^[a-zA-Z0-9.\-:]+$/.test(host)) throw new Error('Invalid host');
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('Invalid port');

  if (policy === 'any') return { host, port, address: host };

  if (policy !== 'private') {
    const allowed = policy.split(',').map((s) => s.trim().toLowerCase()).filter(Boolean);
    if (!allowed.includes(host.toLowerCase())) throw new Error(`Host ${host} is not in ALLOWED_TARGETS`);
    return { host, port, address: host };
  }

  const addresses = net.isIP(host) ? [host] : (await dns.lookup(host, { all: true })).map((r) => r.address);
  if (!addresses.length || !addresses.every(isPrivateAddress)) {
    throw new Error(`Host ${host} is not a local network address (set ALLOWED_TARGETS to allow it)`);
  }
  return { host, port, address: addresses[0] };
}
