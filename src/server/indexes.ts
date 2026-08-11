import type { Collection, Model } from 'mongoose';
import { REJECT_TTL_DAYS } from './types.js';
import type { Registry } from './registry.js';

/**
 * Registry-driven payload indexes (schema §4.4) — replaces the wildcard. A
 * wildcard index cannot compound with tenantId (pre-Mongo 7.0), so any attr
 * query would scan across every tenant — both a perf problem and the exact
 * isolation hole scoped() exists to close. Attrs are bounded and declared, so
 * pay for targeted indexes instead of insert cost on everything.
 *
 * Every payload index is tenant-prefixed and time-sorted. The partial filter
 * pins `name`, so a query must include { name } to use it. Undeclared attrs
 * stay queryable via a $match on {tenantId, name, occurredAt} first — bounded,
 * no index needed, fine for ad-hoc at small-SaaS volume.
 */

/** Mongo caps a collection at 64 indexes. Base + discriminators use ~10. Budget the rest. */
export const INDEX_BUDGET = 24;

export interface SyncCtx {
  registry: Registry;
  TelemetryModel: Model<any>;
  models: Model<any>[];
  rejects: () => Collection;
}

export function createSyncIndexes(ctx: SyncCtx) {
  return async function syncIndexes(): Promise<void> {
    // Model.init() awaited before first write (traps #3): cold-DB writes racing
    // async index builds silently duplicate — the unique idempotency index and
    // deterministic rollup _ids depend on this.
    await Promise.all(ctx.models.map((m) => m.init()));

    // one generator, two payload maps — attrs (string equality) and metrics
    // (numeric range). Identical shape: tenant-prefixed, name-pinned, time-sorted.
    const plan = (name: string, kind: 'attr' | 'metric', key: string) => ({
      name: `${kind}_${name.replace(/\./g, '_')}_${key}`,
      keys: {
        tenantId: 1,
        [`${kind === 'attr' ? 'attrs' : 'metrics'}.${key}`]: 1,
        occurredAt: -1,
      } as Record<string, 1 | -1>,
      partial: { name }, // keeps each index to just that event's rows
    });
    const planned = Object.entries(ctx.registry).flatMap(([name, spec]) => [
      ...(spec.indexedAttrs ?? []).map((k) => plan(name, 'attr', k)),
      ...(spec.indexedMetrics ?? []).map((k) => plan(name, 'metric', k)),
    ]);

    const coll = ctx.TelemetryModel.collection;
    const plannedNames = new Set(planned.map((p) => p.name));

    // Drop orphans FIRST. If the budget check ran first, removing an entry to
    // get back under the cap would still throw, and the stale index would never
    // be dropped — unrecoverable without manual intervention.
    for (const ix of await coll.indexes()) {
      if (
        (ix.name?.startsWith('attr_') || ix.name?.startsWith('metric_')) &&
        !plannedNames.has(ix.name)
      ) {
        await coll.dropIndex(ix.name);
      }
    }

    if (planned.length > INDEX_BUDGET) {
      throw new Error(`telemetry: ${planned.length} payload indexes exceeds budget ${INDEX_BUDGET}`);
    }

    for (const p of planned) {
      await coll.createIndex(p.keys, {
        name: p.name,
        partialFilterExpression: p.partial,
        background: true,
      });
    }

    // quarantined rejects expire on their own — nothing bounds them otherwise
    await ctx.rejects().createIndex({ at: 1 }, { expireAfterSeconds: REJECT_TTL_DAYS * 86400 });
  };
}
