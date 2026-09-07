import type { z } from 'zod';
import { BUILTIN_PLATFORMS } from './model.js';
import type { DimSource, Registry, RollupSpec } from './registry.js';
import {
  Env, LogLevel, Origin, RETENTION_DAYS, TELEMETRY_KINDS, TelemetryKind,
} from './types.js';

/**
 * The derived catalog (reports §3): everything a reader can ask this instance,
 * computed from the registry alone. Pure — no Mongo, no I/O — and built once at
 * createDashboard() / createTelemetryMcp(), boot-time like validateRegistry and
 * for the same reason: if the catalog cannot be built, the registry is wrong.
 *
 * It exists so that nothing is written twice. The registry already says which
 * events exist, which attrs and metrics they carry, which are indexed, and
 * which rollup families they feed; a page that names `cost_usd` is restating a
 * fact the package already knows. The rule this file installs is reports §11.1:
 * a page may not name a metric, an attr, or a family — it asks the catalog.
 */

export interface Catalog {
  events: Record<string, EventFacet>;
  families: Record<string, FamilyFacet>;
  /** name prefix before the first '.' → event names. An undotted name namespaces to itself. */
  namespaces: Record<string, string[]>;
  /** dims every record carries — filterable/groupable raw for every source */
  envelope: DimFacet[];
  /** every subject type named by any spec's `subjects` or any rollup's `subjects` */
  subjectTypes: string[];
}

export interface EventFacet {
  kind: TelemetryKind;
  origin: Origin | 'any';
  subjects: string[];
  description: string;
  namespace: string;
  /** one per declared attr, typed, followed by this kind's own envelope fields */
  dims: DimFacet[];
  /** 'count' first, then per metric key: sum:, avg:, p50:, p95:, p99: */
  measures: MeasureFacet[];
  /** rollup family names this event feeds (its `as`, or its own name) */
  families: string[];
  indexedAttrs: string[];
  indexedMetrics: string[];
  /** the EFFECTIVE retention — the spec's override, else RETENTION_DAYS[kind] */
  retentionDays: number | null;
}

export interface FamilyFacet {
  as: string;
  /** the grain, in declared order (pinned per family by validateRegistry) */
  by: DimSource[];
  /** rollups.ts `label(src)` per dim — the `x=` prefix written into `dims` */
  labels: string[];
  bucket: 'hour' | 'day' | 'week' | 'month' | null;
  /** a lifetime rollup has no bucket, and its `firstAt` IS the milestone */
  lifetime: boolean;
  /** the spec's `subjects` when `by` has a subject dim, else [] */
  subjectTypes: string[];
  sums: string[];
  /** labels of `capture` sources */
  capture: string[];
  /** event names declaring this family, registry order */
  feeders: string[];
  retentionDays: number | null;
}

export interface DimFacet {
  /**
   * The DimSource form, so it passes straight through to a rollup `by`, to
   * `groupBy`, and to a filter term: 'attr:model' | 'field:client.platform' |
   * 'subjectType' | 'actorType'.
   */
  key: string;
  /** what rollups.ts writes before '=' — 'model', 'client.platform'; for the two pseudo-dims, the key itself */
  label: string;
  type: 'string' | 'enum' | 'number' | 'boolean' | 'date';
  /** closed domain when known: z.enum / z.literal values, envelope enums */
  values?: string[];
  optional: boolean;
  /** true when a real index exists — an `indexedAttrs` attr, or a base-indexed envelope field */
  indexed: boolean;
}

export interface MeasureFacet {
  /** 'count' | 'sum:cost_usd' | 'avg:cost_usd' | 'p95:duration_ms' … */
  key: string;
  metric?: string;
  /** families whose `sum` carries this metric — exact answers. Only 'sum:' keys ever have one. */
  exactVia: string[];
}

export interface DeriveCatalogOptions {
  /**
   * Host additions to `client.platform`, exactly as CreateTelemetryConfig
   * .platforms extends them — the catalog reports the same closed domain the
   * writer enforces, or it would offer a filter value no record can carry.
   */
  platforms?: readonly string[];
}

/** the projection the SPA has always booted on — names and shapes, never zod objects */
export interface RegistryProjectionEntry {
  kind: TelemetryKind;
  origin: Origin | 'any';
  subjects: string[];
  description: string;
  attrKeys: string[];
  metricKeys: string[];
  indexedAttrs: string[];
  indexedMetrics: string[];
  rollups: {
    as: string;
    by: DimSource[];
    bucket: RollupSpec['bucket'] | null;
    sum: string[];
    subjects: string[];
  }[];
}

