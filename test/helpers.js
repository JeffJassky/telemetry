import express from 'express';
import mongoose from 'mongoose';
import { MongoMemoryServer } from 'mongodb-memory-server';
import { createTelemetry } from '../src/server/index.js';

let mongod;

export async function startDb() {
  mongod = await MongoMemoryServer.create();
  await mongoose.connect(mongod.getUri(), { dbName: 'telemetry-test' });
}

export async function stopDb() {
  await mongoose.disconnect();
  await mongod?.stop();
}

export function newUserId() {
  return new mongoose.Types.ObjectId();
}

/**
 * Build an app whose "authenticated user" is whatever the caller mutates on the
 * returned `session` object. Mirrors a host running its own auth middleware
 * upstream of our routers — which is the only arrangement this package supports.
 */
export async function buildApp({ session, model, userAdapter, resolveUser } = {}) {
  const state = session ?? { user: null };

  const pkg = createTelemetry({
    connection: mongoose,
    model,
    // A fresh model name per app keeps parallel suites from colliding in
    // mongoose's global registry — traps #2.
    modelName: `TelemetryEventTest${Math.random().toString(36).slice(2, 10)}`,
    // Pass through exactly what the caller asked for so config validation is
    // reachable; fall back to a default only when neither is given.
    ...(userAdapter ? { userAdapter } : {}),
    ...(resolveUser ? { resolveUser } : {}),
    ...(userAdapter || resolveUser ? {} : { resolveUser: (req) => req.authUser ?? null }),
  });

  // Mongoose builds indexes in the background, so a fresh collection can serve
  // a query before its index exists — and some of those throw rather than
  // return empty. Await it rather than race it. See standards/traps.md #3.
  if (!model) await pkg.model.createIndexes();

  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    req.authUser = state.user;
    next();
  });
  app.use('/api/telemetry', pkg.routes);
  // The host's guard — the package does NOT enforce this, by design.
  app.use('/api/telemetry/admin', (req, res, next) => {
    if (!state.user?.isAdmin) return res.status(403).json({ error: 'forbidden' });
    next();
  }, pkg.adminRoutes);

  return { app, pkg, state };
}
