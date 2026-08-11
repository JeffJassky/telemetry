/**
 * Runnable example — an in-memory Mongo, a fake auth middleware, and every
 * telemetry mount.
 *
 *   node examples/express/server.js
 *
 * Then open http://localhost:3000/telemetry or http://localhost:3000/admin/telemetry.
 * Switch identity with `?as=` — `?as=alice`, `?as=bob`, `?as=admin`.
 */
import express from 'express';
import mongoose from 'mongoose';
import { MongoMemoryServer } from 'mongodb-memory-server';
import { createTelemetry } from '../../src/server/index.js';

const mongod = await MongoMemoryServer.create();
await mongoose.connect(mongod.getUri(), { dbName: 'telemetry-example' });

// Stand-ins for real accounts. A real host reads these from a session.
const PEOPLE = {
  alice: { id: new mongoose.Types.ObjectId(), email: 'alice@example.com', displayName: 'Alice', isAdmin: false },
  bob: { id: new mongoose.Types.ObjectId(), email: 'bob@example.com', displayName: 'Bob', isAdmin: false },
  admin: { id: new mongoose.Types.ObjectId(), email: 'staff@example.com', displayName: 'Staff', isAdmin: true },
};

const pkg = createTelemetry({
  connection: mongoose,
  resolveUser: (req) => req.person,
  logger: console,
});
await pkg.model.createIndexes();

const app = express();

// The host mounts the body parser, not the package — traps #5.
app.use(express.json());

// Fake auth. The identity sticks in a cookie so the SPA's fetches keep it.
app.use((req, res, next) => {
  const who = req.query.as;
  if (who && PEOPLE[who]) res.cookie('as', who);
  const key = who && PEOPLE[who] ? who : (req.headers.cookie?.match(/as=(\w+)/)?.[1] ?? 'alice');
  req.person = PEOPLE[key] ?? PEOPLE.alice;
  next();
});

/**
 * THE GUARD THE PACKAGE CANNOT WRITE.
 *
 * `isAdmin` from the adapter drives badges and which UI renders — it gates
 * nothing, because telemetry cannot know what admin means here. This middleware
 * is the only thing standing between a curious user and the admin API.
 *
 * Copy it, and copy the test in examples/admin-guard.test.js with it. That test
 * is the net, and it has to live in YOUR repo.
 */
const requireAdmin = (req, res, next) => (
  req.person?.isAdmin ? next() : res.status(403).json({ error: 'forbidden' })
);

// Public: JSON API + UI.
app.use('/api/telemetry', pkg.routes);
app.use('/telemetry', pkg.ui({ mountPath: '/telemetry', loginUrl: '/login', returnParam: 'next' }));

// Admin: JSON API + UI, both behind the guard, at their own paths.
app.use('/api/telemetry/admin', requireAdmin, pkg.adminRoutes);
app.use('/admin/telemetry', requireAdmin, pkg.adminUi({ mountPath: '/admin/telemetry' }));

app.get('/', (_req, res) => res.redirect('/telemetry'));

// Honor PORT. A dev box usually has something on 3000 already, and on macOS a
// process bound to IPv6 `*:3000` does NOT stop node binding IPv4 0.0.0.0:3000 —
// so this listens "successfully" and every request goes to the other app.
// The symptom is a 404 on every route with no error anywhere.
const port = Number(process.env.PORT) || 3000;
const server = app.listen(port, '127.0.0.1', () => {
  console.log(`telemetry example → http://127.0.0.1:${port}/telemetry`);
  console.log(`                   http://127.0.0.1:${port}/admin/telemetry?as=admin`);
});
server.on('error', (err) => {
  if (err.code === 'EADDRINUSE') {
    console.error(`Port ${port} is taken. Try: PORT=3100 node examples/express/server.js`);
    process.exit(1);
  }
  throw err;
});