export type RegistryProjection = Record<string, RegistryProjectionEntry>;

// ── dimension labels ────────────────────────────────────────────────────────

/**
 * rollups.ts writes `${label(src)}=${value}` into `dims`, so the catalog has to
 * agree with it character for character or a groupBy would match nothing. The
 * bare `subject` source has no ':' and labels to itself, which is also what
 * that file's `slice(indexOf(':') + 1)` produces.
 */
const label = (src: DimSource): string => src.slice(src.indexOf(':') + 1);

// ── the zod walk ────────────────────────────────────────────────────────────

/**
 * zod 4 leaf `def.type` → the catalog's type. `z.coerce.*` is the base type
 * with `def.coerce` set, so it needs no case of its own; `z.int()` is a
 * ZodNumberFormat whose def.type is already 'number', and 'int' is listed
 * anyway so a future zod that names it does not silently degrade to 'string'.
 */
const LEAF_TYPES: Record<string, DimFacet['type']> = {
  string: 'string',
  number: 'number',
  int: 'number',
  bigint: 'number',
  boolean: 'boolean',
  date: 'date',
};

interface WalkedAttr {
  type: DimFacet['type'];
  values?: string[];
  optional: boolean;
}

/**
 * Unwrap a declared attr schema to its leaf and read the leaf's type and, when
 * the domain is closed, its values.
 *
 * Deliberately NOT `z.toJSONSchema`: this needs five cases, and a JSON-schema
 * round trip would put a second vocabulary between the registry and the UI.
 * Anything the walker does not recognise is 'string', which is honest — attrs
 * are strings after Mongoose casting anyway (registry.ts).
 */
function walkAttr(schema: unknown): WalkedAttr {
  let node: any = schema;
  let optional = false;

  // Bounded because a lazy or self-referential schema would otherwise hang
  // boot; twenty wrappers is already pathological.
  for (let depth = 0; node && depth < 20; depth++) {
    const def = node._zod?.def ?? node.def;
    if (!def?.type) break;

    switch (def.type) {
      // these three all mean "the value may be absent from a stored record",
      // which is the only thing `optional` claims
      case 'optional':
      case 'nullable':
      case 'default':
        optional = true;
        node = def.innerType;
        continue;

      case 'catch':
      case 'readonly':
        node = def.innerType;
        continue;

      // a pipe is `in -> out`; the INPUT side is what a caller may send and so
      // what a stored value was validated as. The output of a transform is
      // frequently a shape no filter could ever be written against.
      case 'pipe':
        node = def.in;
        continue;

      case 'enum': {
        // `.options` rather than Object.values(def.entries) because a numeric
        // TS enum's entries carry its reverse mapping too
        const options = Array.isArray(node.options) ? node.options : Object.values(def.entries ?? {});
        return { type: 'enum', values: options.map(String), optional };
      }

      case 'literal':
        return { type: 'enum', values: [...(def.values ?? [])].map(String), optional };

      default:
        return { type: LEAF_TYPES[def.type] ?? 'string', optional };
    }
  }

  return { type: 'string', optional };
}

// ── envelope dims ───────────────────────────────────────────────────────────

const dim = (
  key: string,
  type: DimFacet['type'],
  o: { values?: readonly string[]; optional?: boolean; indexed?: boolean } = {},
): DimFacet => ({
  key,
  // the two pseudo-dims are derived at query time from subjectKeys / actor, so
  // they carry no `field:` prefix and label to themselves
  label: key.startsWith('field:') ? key.slice(6) : key,
  type,
  ...(o.values ? { values: [...o.values] } : {}),
  optional: o.optional ?? false,
  indexed: o.indexed ?? false,
});

/**
 * Fixed, not inferred. These are `field:` sources a rollup may already declare,
 * so the labels agree with what rollups.ts writes into `dims`. `indexed` is
 * true only where model.ts actually builds a base index over the field —
 * {tenantId, kind, name, occurredAt} and {tenantId, subjectKeys, occurredAt}.
 */
