import { Schema, type Connection, type Model } from 'mongoose';
import {
  TelemetryKind, LogLevel, Env, Origin,
  RETENTION_DAYS, SCHEMA_VERSION, UNKNOWN, newId,
  type TelemetryCounters,
} from './types.js';
import type { Registry } from './registry.js';

/** Mongoose Map keys cannot contain dots. gen_ai.request.model -> gen_ai_request_model */
const safeKey = (k: string) => k.replace(/\./g, '_');
const sanitize = <T>(m?: Map<string, T>) =>
  m ? new Map([...m].map(([k, v]) => [safeKey(k), v] as [string, T])) : m;

// ── subdocs ─────────────────────────────────────────────────────────────────

const SubjectRefSchema = new Schema(
  {
    type: { type: String, required: true }, // user | org | team | session
    id: { type: String, required: true },
    /** disambiguates same-type parties: sender | recipient | impersonated */
    role: { type: String },
  },
  { _id: false },
);

const ClientContextSchema = new Schema(
  {
    platform: { type: String, required: true, enum: ['web', 'electron', 'ios', 'android', 'server', 'cli'] },
    appVersion: { type: String, required: true },
    userAgent: String,
    os: String,
    osVersion: String,
    browser: String,
    browserVersion: String,
    deviceType: String, // desktop | mobile | tablet
    locale: String,
    timezone: String,
    screenW: Number,
    screenH: Number,
    viewportW: Number,
    viewportH: Number,
    connection: String, // 4g | wifi | slow-2g
    online: Boolean,
    /** client clock minus server clock, ms — client timestamps lie */
    clockSkewMs: Number,
  },
  { _id: false },
);

const StackFrameSchema = new Schema(
  {
    filename: String,
    fn: String,
    lineno: Number,
    colno: Number,
    inApp: Boolean,
    context: [String],
  },
  { _id: false },
);

const ErrorDetailSchema = new Schema(
  {
    type: { type: String, required: true },
    message: { type: String, required: true },
    handled: { type: Boolean, required: true, default: false },
    /** grouping key */
    fingerprint: { type: String, required: true },
    frames: [StackFrameSchema],
  },
  { _id: false },
);

const StateDetailSchema = new Schema(
  {
    key: { type: String, required: true }, // 'lifecycle' | 'onboarding_step'
    from: String,
    to: { type: String, required: true },
    /** how long the subject sat in `from` — answers "where do they stall" */
    previousSinceMs: Number,
  },
  { _id: false },
);

const UsageDetailSchema = new Schema(
  {
    meter: { type: String, required: true },
    quantity: { type: Number, required: true },
    unit: { type: String, required: true },
    /**
     * Authoritative money. `metrics.cost_usd` is a BSON double — fine as a
     * measure, wrong as the thing that becomes an invoice. Money is
     * authoritative only on kind=usage; the metric is a lossy copy.
     */
    amount: Schema.Types.Decimal128,
    currency: String,
    /** at-least-once dedupe. Deterministic, e.g. `${traceId}:${spanId}` */
    idempotencyKey: { type: String, required: true },
    /** who pays — 'org:o_9'. Distinct from subject and from actor. */
    billedTo: { type: String, required: true },
    billable: { type: Boolean, required: true, default: true },
    priceVersion: String,
    /** corrections are new reversing rows; never UPDATE a billed row */
    reverses: String,
  },
  { _id: false },
);

// ── base schema ─────────────────────────────────────────────────────────────

