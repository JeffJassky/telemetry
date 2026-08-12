import { z } from 'zod';
import { TelemetryKind, TELEMETRY_KINDS } from './types.js';

/**
 * The registry is the single contract: it drives validation, TypeScript types,
 * derived rollups, and index creation. It is HOST-OWNED — the host authors it
 * in their own code and passes it to createTelemetry(); this package never
 * ships event names (schema §4.2, instrumentation §8).
 */

/**
 * A dimension source. `subject` fans the rollup out over matching subject refs;
 * `attr:`/`field:` read one value off the record.
 */
export type DimSource = 'subject' | `attr:${string}` | `field:${string}`;

/**
 * Derived aggregate maintained on write (schema §4.5). One primitive, four
 * jobs: milestones, issue grouping, windowed spend, activity/retention.
 */
export interface RollupSpec {
  /** rollup family — several event names may feed one. Default: the event name */
  as?: string;
  /** dimensions, in order. At most one `subject`. */
  by: readonly DimSource[];
  /** when `by` includes `subject`, restrict to these subject types */
  subjects?: readonly string[];
  /**
   * Actor TYPE allowlist — a record whose `actor` has a type not listed here
   * skips this rollup; the raw row is unaffected. Absent = all actors; a record
   * with no actor always passes. This is how "admin support browsing never
   * moves a customer aggregate" is declared rather than disciplined.
   */
  actors?: readonly string[];
  /** time bucket (UTC). Omit for a lifetime rollup — that is the classic milestone.
   *  `hour` is for incident-grade dashboards; anything finer is the wrong store. */
  bucket?: 'hour' | 'day' | 'week' | 'month';
  /** metric keys accumulated with $add */
  sum?: readonly string[];
  /** dimension sources snapshotted at FIRST occurrence — cohort dimensions */
  capture?: readonly DimSource[];
  /**
   * Bucket name for a non-subject dim that resolves null/empty. Absent keeps
   * the default: skip the record and count it in `rollupSkipped`. Present makes
   * "no value" an explicit, queryable group instead of a silent drop.
   *
   * The SUBJECT dim is unaffected — see the fan-out comment in rollups.ts.
   */
  dimDefault?: string;
  /** rollup TTL. Omit or null = immortal (bucketed rollups usually want a number) */
  retentionDays?: number | null;
}

export interface EventSpec {
  kind: TelemetryKind;
  origin: 'server' | 'client' | 'any';
  /** subject TYPES that must be present (any number of ids per type) */
  subjects: readonly string[];
  /** attrs values are STRINGS after Mongoose casting — use z.string()/z.enum()/z.coerce.* */
  attrs?: z.ZodObject<any>;
  metrics?: z.ZodObject<any>;
  /**
   * `data` is UNSTORED unless declared here. Closes the erasure hole.
   *
   * Declare an OBJECT schema (or `boundedMeta()`). The type is the looser
   * `ZodType` so `boundedMeta()`'s transform fits, but `EmitInput.data` is an
   * object — a scalar schema like `z.string()` is expressible here and
   * unreachable through emit().
   */
  data?: z.ZodType<any>;
  /** attrs keys that get a real partial compound index built at boot */
  indexedAttrs?: readonly string[];
  /** metrics keys, same machinery — enables indexed numeric range queries */
  indexedMetrics?: readonly string[];
  /** derived aggregates maintained on write — funnels, issues, spend, retention */
  rollups?: readonly RollupSpec[];
  /** overrides RETENTION_DAYS[kind]. null = immortal */
  retentionDays?: number | null;
  /** overrides SAMPLE_RATE[kind]. Dormant by default — every kind ships at 1. */
  sampleRate?: number;
  /**
   * Rate cap on RAW storage per resolved key, per minute. Rollups still see
   * every record, so counts stay exact while an error storm or a client in a
   * retry loop cannot flood the collection. Omit `key` to cap the name whole.
   */
  burst?: { key?: DimSource; maxPerMinute: number };
  /**
   * Await the write with `{w:'majority', j:true}` and rethrow on failure — the
   * contract usage has always had, now declarable. For the host whose cost
   * ledger is a span: without it the only way to await was t.flush(), which
   * drains every in-flight write globally and serializes a busy worker.
   * kind=usage is durable unconditionally, with or without this flag.
   */
  durable?: boolean;
  description: string;
}

export type Registry = Record<string, EventSpec>;

/** Identity with a `const` type parameter so literal specs keep their shapes. */
export function defineRegistry<const R extends Registry>(specs: R): R {
  return specs;
}

/**
 * The maxed-shaped `data` escape hatch (build-plan §0.5): scalars only, ≤12
 * keys, strings ≤200 chars, one nesting level, ≤4 KB serialized. Violation
 * drops the WHOLE object — never truncates — so a stored payload is always
 * exactly what the caller sent. Parsing never throws; out-of-bounds resolves
 * to undefined and emit() counts the drop.
 */
