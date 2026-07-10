// Observability — structured logging, in-memory metrics, and an error-reporting
// seam. Zero runtime dependencies (invariant 7): the logger writes JSON lines to
// an injectable sink (stdout by default), metrics are plain counters/histograms a
// deployment scrapes via GET /metrics, and error reporting is a seam a deployment
// can point at Sentry/etc. WITHOUT a kernel dependency. Nothing here holds a
// secret; the logger redacts obviously-sensitive field names defensively.

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

const LEVEL_RANK: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 };

export interface LogRecord {
  at: string;
  level: LogLevel;
  msg: string;
  [field: string]: unknown;
}

export type LogSink = (record: LogRecord) => void;

/** Field names whose values are redacted before they ever reach a sink. */
const REDACT = /^(authorization|bearer|token|secret|password|apikey|api_key|cookie|set-cookie)$/i;

function redact(fields: Record<string, unknown>): Record<string, unknown> {
  let out: Record<string, unknown> | null = null;
  for (const [k, v] of Object.entries(fields)) {
    if (REDACT.test(k)) {
      out ??= { ...fields };
      out[k] = '[redacted]';
    }
  }
  return out ?? fields;
}

/** A sink that discards everything — the default for library/embedded use (tests,
 *  in-process callers) so nothing logs unless a deployment opts into a real sink. */
export const silentSink: LogSink = () => {};

/** The default sink: one JSON line per record to stdout (warn/error to stderr). */
export const consoleSink: LogSink = (r) => {
  const line = JSON.stringify(r);
  if (r.level === 'error' || r.level === 'warn') console.error(line);
  else console.log(line);
};

/** A structured logger. `child()` binds context fields onto every subsequent line
 *  (e.g. a per-request logger carrying requestId/tenant), so call sites stay terse. */
export class Logger {
  private readonly sink: LogSink;
  private readonly minRank: number;
  private readonly base: Record<string, unknown>;
  private readonly clock: () => string;

  constructor(opts: { sink?: LogSink; level?: LogLevel; clock?: () => string; base?: Record<string, unknown> } = {}) {
    this.sink = opts.sink ?? consoleSink;
    this.minRank = LEVEL_RANK[opts.level ?? 'info'];
    this.clock = opts.clock ?? (() => new Date().toISOString());
    this.base = opts.base ?? {};
  }

  child(fields: Record<string, unknown>): Logger {
    return new Logger({ sink: this.sink, level: rankToLevel(this.minRank), clock: this.clock, base: { ...this.base, ...fields } });
  }

  log(level: LogLevel, msg: string, fields: Record<string, unknown> = {}): void {
    if (LEVEL_RANK[level] < this.minRank) return;
    const record: LogRecord = { at: this.clock(), level, msg, ...redact({ ...this.base, ...fields }) };
    try {
      this.sink(record);
    } catch {
      /* a logging sink must never break the caller */
    }
  }

  debug(msg: string, fields?: Record<string, unknown>): void { this.log('debug', msg, fields); }
  info(msg: string, fields?: Record<string, unknown>): void { this.log('info', msg, fields); }
  warn(msg: string, fields?: Record<string, unknown>): void { this.log('warn', msg, fields); }
  error(msg: string, fields?: Record<string, unknown>): void { this.log('error', msg, fields); }
}

function rankToLevel(rank: number): LogLevel {
  return (Object.keys(LEVEL_RANK) as LogLevel[]).find((l) => LEVEL_RANK[l] === rank) ?? 'info';
}

// --- metrics ----------------------------------------------------------------

/** A label set is rendered into a stable key so the same labels hit the same series. */
function labelKey(labels: Record<string, string>): string {
  const keys = Object.keys(labels).sort();
  return keys.map((k) => `${k}=${labels[k]}`).join(',');
}

interface CounterSeries { labels: Record<string, string>; value: number; }
interface HistoBucket { labels: Record<string, string>; count: number; sum: number; buckets: number[]; }

/** Default latency histogram bucket bounds (milliseconds). */
const DEFAULT_BUCKETS = [1, 5, 10, 25, 50, 100, 250, 500, 1000, 2500, 5000];

/** A tiny Prometheus-style metrics registry: labeled counters + latency
 *  histograms, snapshot()-able for JSON and renderProm()-able for scraping. */
export class Metrics {
  private readonly counters = new Map<string, Map<string, CounterSeries>>();
  private readonly histos = new Map<string, Map<string, HistoBucket>>();
  private readonly bounds: number[];

  constructor(opts: { buckets?: number[] } = {}) {
    this.bounds = (opts.buckets ?? DEFAULT_BUCKETS).slice().sort((a, b) => a - b);
  }