function buildBaseSchema(collection: string, registry: Registry, counters: TelemetryCounters) {
  const schema = new Schema(
    {
      /** UUIDv7 — sortable, insertion-local, replaces the ObjectId */
      _id: { type: String, required: true },
      schemaVersion: { type: Number, required: true },
      occurredAt: { type: Date, required: true },
      name: { type: String, required: true },
      severity: { type: String, required: true, enum: Object.values(LogLevel), default: LogLevel.Info },

      // ── identity ──
      /** tenancy root: shard key, access boundary, index prefix. The only promoted id. */
      tenantId: { type: String, required: true },
      /** multi-party capable: two users, sender/recipient, admin+impersonated */
      subjects: { type: [SubjectRefSchema], default: [] },
      /** derived: ['user:u_1','org:o_9'] */
      subjectKeys: { type: [String] },
      /** who caused it */
      actor: String,
      /** impersonation / delegation */
      onBehalfOf: String,
      /** derived: actor/onBehalfOf NOT already in subjects. Erasure completeness. */
      otherPrincipals: { type: [String] },

      // ── origin — required, but filled by the pre-validate hook, NEVER `default:`.
      // A schema default is applied at construction, before the hook, which would
      // silently stamp dev traffic as prod and pin counters.defaulted at zero
      // forever (schema §7 / ops rule 5).
      service: { type: String, required: true },
      release: { type: String, required: true },
      env: { type: String, required: true, enum: Object.values(Env) },

      origin: { type: String, enum: Object.values(Origin), default: Origin.Server },
      /** required for client-origin events (enforced by the registry hook, not the schema) */
      client: ClientContextSchema,

      // ── correlation ──
      traceId: String,
      spanId: String,
      parentId: String,
      durationMs: Number,

      // ── payload — no wildcard index; registry-driven indexes instead (§4.4) ──
      /** STRING VALUES ONLY — Mongoose casts on assignment. Numbers belong in metrics. */
      attrs: { type: Map, of: String, default: {} },
      metrics: { type: Map, of: Number, default: {} },
      /** only stored when the registry declares a schema for it */
      data: { type: Schema.Types.Mixed },
      body: String,

      // ── ops ──
      /** 1 = kept everything. 0.05 = multiply counts by 20 when aggregating. */
      sampleRate: { type: Number, default: 1 },
      /** kept despite sampling (carried money or an error). NOT representative. */
      forced: { type: Boolean, default: false },
      expiresAt: Date,
      /** set by forget() — row survives, identifiers do not */
      redactedAt: Date,
    },
    {
      collection,
      discriminatorKey: 'kind',
      timestamps: { createdAt: 'receivedAt', updatedAt: false },
      versionKey: false,
      minimize: false,
    },
  );

  // every subject, tenant-scoped and time-sorted, from ONE multikey compound
  // index — explain()-verified 2026-08-10 (schema §2.5)
  schema.index({ tenantId: 1, subjectKeys: 1, occurredAt: -1 });
  schema.index({ tenantId: 1, kind: 1, name: 1, occurredAt: -1 });
  schema.index(
    { traceId: 1, occurredAt: 1 },
    { partialFilterExpression: { traceId: { $exists: true } } },
  );
  // erasure completeness — usually a tiny array, so cheap to maintain.
  // `.0 $exists` = "array non-empty"; `$ne: []` is illegal in a partial filter.
  schema.index(
    { tenantId: 1, otherPrincipals: 1 },
    { partialFilterExpression: { 'otherPrincipals.0': { $exists: true } } },
  );
  // partial: usage rows have no expiresAt and must not be indexed as null
  schema.index(
    { expiresAt: 1 },
    { expireAfterSeconds: 0, partialFilterExpression: { expiresAt: { $exists: true } } },
  );

  schema.pre('validate', function (this: any) {
    this._id ??= newId();
    this.schemaVersion ??= SCHEMA_VERSION;
    this.occurredAt ??= new Date();

    this.attrs = sanitize(this.attrs);
    this.metrics = sanitize(this.metrics);

    // ── derived identity arrays ──
    const refs: string[] = (this.subjects ?? []).map((s: any) => `${s.type}:${s.id}`);
    this.subjectKeys = [...new Set(refs)];
    this.otherPrincipals = [
      ...new Set(
        [this.actor, this.onBehalfOf].filter((r): r is string => !!r && !refs.includes(r)),
      ),
    ];

    // Never fail on missing origin metadata — default and COUNT.
    for (const f of ['service', 'release'] as const) {
      if (!this[f]) {
        this[f] = UNKNOWN;
        counters.defaulted++;
      }
    }
    if (!this.env) {
      this.env = process.env.NODE_ENV === 'production' ? Env.Prod : Env.Dev;
    }

    const spec = registry[this.name];
    if (!spec) throw new Error(`telemetry: unregistered event "${this.name}"`);
    if (spec.kind !== this.kind) throw new Error(`telemetry: "${this.name}" is kind=${spec.kind}`);

    // retention: per-event override, else per-kind. `in` rather than `??` so an
    // explicit `retentionDays: null` means immortal.
    const days = 'retentionDays' in spec ? spec.retentionDays : RETENTION_DAYS[this.kind as TelemetryKind];
    if (days != null && !this.expiresAt) {
      this.expiresAt = new Date(this.occurredAt.getTime() + days * 864e5);
    }

    const haveTypes = new Set((this.subjects ?? []).map((s: any) => s.type));
    for (const t of spec.subjects) {
      if (!haveTypes.has(t)) throw new Error(`telemetry: "${this.name}" requires subject "${t}"`);
    }
    if (spec.origin === Origin.Client && !this.client) {
      throw new Error(`telemetry: "${this.name}" is client-origin and requires client context`);
    }

    // per-kind requiredness lives HERE so the guarantee never depends on how a
    // particular mongoose version merges discriminator schema requiredness
    if (this.kind === TelemetryKind.Span) {
      for (const f of ['traceId', 'spanId'] as const) {
        if (!this[f]) throw new Error(`telemetry: span requires ${f}`);
      }
      if (typeof this.durationMs !== 'number') throw new Error('telemetry: span requires durationMs');
    }
    if (this.kind === TelemetryKind.State && !this.state?.to) {
      throw new Error('telemetry: state requires state.to');
    }

    const check = (label: string, m: Map<string, unknown> | undefined, zschema?: any) => {
      const obj = Object.fromEntries(m ?? []);
      if (!zschema) {
        if (Object.keys(obj).length) throw new Error(`telemetry: "${this.name}" declares no ${label}`);
        return;
      }
      const s = zschema.strict?.() ?? zschema;
      const r = s.safeParse(obj);
      if (!r.success) throw new Error(`telemetry: ${label} invalid for "${this.name}": ${r.error.message}`);
    };
    check('attrs', this.attrs, spec.attrs);
    check('metrics', this.metrics, spec.metrics);

    // `data` is dropped unless the registry declares a schema for it. This is
    // what makes delete-by-subject a guarantee rather than best-effort.
    if (this.data != null) {
      const s: any = spec.data;
      if (!s) {
        this.data = undefined;
        counters.rejected++;
      } else {
        const strict = s.strict?.() ?? s;
        const r = strict.safeParse(this.data);
        if (!r.success) throw new Error(`telemetry: data invalid for "${this.name}": ${r.error.message}`);
        if (r.data === undefined) counters.rejected++; // boundedMeta out-of-bounds: drop whole, never truncate
        this.data = r.data;
      }
    }
  });

  return schema;
}