export function boundedMeta(): z.ZodType<Record<string, unknown> | undefined> {
  const scalar = (v: unknown) =>
    v === null || typeof v === 'boolean' ||
    (typeof v === 'number' && Number.isFinite(v)) ||
    (typeof v === 'string' && v.length <= 200);

  const flat = (v: unknown): boolean => {
    if (scalar(v)) return true;
    if (Array.isArray(v)) return v.length <= 20 && v.every(scalar);
    if (v && typeof v === 'object' && !(v instanceof Date)) {
      const entries = Object.entries(v as Record<string, unknown>);
      return entries.length <= 12 && entries.every(([, x]) => scalar(x));
    }
    return false;
  };

  const bounded = (v: unknown): v is Record<string, unknown> => {
    if (!v || typeof v !== 'object' || Array.isArray(v) || v instanceof Date) return false;
    const entries = Object.entries(v as Record<string, unknown>);
    if (entries.length > 12) return false;
    if (!entries.every(([, x]) => flat(x))) return false;
    try {
      return JSON.stringify(v).length <= 4096;
    } catch {
      return false; // circular
    }
  };

  return z.unknown().transform((v) => (bounded(v) ? (v as Record<string, unknown>) : undefined));
}

const DIM_RE = /^(subject|attr:.+|field:.+)$/;

/**
 * Boot-time registry validation — misconfiguration fails deploy, not
 * dashboards. Covers per-spec sanity AND the cross-spec family-shape rule:
 * two events feeding one `as` with different `by` shapes produce docs whose
 * dims array means different things at the same position — silently
 * unqueryable (schema §4.5).
 */
export function validateRegistry(registry: Registry): void {
  const shapes = new Map<string, string>();

  for (const [name, spec] of Object.entries(registry)) {
    const fail = (msg: string) => {
      throw new Error(`telemetry: registry "${name}": ${msg}`);
    };

    if (!TELEMETRY_KINDS.includes(spec.kind)) fail(`unknown kind "${spec.kind}"`);
    if (!['server', 'client', 'any'].includes(spec.origin)) fail(`unknown origin "${spec.origin}"`);
    if (!Array.isArray(spec.subjects)) fail('`subjects` must be an array of subject types');
    if (spec.sampleRate != null && !(spec.sampleRate > 0 && spec.sampleRate <= 1)) {
      fail(`sampleRate ${spec.sampleRate} outside (0, 1]`);
    }
    if (spec.burst && !(spec.burst.maxPerMinute > 0)) fail('burst.maxPerMinute must be positive');
    if (spec.burst?.key && !DIM_RE.test(spec.burst.key)) fail(`bad burst key "${spec.burst.key}"`);
    for (const k of spec.indexedAttrs ?? []) {
      if (!spec.attrs || !(k in spec.attrs.shape)) fail(`indexedAttrs "${k}" not declared in attrs`);
    }
    for (const k of spec.indexedMetrics ?? []) {
      if (!spec.metrics || !(k in spec.metrics.shape)) fail(`indexedMetrics "${k}" not declared in metrics`);
    }

    for (const r of spec.rollups ?? []) {
      if (!r.by?.length) fail('rollup has empty `by`');
      for (const d of r.by) if (!DIM_RE.test(d)) fail(`bad dim source "${d}"`);
      if (r.by.filter((d) => d === 'subject').length > 1) {
        fail('rollup has more than one subject dim');
      }
      if (r.by.includes('subject') && !r.subjects?.length) {
        fail('rollup uses subject without `subjects`');
      }
      if (r.actors && !r.actors.length) fail('rollup `actors` must be non-empty when present');
      if (r.dimDefault !== undefined) {
        // dims are `label=value` and the rollup `_id` joins them on `|`, so
        // either character in the bucket name corrupts the key itself
        if (typeof r.dimDefault !== 'string' || !r.dimDefault) {
          fail('rollup `dimDefault` must be a non-empty string');
        }
        if (/[|=]/.test(r.dimDefault)) fail(`rollup dimDefault "${r.dimDefault}" may not contain "|" or "="`);
      }

      const as = r.as ?? name;
      // shape = dims + bucket + subject classes: any mismatch makes docs in one
      // family mean different things at the same array position (or triggers
      // the null-join inflation of schema §5.4), so all three pin per family.
      // dimDefault is NOT part of the shape — it changes which bucket a record
      // lands in, never what a position MEANS, so two names may feed one family
      // with different fallbacks.
      const shape =
        r.by.join(',') + '|' + (r.bucket ?? '') + '|' + [...(r.subjects ?? [])].sort().join(',');
      const seen = shapes.get(as);
      if (seen && seen !== shape) {
        throw new Error(`telemetry: rollup family "${as}" declared with two shapes: ${seen} / ${shape}`);
      }
      shapes.set(as, shape);
    }
  }
}
