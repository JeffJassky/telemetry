import type { Collection, Connection } from 'mongoose';
import { RETENTION_DAYS, newCounters, noopLogger, type EntityRef, type Logger } from './types.js';
import { validateRegistry, type Registry } from './registry.js';
import { buildTelemetryModels } from './model.js';
import { buildRollupModel } from './rollups.js';
import { buildCheckpointModel, createCheckpointFactory } from './checkpoint.js';
import { createEmitter, type EmitInput } from './emit.js';
import { createForget } from './forget.js';
import { createSyncIndexes } from './indexes.js';
import { buildKeyModel, createKey, type CreateKeyInput } from './keys.js';

export { defineRegistry, boundedMeta, validateRegistry } from './registry.js';
export type { Registry, EventSpec, RollupSpec, DimSource } from './registry.js';
export {
  TelemetryKind, LogLevel, Env, Origin,
  BODY_MAX_CHARS, PLATFORM_SCOPE, RETENTION_DAYS, SAMPLE_RATE, SCHEMA_VERSION,
  isPlatformScope, newId, traceKeep, plain,
} from './types.js';
export type { TelemetryCounters, Logger, EntityRef } from './types.js';
export { INDEX_BUDGET } from './indexes.js';
export { truncate, resolveDim } from './rollups.js';
export type { ForgetResult } from './forget.js';
export type { Checkpoint } from './checkpoint.js';
export type { EmitInput, EmitResult } from './emit.js';
export { KeyKind, TenantMode, parseKeyString, hashSecret, verifySecret, createKey } from './keys.js';
export type { CreateKeyInput, ParsedKey } from './keys.js';
export { createIngest } from './ingest.js';
export type { ContextAdapter, CreateIngestOptions, IngestContext } from './ingest.js';
export { createDashboard, defaultSpaDir } from './dashboard.js';
export type {
  CreateDashboardOptions, SubjectAdapter, Viewer, ViewerAdapter,
} from './dashboard.js';
export { createQueries, DEFAULT_LIMITS } from './query.js';
export type { Queries, QueryLimits, RecordFilter, TimeRange } from './query.js';
export { median, summarizeStages, findFamily, requireMilestoneFamily } from './funnel.js';
export type {
  CohortSubject, FunnelCohortWindow, FunnelExitResult, FunnelParams,
  FunnelResult, FunnelSlice, FunnelStageResult, FunnelStageSpec,
} from './funnel.js';
export { deriveViews } from './views.js';
export type { ResolvedView, ViewSpec } from './views.js';

export interface CreateTelemetryConfig {
  /** the host-owned event registry — see defineRegistry() */
  registry: Registry;
  /** a mongoose Connection, or the mongoose module itself (its default connection is used) */
  connection: Connection | { connection: Connection };
  /** base collection name; six siblings derive from it: `<collection>_rollups`,
   *  `_rejects`, `_aliases`, `_checkpoints`, `_keys`, `_views` */
  collection?: string;
  /**
   * Mongoose model name. Set it when two instances share one connection —
   * a reused name silently reuses the FIRST instance's registry (traps #2).
   */
  modelName?: string;
  /** secret pepper for forget()'s pseudonymous rekeying. Falls back to TELEMETRY_PEPPER. */
  pepper?: string;
  /**
   * Host additions to `client.platform`. EXTENDS the builtin list
   * ['web','electron','ios','android','server','cli'] — a host adding 'watchos'
   * keeps 'web'.
   */
  platforms?: readonly string[];
  /** override BODY_MAX_CHARS for this instance */
  bodyMax?: number;
  /**
   * Declares that a subject ref (`type:id`) names the same party in EVERY
   * tenant. The package cannot verify that, so it is asserted rather than
   * detected. Only effect today: forget() also erases the person's
   * platform-scoped saved views, which a tenant-scoped call otherwise misses.
   * Leave it off when ids are minted per tenant — there, `user:u_1` is a
   * different person in each and one tenant's erasure would reach another's.
   */
  globalSubjectRefs?: boolean;
  logger?: Logger;
}

/**
 * The package factory. Returns the write path, erasure, tenant-scoped reads,
 * and the checkpoint primitive. Routers (ingest, dashboard) are separate
 * factories that take this instance — they never build their own storage.
 *
 *   const t = createTelemetry({ registry, connection: mongoose })
 *   await t.syncIndexes()                  // boot: indexes + TTLs, awaited before first write
 *   await t.emit('user.signed_up', { tenantId, subjects: [...], attrs: {...} })
 */
