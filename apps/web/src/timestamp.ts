export interface TimestampBounds {
  minMs?: number;
  maxMs?: number;
}

export type TimestampValidationResult =
  | { ok: true; valueMs: number }
  | { ok: false; error: string };

const MINUTES_TIMESTAMP = /^(\d+):([0-5]\d)(?:\.(\d{1,3}))?$/;
const HOURS_TIMESTAMP = /^(\d+):([0-5]\d):([0-5]\d)(?:\.(\d{1,3}))?$/;
const DECIMAL_SECONDS = /^(\d+)(?:\.(\d{1,3}))?$/;

const fractionalMilliseconds = (value?: string) => Number((value ?? '').padEnd(3, '0') || 0);

function safeMilliseconds(seconds: number, milliseconds = 0) {
  if (!Number.isSafeInteger(seconds) || !Number.isSafeInteger(milliseconds)) return null;
  const value = seconds * 1000 + milliseconds;
  return Number.isSafeInteger(value) ? value : null;
}

/** Parse an intentional timestamp edit without coercing partial or malformed text. */
export function parseTimestamp(value: string): number | null {
  let match = HOURS_TIMESTAMP.exec(value);
  if (match) {
    const hours = Number(match[1]);
    const minutes = Number(match[2]);
    const seconds = Number(match[3]);
    const milliseconds = fractionalMilliseconds(match[4]);
    if (![hours, minutes, seconds, milliseconds].every(Number.isSafeInteger)) return null;
    return safeMilliseconds(hours * 3600 + minutes * 60 + seconds, milliseconds);
  }

  match = MINUTES_TIMESTAMP.exec(value);
  if (match) {
    const minutes = Number(match[1]);
    const seconds = Number(match[2]);
    const milliseconds = fractionalMilliseconds(match[3]);
    if (![minutes, seconds, milliseconds].every(Number.isSafeInteger)) return null;
    return safeMilliseconds(minutes * 60 + seconds, milliseconds);
  }

  match = DECIMAL_SECONDS.exec(value);
  if (!match) return null;
  const seconds = Number(match[1]);
  const milliseconds = fractionalMilliseconds(match[2]);
  return safeMilliseconds(seconds, milliseconds);
}

/** Format application timestamps with millisecond precision for direct editing. */
export function formatTimestamp(valueMs: number) {
  const totalMs = Number.isFinite(valueMs) ? Math.max(0, Math.round(valueMs)) : 0;
  const totalSeconds = Math.floor(totalMs / 1000);
  const milliseconds = totalMs % 1000;
  const seconds = totalSeconds % 60;
  const totalMinutes = Math.floor(totalSeconds / 60);
  const minutes = totalMinutes % 60;
  const hours = Math.floor(totalMinutes / 60);
  const fraction = milliseconds.toString().padStart(3, '0');

  if (hours > 0) {
    return `${hours}:${minutes.toString().padStart(2, '0')}:${seconds.toString().padStart(2, '0')}.${fraction}`;
  }
  return `${totalMinutes.toString().padStart(2, '0')}:${seconds.toString().padStart(2, '0')}.${fraction}`;
}

export function validateTimestamp(value: string, { minMs, maxMs }: TimestampBounds = {}): TimestampValidationResult {
  const valueMs = parseTimestamp(value);
  if (valueMs === null) {
    return { ok: false, error: 'Use m:ss / h:mm:ss / seconds (≤3 decimals).' };
  }
  if (minMs !== undefined && maxMs !== undefined && minMs > maxMs) {
    return { ok: false, error: 'Adjust the other time first.' };
  }
  if (minMs !== undefined && valueMs < minMs) {
    return { ok: false, error: `Earliest ${formatTimestamp(minMs)}.` };
  }
  if (maxMs !== undefined && valueMs > maxMs) {
    return { ok: false, error: `Latest ${formatTimestamp(maxMs)}.` };
  }
  return { ok: true, valueMs };
}
