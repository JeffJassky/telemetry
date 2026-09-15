import type { Collection, Connection } from 'mongoose';
import { RETENTION_DAYS, newCounters, noopLogger, type EntityRef, type Logger } from './types.js';
import { validateRegistry, type Registry } from './registry.js';
import { buildTelemetryModels } from './model.js';
import { buildRollupModel } from './rollups.js';
import { buildCheckpointModel, createCheckpointFactory } from './checkpoint.js';
import { createEmitter, createSubjectLinking, type EmitInput, type SubjectLinker } from './emit.js';
import { createForget } from './forget.js';
import { createRelink } from './relink.js';
import { createSyncIndexes } from './indexes.js';
import { createCaptureError } from './capture-error.js';
import { createSourcemaps } from './sourcemaps.js';
import { buildKeyModel, createKey, type CreateKeyInput } from './keys.js';

export { defineRegistry, boundedMeta, validateRegistry } from './registry.js';
export type { Registry, EventSpec, RollupSpec, DimSource } from './registry.js';
export {
  TelemetryKind, LogLevel, Env, Origin,
  BODY_MAX_CHARS, COUNTER_MAP_MAX, COUNTER_OVERFLOW_KEY, PLATFORM_SCOPE, RETENTION_DAYS,
  SAMPLE_RATE, SCHEMA_VERSION,
  isPlatformScope, newId, traceKeep, plain,
} from './types.js';
export type { TelemetryCounters, Logger, EntityRef, ValidationPolicy } from './types.js';
import type { ValidationPolicy } from './types.js';
export { INDEX_BUDGET } from './indexes.js';
export { truncate, resolveDim } from './rollups.js';
export type { ForgetResult } from './forget.js';
export { RELINK_BATCH_SIZE } from './relink.js';
export type { RelinkOptions, RelinkResult } from './relink.js';
export type { Checkpoint } from './checkpoint.js';
export { SUBJECT_MAX, SUBJECT_LINK_TIMEOUT_MS } from './emit.js';
export type { EmitInput, EmitResult, LinkSubjects, SubjectLinker } from './emit.js';
export type { CaptureErrorOptions } from './capture-error.js';
export { parseFrames, fingerprint, normalizeMessage, describeError, coerceError } from '../client/errors.js';
export type { ErrorDetail, ErrorFrame } from '../client/errors.js';
export { KeyKind, TenantMode, parseKeyString, hashSecret, verifySecret, createKey } from './keys.js';
export type { CreateKeyInput, ParsedKey } from './keys.js';
export { createIngest } from './ingest.js';
export type { ContextAdapter, CreateIngestOptions, IngestContext } from './ingest.js';
export { createDashboard, defaultSpaDir } from './dashboard.js';
export type {
  CreateDashboardOptions, SubjectAdapter, Viewer, ViewerAdapter,
} from './dashboard.js';
export { deriveCatalog, projectRegistry } from './catalog.js';
export type {
  Catalog, DeriveCatalogOptions, DimFacet, EventFacet, FamilyFacet, MeasureFacet,
  RegistryProjection, RegistryProjectionEntry,
} from './catalog.js';
export { deriveSuggestions, MAX_SUGGESTIONS } from './suggest.js';
export type { DeriveSuggestionsInput, Suggestion } from './suggest.js';
export { createQueries, DEFAULT_LIMITS } from './query.js';
export type { Queries, QueryLimits, RecordFilter, TimeRange } from './query.js';
export { createValues } from './values.js';
export type { Values, ValuesCtx, ValuesParams, ValuesResult } from './values.js';
export { median, summarizeStages, findFamily, requireMilestoneFamily } from './funnel.js';
export type {
  CohortSubject, FunnelCohortWindow, FunnelExitResult, FunnelParams,
  FunnelResult, FunnelSlice, FunnelStageResult, FunnelStageSpec,
} from './funnel.js';
export { deriveViews } from './views.js';
export type { ResolvedView, ViewSpec } from './views.js';
export {
  intervalForRange, normalizeQuery, parseReportQuery, rangeOf, reportToQuery, resolveReport,
} from './report.js';
export type {
  LegacyQuery, Plan, PlanPrimitive, PlanShape, Report, ReportFilter, ReportRange,
  ReportSource, ResolveOptions, Unavailable,
} from './report.js';
export { executeReport, foldRollups } from './execute.js';
export type { ExecuteOptions, FoldedRollups, ReportResult, RollupDoc } from './execute.js';

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
   * What a vocabulary mismatch costs. Default `'lenient'`: an attr or metric
   * the registry does not accept is stripped, counted by name in
   * `counters.attrsDropped` / `counters.metricsDropped`, and the record is
   * written. `'strict'` restores the pre-0.7.0 behaviour of quarantining the
   * whole record. See ValidationPolicy in types.ts for why the default moved.
   */
  validation?: ValidationPolicy;
  /**
   * Declares that a subject ref (`type:id`) names the same party in EVERY
   * tenant. The package cannot verify that, so it is asserted rather than
   * detected. Only effect today: forget() also erases the person's
   * platform-scoped saved views, which a tenant-scoped call otherwise misses.
   * Leave it off when ids are minted per tenant — there, `user:u_1` is a
   * different person in each and one tenant's erasure would reach another's.
   */
  globalSubjectRefs?: boolean;
  /**
   * Attach additional subjects to a record AT WRITE TIME — the desktop
   * `machine:<installId>` that the host can resolve to a `user`, joined once,
   * onto the row and its rollups, instead of at every read that ever wants it.
   *
   * See SubjectLinker in emit.ts for what it must not do. In one line: it must
   * be cached, because it runs once per record on the ingest path, and it can
   * never fail a write — a slow or broken linker costs records their link, not
   * their existence.
   */
  subjectLinker?: SubjectLinker;
  /**
   * What `subjectLinker.link()` gets per record before the write proceeds
   * UNLINKED and counts a timeout. Default 50ms. Raise it only if you have
   * measured the resolver; the default is chosen so a host outage degrades
   * telemetry rather than stalling ingest behind it.
   */
  subjectLinkTimeoutMs?: number;
  /**
   * Server-side `captureError()` defaults. `errorName` is the registry name it
   * writes (default `'error.unhandled'`); `errorAttrs` is stamped under every
   * call's attrs, e.g. `{ process: 'api' }`; `redact` runs on every string —
   * message, frame filenames, attr values — before the write, and a throwing
   * redact drops the record rather than shipping it unredacted.
   */
  captureError?: {
    errorName?: string;
    errorAttrs?: Record<string, string>;
    redact?: (text: string) => string;
  };
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
    platforms: config.platforms, bodyMax: config.bodyMax, validation: config.validation,
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

  // Resolved ONCE, and shared with the ingest router below rather than built
  // twice: the linker is a policy (dedupe, the declared-type refusal, the cap,
  // the timeout), and a policy that exists in two places is two policies.
  const linkSubjects = createSubjectLinking({
    linker: config.subjectLinker,
    timeoutMs: config.subjectLinkTimeoutMs,
    counters,
    logger,
  });

  const emit = createEmitter({
    registry, byKind, RollupModel, rejects, counters, logger, track, linkSubjects,
  });

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

  // The BACKFILL half of subject linking, and it takes the same `linkSubjects`
  // the write path uses rather than a merge of its own — see relink.ts for why
  // a second copy of those rules would be unreconcilable rather than merely
  // duplicated.
  const relink = createRelink({
    registry, TelemetryModel, RollupModel, counters, logger, linkSubjects,
  });

  const syncModelIndexes = createSyncIndexes({
    registry,
    TelemetryModel,
    models: [TelemetryModel, ...Object.values(byKind), RollupModel, CheckpointModel, KeyModel],
    rejects: rejects as () => Collection,
  });

  const captureError = createCaptureError({
    emit: (name, doc) => emit(name, doc),
    errorName: config.captureError?.errorName,
    errorAttrs: config.captureError?.errorAttrs,
    redact: config.captureError?.redact,
    logger,
  });

  const sourcemaps = createSourcemaps({ connection: conn, collection: `${collection}_sourcemaps`, logger });

  const syncIndexes: typeof syncModelIndexes = async (...args) => {
    const result = await syncModelIndexes(...args);
    await sourcemaps.ensureIndexes();
    return result;
  };

  return {
    /** write — the only write */
    emit,
    /**
     * A thrown value → an `error`-kind record through `emit()`, shaped by the
     * same frame parser and fingerprint every client uses. Trusted caller:
     * names its tenant, service, subjects. See capture-error.ts.
     */
    captureError,
    /** erasure: delete sole-party rows, redact shared ones, rekey rollups, drop aliases */
    forget,
    /**
     * Backfill: re-ask the `subjectLinker` about records ALREADY on disk, and
     * replay the rollups the new subjects reach.
     *
     * Linking happens at write time, so configuring it fixes the future and
     * nothing else — a lifetime `by:['subject']` family is keyed on the subject
     * the record was written with, and a read-time join cannot reach back into
     * it. This is how a host catches up the backlog it adopted the hook with.
     *
     * DRY RUN BY DEFAULT: it rewrites historical aggregates, so the short call
     * reports and the writing call says `{ dryRun: false }`. Idempotent by
     * construction — a row that already carries the linked subject yields
     * nothing new, so a second run is a no-op.
     */
    relink,
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
    /**
     * Write-time subject linking, exposed for the router factories. `null` when
     * no `subjectLinker` is configured.
     *
     * The wire path does not go through emit() — createIngest() builds its
     * record itself, because at-least-once delivery inverts the plane order
     * (insert first, THEN aggregate). So it reaches the linker the same way it
     * reaches the registry and the models: off the instance, running the one
     * implementation, rather than growing a second copy of the rules.
     */
    linkSubjects,
    logger,
    /**
     * Sourcemaps for minified clients. `register()` stores a release's maps
     * (server-side only — there is no HTTP route); the dashboard translates
     * error frames against them at read time, so errors recorded before the
     * maps were registered are translated too. See sourcemaps.ts.
     */
    sourcemaps,
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