// ── discriminators ──────────────────────────────────────────────────────────

export interface TelemetryModels {
  /** the base model — query across every kind */
  TelemetryModel: Model<any>;
  /** per-kind discriminator models */
  byKind: Record<TelemetryKind, Model<any>>;
}

/**
 * Model factory. Mongoose keeps compiled models in a per-connection registry,
 * so a name collision throws OverwriteModelError. Reuse an already-compiled
 * model when the name is taken (standards/traps.md #2) — but note the caveat:
 * the reused model closed over the FIRST instance's registry and counters.
 * Hosts running two registries on one connection must set distinct modelNames.
 */
export function buildTelemetryModels(opts: {
  connection: Connection;
  registry: Registry;
  counters: TelemetryCounters;
  modelName: string;
  collection: string;
}): TelemetryModels {
  const { connection, registry, counters, modelName, collection } = opts;

  const existing = connection.models?.[modelName];
  if (existing) {
    return {
      TelemetryModel: existing,
      byKind: Object.fromEntries(
        Object.values(TelemetryKind).map((k) => [k, (existing.discriminators ?? {})[`${modelName}_${k}`] ?? existing]),
      ) as Record<TelemetryKind, Model<any>>,
    };
  }

  const base = buildBaseSchema(collection, registry, counters);
  const TelemetryModel = connection.model(modelName, base);

  const disc = (kind: TelemetryKind, build: () => Schema) =>
    TelemetryModel.discriminator(`${modelName}_${kind}`, build(), kind);

  const byKind: Record<TelemetryKind, Model<any>> = {
    [TelemetryKind.Event]: disc(TelemetryKind.Event, () => new Schema({})), // envelope suffices

    [TelemetryKind.Error]: disc(TelemetryKind.Error, () => {
      const s = new Schema({ error: { type: ErrorDetailSchema, required: true } });
      s.index(
        { tenantId: 1, 'error.fingerprint': 1, occurredAt: -1 },
        { partialFilterExpression: { kind: TelemetryKind.Error } },
      );
      return s;
    }),

    [TelemetryKind.Span]: disc(TelemetryKind.Span, () => {
      // traceId/spanId/durationMs requiredness enforced in the pre-validate hook
      const s = new Schema({});
      s.index(
        { traceId: 1, parentId: 1 },
        { partialFilterExpression: { kind: TelemetryKind.Span } },
      );
      return s;
    }),

    [TelemetryKind.State]: disc(TelemetryKind.State, () => {
      const s = new Schema({ state: { type: StateDetailSchema, required: true } });
      s.index(
        { tenantId: 1, 'state.key': 1, 'state.to': 1, occurredAt: -1 },
        { partialFilterExpression: { kind: TelemetryKind.State } },
      );
      return s;
    }),

    [TelemetryKind.Usage]: disc(TelemetryKind.Usage, () => {
      const s = new Schema({ usage: { type: UsageDetailSchema, required: true } });
      // partialFilterExpression is load-bearing: discriminator indexes apply to
      // the WHOLE collection, so without it every non-usage doc indexes
      // idempotencyKey as null and the second one collides (ops rule 4)
      s.index(
        { 'usage.idempotencyKey': 1 },
        { unique: true, partialFilterExpression: { kind: TelemetryKind.Usage } },
      );
      s.index(
        { tenantId: 1, 'usage.meter': 1, occurredAt: 1 },
        { partialFilterExpression: { kind: TelemetryKind.Usage } },
      );
      return s;
    }),
  };

  return { TelemetryModel, byKind };
}