export function createTelemetry(config: CreateTelemetryConfig) {
  const {
    registry,
    collection = 'telemetry',
    modelName = 'Telemetry',
    logger = noopLogger,
  } = config;

  // boot-time contract checks — misconfiguration fails deploy, not dashboards
  validateRegistry(registry);

  // A spec declaring `data` and no retentionDays inherits RETENTION_DAYS[kind],
  // so evidence a host went out of its way to declare gets a fuse nobody chose
  // — and `expiresAt` is stamped per row at WRITE time, so it is unrecoverable
  // after the fact. Warn once at boot. An explicit retentionDays (including
  // `null` for immortal) is a choice and silences this; the warning is about
  // the host not having made one.
  for (const [name, spec] of Object.entries(registry)) {
    if (!spec.data) continue;
    if (Object.prototype.hasOwnProperty.call(spec, 'retentionDays')) continue;
    const days = RETENTION_DAYS[spec.kind];
    if (days == null) continue;
    logger.warn(
      `[telemetry] "${name}" declares \`data\` but inherits retentionDays=${days} from kind=${spec.kind} — ` +
      `its payloads are stamped to expire in ${days} days, and that cannot be undone after the write. ` +
      `Set an explicit retentionDays (null = immortal) to choose, and to silence this.`,
    );
  }

  const conn: Connection =
    (config.connection as { connection: Connection }).connection ??
    (config.connection as Connection);

  const counters = newCounters();
  const { TelemetryModel, byKind } = buildTelemetryModels({
    connection: conn, registry, counters, modelName, collection,
    platforms: config.platforms, bodyMax: config.bodyMax,
  });
  const RollupModel = buildRollupModel(conn, `${modelName}Rollup`, `${collection}_rollups`);
  const CheckpointModel = buildCheckpointModel(conn, `${modelName}Checkpoint`, `${collection}_checkpoints`);
  const KeyModel = buildKeyModel(conn, `${modelName}Key`, `${collection}_keys`);

  const rejects = () => conn.db!.collection(`${collection}_rejects`);
  const aliases = () => conn.db!.collection(`${collection}_aliases`);
  const views = () => conn.db!.collection(`${collection}_views`);

  // fire-and-forget writes are tracked so flush() can await stragglers —
  // tests and SIGTERM handlers both need "everything emitted is queryable"
  const inFlight = new Set<Promise<unknown>>();
  const track = (p: Promise<unknown>) => {
    inFlight.add(p);
    void p.finally(() => inFlight.delete(p));
  };

  const emit = createEmitter({ registry, byKind, RollupModel, rejects, counters, logger, track });

  const forget = createForget({
    TelemetryModel,
    RollupModel,
    rejects: rejects as () => Collection,
    aliases: aliases as () => Collection,
    views: views as () => Collection,
    pepper: () => {
      const p = config.pepper ?? process.env.TELEMETRY_PEPPER;
      if (!p) {
        throw new Error(
          'telemetry: forget() needs a pepper — pass `pepper` to createTelemetry() or set TELEMETRY_PEPPER',
        );
      }
      return p;
    },
    globalSubjectRefs: () => config.globalSubjectRefs === true,
  });

  const syncIndexes = createSyncIndexes({
    registry,
    TelemetryModel,
    models: [TelemetryModel, ...Object.values(byKind), RollupModel, CheckpointModel, KeyModel],
    rejects: rejects as () => Collection,
  });

  return {
    /** write — the only write */
    emit,
    /** erasure: delete sole-party rows, redact shared ones, rekey rollups, drop aliases */
    forget,
    /**
     * Tenant scope is not optional — force every read through here. The five
     * dashboard query primitives (records/series/distribution/rollups/journey)
     * build on these in the read layer.
     *
     * scoped() does NOT know about PLATFORM_SCOPE, and the omission is
     * deliberate. This is the host-facing isolation primitive, and its
     * guarantee is worth more unconditional: whatever string goes in, only rows
     * carrying that string come out. `scoped('*')` therefore scopes to the
     * literal '*' — and since '*' is reserved on the write side, it matches
     * nothing. The cross-tenant escape hatch lives one layer up, in the query
     * primitives behind viewerAdapter, where an authorization decision has
     * actually been made about who is asking.
     */
    scoped(tenantId: string) {
      // the pin spreads LAST — `{ tenantId, ...q }` would let a caller-supplied
      // tenantId in q override the scope, the exact hole scoped() exists to close
      return {
        find: (q: Record<string, unknown> = {}) => TelemetryModel.find({ ...q, tenantId }),
        aggregate: (stages: Record<string, unknown>[]) =>
          TelemetryModel.aggregate([{ $match: { tenantId } }, ...stages] as any[]),
        rollups: (q: Record<string, unknown> = {}) => RollupModel.find({ ...q, tenantId }),
        rollupAggregate: (stages: Record<string, unknown>[]) =>
          RollupModel.aggregate([{ $match: { tenantId } }, ...stages] as any[]),
      };
    },
    /** pull-importer watermark — advisory; downstream writers must be idempotent */
    checkpoint: createCheckpointFactory(CheckpointModel, logger),
    /** boot: build declared + registry-driven indexes, await before first write */
    syncIndexes,
    /** await in-flight fire-and-forget writes (tests, graceful shutdown) */
    async flush() {
      while (inFlight.size) await Promise.allSettled([...inFlight]);
    },
    /** drop/default/cap counts — surface on /metrics so drops are never silent */
    counters,
    /** the registry, exposed for the router factories — hosts should import their own */
    registry,
    logger,
    /** mint an ingest key; the full key string is returned once, never again */
    createKey: (input: CreateKeyInput) => createKey(KeyModel, input),
    /** the models, exposed for hosts and the router factories */
    models: {
      telemetry: TelemetryModel,
      byKind,
      rollups: RollupModel,
      checkpoints: CheckpointModel,
      keys: KeyModel,
    },
    /** side collections (rejects/aliases live outside mongoose models) */
    collections: { rejects, aliases },
  };
}

export type Telemetry = ReturnType<typeof createTelemetry>;