const envelopeDims = (platforms: readonly string[]): DimFacet[] => [
  dim('field:kind', 'enum', { values: TELEMETRY_KINDS, indexed: true }),
  dim('field:name', 'string', { indexed: true }),
  dim('field:severity', 'enum', { values: Object.values(LogLevel) }),
  dim('field:env', 'enum', { values: Object.values(Env) }),
  dim('field:service', 'string'),
  dim('field:release', 'string'),
  dim('field:origin', 'enum', { values: Object.values(Origin) }),
  // client context is absent on server-origin records, so both of its dims are optional
  dim('field:client.platform', 'enum', { values: platforms, optional: true }),
  dim('field:client.appVersion', 'string', { optional: true }),
  dim('subjectType', 'string', { optional: true, indexed: true }),
  dim('actorType', 'string', { optional: true }),
];

/**
 * The discriminator's own fields, offered only on events of that kind — a usage
 * event's dims include its meter, an event event's do not. `indexed` again
 * tracks the real discriminator indexes in model.ts, which is why
 * `error.type` is false while `state.key` is true: the error index is on
 * `error.fingerprint`.
 */
const kindDims = (kind: TelemetryKind): DimFacet[] => {
  switch (kind) {
    case TelemetryKind.Usage:
      return [
        dim('field:usage.meter', 'string', { indexed: true }),
        dim('field:usage.billedTo', 'string'),
        dim('field:usage.unit', 'string'),
      ];
    case TelemetryKind.State:
      return [
        dim('field:state.key', 'string', { indexed: true }),
        dim('field:state.to', 'string', { indexed: true }),
      ];
    case TelemetryKind.Error:
      return [dim('field:error.type', 'string'), dim('field:error.handled', 'boolean')];
    default:
      return [];
  }
};

// ── the derivation ──────────────────────────────────────────────────────────

/** the three raw-only operators every metric gets beside its exact `sum:` */
const RAW_OPS = ['avg', 'p50', 'p95', 'p99'] as const;