  increment(name: string, labels: Record<string, string> = {}, by = 1): void {
    const series = this.counters.get(name) ?? new Map<string, CounterSeries>();
    const key = labelKey(labels);
    const existing = series.get(key);
    if (existing) existing.value += by;
    else series.set(key, { labels: { ...labels }, value: by });
    this.counters.set(name, series);
  }

  observe(name: string, valueMs: number, labels: Record<string, string> = {}): void {
    const series = this.histos.get(name) ?? new Map<string, HistoBucket>();
    const key = labelKey(labels);
    const b = series.get(key) ?? { labels: { ...labels }, count: 0, sum: 0, buckets: this.bounds.map(() => 0) };
    b.count += 1;
    b.sum += valueMs;
    for (let i = 0; i < this.bounds.length; i++) {
      if (valueMs <= this.bounds[i]!) b.buckets[i]! += 1;
    }
    series.set(key, b);
    this.histos.set(name, series);
  }

  /** A structured view (for JSON responses / tests). */
  snapshot(): {
    counters: Array<{ name: string; labels: Record<string, string>; value: number }>;
    histograms: Array<{ name: string; labels: Record<string, string>; count: number; sum: number; buckets: Array<{ le: number; count: number }> }>;
  } {
    const counters: Array<{ name: string; labels: Record<string, string>; value: number }> = [];
    for (const [name, series] of this.counters) {
      for (const s of series.values()) counters.push({ name, labels: s.labels, value: s.value });
    }
    const histograms: Array<{ name: string; labels: Record<string, string>; count: number; sum: number; buckets: Array<{ le: number; count: number }> }> = [];
    for (const [name, series] of this.histos) {
      for (const h of series.values()) {
        histograms.push({ name, labels: h.labels, count: h.count, sum: h.sum, buckets: this.bounds.map((le, i) => ({ le, count: h.buckets[i]! })) });
      }
    }
    return { counters, histograms };
  }

  /** Prometheus text exposition (v0.0.4). */
  renderProm(): string {
    const lines: string[] = [];
    for (const [name, series] of this.counters) {
      lines.push(`# TYPE ${name} counter`);
      for (const s of series.values()) lines.push(`${name}${renderLabels(s.labels)} ${s.value}`);
    }
    for (const [name, series] of this.histos) {
      lines.push(`# TYPE ${name} histogram`);
      for (const h of series.values()) {
        // buckets[i] is already the cumulative "≤ bound" count (observe() increments
        // every bound at least as large as the value), so emit it directly.
        for (let i = 0; i < this.bounds.length; i++) {
          lines.push(`${name}_bucket${renderLabels({ ...h.labels, le: String(this.bounds[i]) })} ${h.buckets[i]!}`);
        }
        lines.push(`${name}_bucket${renderLabels({ ...h.labels, le: '+Inf' })} ${h.count}`);
        lines.push(`${name}_sum${renderLabels(h.labels)} ${h.sum}`);
        lines.push(`${name}_count${renderLabels(h.labels)} ${h.count}`);
      }
    }
    return lines.join('\n') + '\n';
  }
}

function renderLabels(labels: Record<string, string>): string {
  const keys = Object.keys(labels).sort();
  if (keys.length === 0) return '';
  return '{' + keys.map((k) => `${k}="${String(labels[k]).replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`).join(',') + '}';
}

// --- error reporting seam ---------------------------------------------------

export interface ErrorReporter {
  /** Report an unexpected error with context. Must never throw. */
  capture(error: unknown, context?: Record<string, unknown>): void;
}

/** The default reporter logs the error at error level. A deployment can inject a
 *  Sentry/Datadog reporter instead — no kernel dependency, just this interface. */
export class LoggingErrorReporter implements ErrorReporter {
  constructor(private readonly logger: Logger) {}
  capture(error: unknown, context: Record<string, unknown> = {}): void {
    const message = error instanceof Error ? error.message : String(error);
    const name = error instanceof Error ? error.constructor.name : typeof error;
    const stack = error instanceof Error ? error.stack : undefined;
    this.logger.error('unhandled_error', { ...context, errorName: name, errorMessage: message, stack });
  }
}

/** The observability bundle threaded through the App. */
export interface Observability {
  logger: Logger;
  metrics: Metrics;
  errors: ErrorReporter;
}

/** Build a default bundle (console logger + fresh metrics + logging reporter). */
export function defaultObservability(opts: { sink?: LogSink; level?: LogLevel; clock?: () => string } = {}): Observability {
  const logger = new Logger(opts);
  return { logger, metrics: new Metrics(), errors: new LoggingErrorReporter(logger) };
}
