import type { Collection, Connection } from 'mongoose';
import { newCounters, noopLogger, type EntityRef, type Logger } from './types.js';
import { validateRegistry, type Registry } from './registry.js';
import { buildTelemetryModels } from './model.js';
import { buildRollupModel } from './rollups.js';
import { buildCheckpointModel, createCheckpointFactory } from './checkpoint.js';
import { createEmitter, type EmitInput } from './emit.js';
import { createForget } from './forget.js';
import { createSyncIndexes } from './indexes.js';

export { defineRegistry, boundedMeta, validateRegistry } from './registry.js';
export type { Registry, EventSpec, RollupSpec, DimSource } from './registry.js';
export {
  TelemetryKind, LogLevel, Env, Origin,
  RETENTION_DAYS, SAMPLE_RATE, SCHEMA_VERSION,
  newId, traceKeep, plain,
} from './types.js';
export type { TelemetryCounters, Logger, EntityRef } from './types.js';
export { INDEX_BUDGET } from './indexes.js';
export { truncate, resolveDim } from './rollups.js';
export type { ForgetResult } from './forget.js';
export type { Checkpoint } from './checkpoint.js';
export type { EmitInput } from './emit.js';

export interface CreateTelemetryConfig {
  /** the host-owned event registry — see defineRegistry() */
  registry: Registry;
  /** a mongoose Connection, or the mongoose module itself (its default connection is used) */
  connection: Connection | { connection: Connection };
  /** base collection name; siblings derive from it: `<collection>_rollups`, `_rejects`, `_aliases`, `_checkpoints` */
  collection?: string;
  /**
   * Mongoose model name. Set it when two instances share one connection —
   * a reused name silently reuses the FIRST instance's registry (traps #2).
   */
  modelName?: string;
  /** secret pepper for forget()'s pseudonymous rekeying. Falls back to TELEMETRY_PEPPER. */
  pepper?: string;
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

  const conn: Connection =
    (config.connection as { connection: Connection }).connection ??
    (config.connection as Connection);

  const counters = newCounters();
  const { TelemetryModel, byKind } = buildTelemetryModels({
    connection: conn, registry, counters, modelName, collection,
  });
  const RollupModel = buildRollupModel(conn, `${modelName}Rollup`, `${collection}_rollups`);
  const CheckpointModel = buildCheckpointModel(conn, `${modelName}Checkpoint`, `${collection}_checkpoints`);

  const rejects = () => conn.db!.collection(`${collection}_rejects`);
  const aliases = () => conn.db!.collection(`${collection}_aliases`);

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
    pepper: () => {
      const p = config.pepper ?? process.env.TELEMETRY_PEPPER;
      if (!p) {
        throw new Error(
          'telemetry: forget() needs a pepper — pass `pepper` to createTelemetry() or set TELEMETRY_PEPPER',
        );
      }
      return p;
    },
  });

  const syncIndexes = createSyncIndexes({
    registry,
    TelemetryModel,
    models: [TelemetryModel, ...Object.values(byKind), RollupModel, CheckpointModel],
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
    /** the models, exposed for hosts and the router factories */
    models: { telemetry: TelemetryModel, byKind, rollups: RollupModel, checkpoints: CheckpointModel },
    /** side collections (rejects/aliases live outside mongoose models) */
    collections: { rejects, aliases },
  };
}

export type Telemetry = ReturnType<typeof createTelemetry>;
