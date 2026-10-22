import { describeError } from './errors.js';

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';
export type LogFields = Readonly<Record<string, unknown>>;

export interface Logger {
  debug(msg: string, fields?: LogFields): void;
  info(msg: string, fields?: LogFields): void;
  warn(msg: string, fields?: LogFields): void;
  error(msg: string, fields?: LogFields): void;
  child(fields: LogFields): Logger;
}

const LEVELS: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 };
const SENSITIVE_KEY = /pass(word)?|secret|token|authorization|cookie|credential/i;

export function parseLogLevel(value: string | undefined): LogLevel {
  const v = value?.toLowerCase();
  return v === 'debug' || v === 'info' || v === 'warn' || v === 'error' ? v : 'info';
}

function sanitize(value: unknown, depth: number): unknown {
  if (value instanceof Error) return describeError(value);
  if (value === null || typeof value !== 'object') {
    return typeof value === 'bigint' ? value.toString() : value;
  }
  if (depth >= 6) return '[truncated]';
  if (Array.isArray(value)) return value.map((v) => sanitize(v, depth + 1));
  const out: Record<string, unknown> = {};
  for (const [key, v] of Object.entries(value)) {
    out[key] = SENSITIVE_KEY.test(key) ? '[redacted]' : sanitize(v, depth + 1);
  }
  return out;
}

export interface LoggerOptions {
  level?: LogLevel;
  base?: LogFields;
  sink?: (line: string) => void;
  clock?: () => Date;
}

/** One JSON object per line on stdout - what CloudWatch Logs Insights and `docker logs` both want. */
export function createLogger(options: LoggerOptions = {}): Logger {
  const threshold = LEVELS[options.level ?? parseLogLevel(process.env['LOG_LEVEL'])];
  const sink = options.sink ?? ((line: string) => process.stdout.write(line + '\n'));
  const clock = options.clock ?? (() => new Date());
  const base = options.base ?? {};

  const write = (level: LogLevel, msg: string, fields?: LogFields) => {
    if (LEVELS[level] < threshold) return;
    const record = sanitize({ ...base, ...fields }, 0) as Record<string, unknown>;
    sink(JSON.stringify({ level, time: clock().toISOString(), msg, ...record }));
  };

  return {
    debug: (msg, fields) => {
      write('debug', msg, fields);
    },
    info: (msg, fields) => {
      write('info', msg, fields);
    },
    warn: (msg, fields) => {
      write('warn', msg, fields);
    },
    error: (msg, fields) => {
      write('error', msg, fields);
    },
    child: (fields) => createLogger({ ...options, base: { ...base, ...fields } }),
  };
}

export const silentLogger: Logger = createLogger({ sink: () => undefined, level: 'error' });
