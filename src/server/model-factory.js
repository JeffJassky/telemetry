import mongoose from 'mongoose';

export function buildTelemetryEventSchema({ userRef = 'User' } = {}) {
  const schema = new mongoose.Schema({
    userId: { type: mongoose.Schema.Types.ObjectId, ref: userRef, index: true },
    createdAt: { type: Date, default: Date.now, index: true },
    updatedAt: { type: Date, default: Date.now },
  });

  return schema;
}

/**
 * Model factory.
 *
 * Mongoose keeps compiled models in a registry on the connection, so calling
 * `connection.model(name, schema)` twice for the same name throws
 * OverwriteModelError. A library cannot own that global name unconditionally —
 * the host may already have a model by this name, or the package may be loaded
 * twice through a hoisting mismatch. So: reuse an already-compiled model when
 * the name is taken, and let the host pick both the model name and the
 * connection.
 *
 * The tradeoff, which belongs in the docs: if that existing model isn't ours,
 * queries fail confusingly. Tell hosts to set `modelName` when a collision is
 * plausible. See standards/traps.md #2.
 */
export function createTelemetryEventModel({
  connection = mongoose,
  modelName = 'TelemetryEvent',
  collection,
  userRef = 'User',
} = {}) {
  const existing = connection.models?.[modelName];
  if (existing) return existing;
  return connection.model(modelName, buildTelemetryEventSchema({ userRef }), collection);
}