export function deriveCatalog(registry: Registry, opts: DeriveCatalogOptions = {}): Catalog {
  // union, never replacement — a host adding 'watchos' keeps 'web' (model.ts)
  const platforms = [...new Set([...BUILTIN_PLATFORMS, ...(opts.platforms ?? [])])];

  // Families first: an EventFacet names the families it feeds and a family
  // names every event that feeds it, so the family pass has to see the whole
  // registry before any event facet can be finished.
  const families: Record<string, FamilyFacet> = {};
  for (const [name, spec] of Object.entries(registry)) {
    for (const r of spec.rollups ?? []) {
      const as = r.as ?? name;
      const seen = families[as];

      if (!seen) {
        families[as] = {
          as,
          by: [...r.by],
          labels: r.by.map(label),
          bucket: r.bucket ?? null,
          lifetime: !r.bucket,
          // `subjects` only means anything when there is a subject dim to
          // restrict; without one it selects nothing and claiming it would
          // offer a subject filter the family cannot answer
          subjectTypes: r.by.includes('subject') ? [...(r.subjects ?? [])] : [],
          sums: [...(r.sum ?? [])],
          capture: (r.capture ?? []).map(label),
          feeders: [name],
          retentionDays: r.retentionDays ?? null,
        };
        continue;
      }

      // `by`, `bucket` and `subjects` are pinned per family by validateRegistry
      // — two shapes under one `as` is a boot error — so the first feeder
      // settles the grain and later ones cannot disagree. `sum` and `capture`
      // are NOT pinned, because a second name may accumulate another metric
      // into the same docs, so they union in declaration order: that is what a
      // reader of the family can actually find in it. `retentionDays` is taken
      // from the first feeder; it is stamped per record by whichever spec
      // produced it, so a family fed by two different TTLs genuinely has two.
      for (const k of r.sum ?? []) if (!seen.sums.includes(k)) seen.sums.push(k);
      for (const c of r.capture ?? []) {
        const l = label(c);
        if (!seen.capture.includes(l)) seen.capture.push(l);
      }
      if (!seen.feeders.includes(name)) seen.feeders.push(name);
    }
  }

  const events: Record<string, EventFacet> = {};
  const namespaces: Record<string, string[]> = {};
  const subjectTypes: string[] = [];
  const noteSubject = (t: string) => {
    if (!subjectTypes.includes(t)) subjectTypes.push(t);
  };

  for (const [name, spec] of Object.entries(registry)) {
    const dot = name.indexOf('.');
    const namespace = dot === -1 ? name : name.slice(0, dot);
    (namespaces[namespace] ??= []).push(name);

    for (const s of spec.subjects) noteSubject(s);

    const indexedAttrs = [...(spec.indexedAttrs ?? [])];
    const dims: DimFacet[] = Object.entries((spec.attrs?.shape ?? {}) as Record<string, z.ZodType>).map(
      ([key, schema]) => {
        const walked = walkAttr(schema);
        return {
          key: `attr:${key}`,
          label: key,
          type: walked.type,
          ...(walked.values ? { values: walked.values } : {}),
          optional: walked.optional,
          indexed: indexedAttrs.includes(key),
        };
      },
    );
    dims.push(...kindDims(spec.kind));

    // this event's OWN declarations, per family. `exactVia` must not name a
    // family that sums the metric only because a DIFFERENT feeder said so —
    // this event's records would not be in that total.
    const eventFamilies: string[] = [];
    const ownSums = new Map<string, Set<string>>();
    for (const r of spec.rollups ?? []) {
      const as = r.as ?? name;
      if (!eventFamilies.includes(as)) eventFamilies.push(as);
      const set = ownSums.get(as) ?? new Set<string>();
      for (const k of r.sum ?? []) set.add(k);
      ownSums.set(as, set);
      for (const s of r.subjects ?? []) noteSubject(s);
    }

    const measures: MeasureFacet[] = [{ key: 'count', exactVia: [] }];
    for (const k of Object.keys(spec.metrics?.shape ?? {})) {
      measures.push({
        key: `sum:${k}`,
        metric: k,
        exactVia: eventFamilies.filter((as) => ownSums.get(as)?.has(k)),
      });
      for (const op of RAW_OPS) measures.push({ key: `${op}:${k}`, metric: k, exactVia: [] });
    }
    // durationMs lives on the envelope for kind=span rather than in `metrics`,
    // so it is a measure no registry can declare and every span has
    if (spec.kind === TelemetryKind.Span) {
      for (const op of RAW_OPS) {
        measures.push({ key: `${op}:durationMs`, metric: 'durationMs', exactVia: [] });
      }
    }

    events[name] = {
      kind: spec.kind,
      origin: spec.origin,
      subjects: [...spec.subjects],
      description: spec.description,
      namespace,
      dims,
      measures,
      families: eventFamilies,
      indexedAttrs,
      indexedMetrics: [...(spec.indexedMetrics ?? [])],
      // `hasOwnProperty` rather than `??`, exactly as model.ts stamps expiresAt:
      // an explicit `retentionDays: null` means immortal and must not fall
      // through to the per-kind default
      retentionDays: Object.prototype.hasOwnProperty.call(spec, 'retentionDays')
        ? spec.retentionDays ?? null
        : RETENTION_DAYS[spec.kind],
    };
  }

  return { events, families, namespaces, envelope: envelopeDims(platforms), subjectTypes };
}

/**
 * The catalog, narrowed back to the projection `/api/registry` and
 * `describe_telemetry` have always returned. It exists so that adding the
 * catalog costs the SPA nothing: the `registry` key keeps its exact shape while
 * `catalog` arrives beside it.
 *
 * One nuance the old per-event code did not have: `sum` is read off the FAMILY,
 * so two names feeding one family with different `sum` lists both report the
 * union. That is the more useful answer — it is what the family's docs actually
 * accumulate — and validateRegistry already forbids the mismatches that would
 * matter (`by`, `bucket`, `subjects`).
 */
export function projectRegistry(catalog: Catalog): RegistryProjection {
  return Object.fromEntries(
    Object.entries(catalog.events).map(([name, e]) => [
      name,
      {
        kind: e.kind,
        origin: e.origin,
        subjects: e.subjects,
        description: e.description,
        attrKeys: e.dims.filter((d) => d.key.startsWith('attr:')).map((d) => d.label),
        // every metric key gets exactly one `sum:` measure and nothing else does
        metricKeys: e.measures.filter((m) => m.key.startsWith('sum:')).map((m) => m.metric!),
        indexedAttrs: e.indexedAttrs,
        indexedMetrics: e.indexedMetrics,
        rollups: e.families.map((as) => {
          const f = catalog.families[as]!;
          return { as: f.as, by: f.by, bucket: f.bucket, sum: f.sums, subjects: f.subjectTypes };
        }),
      },
    ]),
  );
}
