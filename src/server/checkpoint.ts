import { Schema, type Connection, type Model } from 'mongoose';
import type { Logger } from './types.js';

/**
 * Key→timestamp checkpoint store for pull-importers (ported from maxed's
 * checkpoint.ts — recon decision #3: primitive, not hook).
 *
 * Values are ADVISORY. Every writer downstream of a checkpoint must be
 * idempotent (client event ids, usage idempotency keys), so a checkpoint that
 * is stale, reset, or lost costs a re-scan — never a duplicate. That property
 * is what lets an importer rewind its watermark by a safety overlap every run.
 * Reads and writes therefore swallow errors: checkpoint failure must never
 * take the batch down.
 */

export function buildCheckpointModel(connection: Connection, modelName: string, collection: string): Model<any> {
  const existing = connection.models?.[modelName];
  if (existing) return existing;
  const schema = new Schema(
    {
      /** stable scanner name, e.g. "mailery-bridge" */
      key: { type: String, required: true, unique: true },
      /** high-water mark: the scanner has processed everything at/before this */
      at: { type: Date, required: true },
    },
    { collection, timestamps: { createdAt: false, updatedAt: true }, versionKey: false },
  );
  return connection.model(modelName, schema);
}

export interface Checkpoint {
  /** null on the first ever run — callers decide what "from the beginning" means */
  get(): Promise<Date | null>;
  advance(at: Date): Promise<void>;
}

export function createCheckpointFactory(CheckpointModel: Model<any>, logger: Logger) {
  return function checkpoint(key: string): Checkpoint {
    return {
      async get() {
        try {
          const doc = await CheckpointModel.findOne({ key }).lean();
          return (doc as any)?.at ?? null;
        } catch (err) {
          // read failure → caller re-scans from its own floor; dedupe absorbs it
          logger.error({ err, key }, '[telemetry] checkpoint read failed');
          return null;
        }
      },
      async advance(at: Date) {
        try {
          await CheckpointModel.updateOne({ key }, { $set: { at } }, { upsert: true });
        } catch (err) {
          logger.error({ err, key, at }, '[telemetry] checkpoint write failed');
        }
      },
    };
  };
}
