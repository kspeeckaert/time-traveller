// time-utils.js — Intl formatter cache, epoch helpers, date labels, UTC offset strings
// Version: 1.2.20260330

export const _fmtCache = new Map();

/**
 * Returns a cached Intl.DateTimeFormat for the given IANA id + options.
 * @param {string} ianaId
 * @param {Intl.DateTimeFormatOptions} options
 */
export function getFormatter(ianaId, options) {
  const key = ianaId + '|' + JSON.stringify(options);
  if (!_fmtCache.has(key)) {
    _fmtCache.set(key, new Intl.DateTimeFormat('en-GB', { timeZone: ianaId, ...options }));
  }
  return _fmtCache.get(key);
}

/** Clears all cached formatters (call when system TZ changes). */
export function invalidateFormatterCache() {
  _fmtCache.clear();
}

/**
 * Returns the epoch ms that should be displayed (Date.now() + offsetMs).
 * offsetMs is passed in to keep this module stateless.
 * @param {number} offsetMs
 */
export function displayedEpoch(offsetMs) {
  return Date.now() + offsetMs;
}

/**
 * Resolves the IANA timezone id to use for a zone entry.
 * @param {{ id: string }} zone
 */
export function resolveIana(zone) {
  if (zone.id === 'local') {
    return Intl.DateTimeFormat().resolvedOptions().timeZone;
  }
  return zone.id; // 'UTC' or any IANA id
}

/**
 * Returns { hour, minute } for a zone at a given epoch.
 * @param {string} ianaId
 * @param {number} epoch
 */
export function timeInZone(ianaId, epoch) {
  const fmt = getFormatter(ianaId, { hour: '2-digit', minute: '2-digit', hour12: false });
  const parts = fmt.formatToParts(epoch);
  const get = (type) => parts.find(p => p.type === type)?.value ?? '00';
  return { hour: get('hour'), minute: get('minute') };
}

/**
 * Returns the date label for a zone relative to local today.
 * "Today" | "Tomorrow" | "Yesterday" | "YYYY-MM-DD"
 * @param {string} ianaId
 * @param {number} epoch
 */
export function dateLabel(ianaId, epoch) {
  const localTodayEpoch = Date.now();
  const localFmt = getFormatter(
    Intl.DateTimeFormat().resolvedOptions().timeZone,
    { year: 'numeric', month: '2-digit', day: '2-digit' }
  );
  const zoneFmt = getFormatter(ianaId, { year: 'numeric', month: '2-digit', day: '2-digit' });

  const toParts = (fmt, e) => {
    const parts = fmt.formatToParts(e);
    const get = (type) => parseInt(parts.find(p => p.type === type)?.value ?? '0', 10);
    return { y: get('year'), m: get('month'), d: get('day') };
  };

  const local = toParts(localFmt, localTodayEpoch);
  const zone  = toParts(zoneFmt, epoch);

  // Compute whole-day difference using UTC midnight offsets
  const toMidnightMs = ({ y, m, d }) => Date.UTC(y, m - 1, d);
  const diffDays = Math.round((toMidnightMs(zone) - toMidnightMs(local)) / 86400000);

  if (diffDays === 0)  return 'Today';
  if (diffDays === 1)  return 'Tomorrow';
  if (diffDays === -1) return 'Yesterday';

  // Format as YYYY-MM-DD
  const pad = (n) => String(n).padStart(2, '0');
  return `${zone.y}-${pad(zone.m)}-${pad(zone.d)}`;
}

/**
 * Returns a UTC offset string like "UTC+05:30" or "UTC−05:00" (U+2212 for minus).
 * @param {string} ianaId
 * @param {number} epoch
 */
export function utcOffsetString(ianaId, epoch) {
  // Use timeZoneName: "shortOffset" to get e.g. "GMT+5:30" or "GMT-5"
  const fmt = getFormatter(ianaId, { timeZoneName: 'shortOffset' });
  const parts = fmt.formatToParts(epoch);
  const tzPart = parts.find(p => p.type === 'timeZoneName')?.value ?? 'GMT+0';

  // Normalise: strip "GMT", pad to HH:MM, replace hyphen with U+2212
  let raw = tzPart.replace(/^GMT/, ''); // e.g. "+5:30" or "-5" or "+0"
  if (raw === '' || raw === '+0' || raw === '-0') return 'UTC±00:00';

  const sign = raw[0] === '-' ? '\u2212' : '+';
  const body = raw.slice(1); // "5:30" or "5"
  const [hStr, mStr = '0'] = body.split(':');
  const h = String(parseInt(hStr, 10)).padStart(2, '0');
  const m = String(parseInt(mStr, 10)).padStart(2, '0');
  return `UTC${sign}${h}:${m}`;
}

/**
 * Formats offsetMs as a human-readable offset label.
 * Returns "Now" for 0, otherwise e.g. "+2h", "−1d 6h 30m".
 * @param {number} offsetMs
 */
export function formatOffsetLabel(offsetMs) {
  if (offsetMs === 0) return 'Now';

  const sign = offsetMs < 0 ? '\u2212' : '+';
  let total = Math.abs(offsetMs);

  const days    = Math.floor(total / 86400000); total -= days * 86400000;
  const hours   = Math.floor(total / 3600000);  total -= hours * 3600000;
  const minutes = Math.floor(total / 60000);

  const parts = [];
  if (days)    parts.push(`${days}d`);
  if (hours)   parts.push(`${hours}h`);
  if (minutes) parts.push(`${minutes}m`);

  return sign + parts.join(' ');
}
