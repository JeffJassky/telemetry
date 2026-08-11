# Quickstart

```bash
npm install @jeffjassky/telemetry
```

## Mount it

```js
import express from 'express';
import mongoose from 'mongoose';
import { createTelemetry } from '@jeffjassky/telemetry';

await mongoose.connect(process.env.MONGO_URL);

const pkg = createTelemetry({
  connection: mongoose,
  resolveUser: (req) => req.user && {
    id: req.user._id,
    email: req.user.email,
    displayName: req.user.name,
    isAdmin: req.user.role === 'admin',
  },
});

// Build indexes once at boot. Mongoose builds them in the background, and some
// queries throw rather than return empty while an index is still missing.
await pkg.model.createIndexes();

const app = express();

// YOUR job, not the package's. A body parser mounted inside a library router
// silently changes body parsing for everything mounted after it.
app.use(express.json());

app.use('/api/telemetry', requireAuth, pkg.routes);
app.use('/telemetry',    requireAuth, pkg.ui({ mountPath: '/telemetry' }));
```

## Add the admin surface

The admin routers are **not guarded by this package**. `isAdmin` from your
adapter drives badges and which UI renders; it refuses nobody. Your middleware
is the entire boundary:

```js
app.use('/api/telemetry/admin', requireAuth, requireAdmin, pkg.adminRoutes);
app.use('/admin/telemetry',    requireAuth, requireAdmin,
        pkg.adminUi({ mountPath: '/admin/telemetry' }));
```

Then copy `examples/admin-guard.test.js` into your suite. That test lives in
your repo because it is the only thing that catches a refactor removing the
guard.

## `mountPath` must be true

It is baked into a `<base href>` at request time, so it must match where the
router actually is — and behind a proxy that strips a prefix, it is the path the
**browser** sees, not the one Express sees. Get it wrong and every asset 404s
while the HTML loads fine.

## Run the example

```bash
node examples/express/server.js
# → http://localhost:3000/telemetry
```

In-memory Mongo, fake auth, every mount wired. Switch identity with `?as=admin`.
