// Parsing of GRBL (1.1) style responses.

/** @typedef {{ kind: 'ok' } | { kind: 'error', code: string, message: string }
 *  | { kind: 'alarm', code: string, message: string } | { kind: 'status', status: object }
 *  | { kind: 'welcome', version: string } | { kind: 'message', text: string }
 *  | { kind: 'other', text: string }} Response */

const ERRORS = {
  1: 'Expected command letter',
  2: 'Bad number format',
  3: 'Invalid $ statement',
  4: 'Negative value',
  5: 'Homing not enabled',
  6: 'Step pulse too short',
  7: 'EEPROM read failed',
  8: 'Not idle',
  9: 'Locked out (alarm or jog state)',
  10: 'Soft limits require homing',
  11: 'Line too long',
  12: 'Step rate too high',
  13: 'Safety door open',
  14: 'Startup line too long',
  15: 'Jog travel exceeds limits',
  16: 'Invalid jog command',
  17: 'Laser mode requires PWM',
  20: 'Unsupported command',
  21: 'Modal group violation',
  22: 'Undefined feed rate',
  23: 'Command requires integer value',
  24: 'Multiple axis-word commands',
  25: 'Repeated word',
  26: 'No axis words',
  27: 'Invalid line number',
  28: 'Missing value word',
  29: 'Work coordinate system unsupported',
  30: 'G53 only allowed with G0/G1',
  31: 'Unused axis words',
  32: 'G2/G3 require a plane axis word',
  33: 'Invalid motion target',
  34: 'Invalid arc radius',
  35: 'G2/G3 require an offset word',
  36: 'Unused value words',
  37: 'Tool length offset axis error',
  38: 'Tool number too large',
};

const ALARMS = {
  1: 'Hard limit triggered',
  2: 'Soft limit: target outside machine travel',
  3: 'Reset while in motion: position lost',
  4: 'Probe fail',
  5: 'Probe fail',
  6: 'Homing fail: reset during cycle',
  7: 'Homing fail: door opened',
  8: 'Homing fail: could not clear limit switch',
  9: 'Homing fail: limit switch not found',
};

/** @param {string} raw @returns {Response} */
export function parseResponse(raw) {
  const line = raw.trim();
  if (/^ok$/i.test(line)) return { kind: 'ok' };

  let m = /^error:?\s*(.*)$/i.exec(line);
  if (m) return { kind: 'error', code: m[1], message: ERRORS[m[1]] ?? m[1] };

  m = /^ALARM:?\s*(.*)$/i.exec(line);
  if (m) return { kind: 'alarm', code: m[1], message: ALARMS[m[1]] ?? m[1] };

  if (line.startsWith('<') && line.endsWith('>')) return { kind: 'status', status: parseStatus(line) };

  m = /^Grbl\s+(\S+)/i.exec(line);
  if (m) return { kind: 'welcome', version: m[1] };

  if (line.startsWith('[') && line.endsWith(']')) return { kind: 'message', text: line.slice(1, -1) };

  return { kind: 'other', text: line };
}

/**
 * "<Idle|MPos:1.000,2.000,0.000|FS:0,0|WCO:0,0,0>" ->
 * { state: 'Idle', mpos: {x,y,z}, wpos: {x,y,z} | null, feed, raw }
 */
export function parseStatus(line) {
  const fields = line.slice(1, -1).split('|');
  const status = { state: fields[0].split(':')[0], mpos: null, wpos: null, wco: null, feed: null, raw: line };
  for (const field of fields.slice(1)) {
    const [key, value = ''] = field.split(':');
    const nums = value.split(',').map(Number);
    const xyz = { x: nums[0] ?? 0, y: nums[1] ?? 0, z: nums[2] ?? 0 };
    if (key === 'MPos') status.mpos = xyz;
    else if (key === 'WPos') status.wpos = xyz;
    else if (key === 'WCO') status.wco = xyz;
    else if (key === 'FS' || key === 'F') status.feed = nums[0];
  }
  return status;
}
