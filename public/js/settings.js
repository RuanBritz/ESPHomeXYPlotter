// User preferences, stored in this browser.

const KEY = 'xyplotter.settings.v2';

export const DEFAULTS = Object.freeze({
  host: '192.168.100.228',
  port: 1234,
  autoReconnect: true,
  penUp: 'M5',
  penDown: 'M3 S1000',
  drawFeed: 3000,
  jogStep: 10,
  jogFeed: 1000,
  jogMode: 'g91',
  invertX: false,
  invertY: true, // the original UI sent Y-10 for "Y+" — keep that behaviour by default
  keyboardJog: false,
  showTravel: true,
  followCode: true,
  statusPollMs: 0,
  streaming: 'send-response',
  rxBufferSize: 128,
  showJobTraffic: false,
});

export function loadSettings() {
  try {
    return { ...DEFAULTS, ...JSON.parse(localStorage.getItem(KEY) ?? '{}') };
  } catch {
    return { ...DEFAULTS };
  }
}

export function saveSettings(settings) {
  localStorage.setItem(KEY, JSON.stringify(settings));
}

/** Fill the settings <form> from an object, and read it back. */
export function writeForm(form, settings) {
  for (const el of form.elements) {
    if (!el.name || !(el.name in settings)) continue;
    if (el.type === 'checkbox') el.checked = !!settings[el.name];
    else el.value = settings[el.name];
  }
}

export function readForm(form, settings) {
  const next = { ...settings };
  for (const el of form.elements) {
    if (!el.name || !(el.name in DEFAULTS)) continue;
    const def = DEFAULTS[el.name];
    if (el.type === 'checkbox') next[el.name] = el.checked;
    else if (typeof def === 'number') next[el.name] = Number(el.value) || def;
    else next[el.name] = el.value.trim() || def;
  }
  if (next.statusPollMs !== undefined) next.statusPollMs = Number(next.statusPollMs) || 0;
  return next;
}
