# telemetry

> `/scaffold` renames this file to `README.md`. The template's own README —
> the one explaining tokens and settled divergences — stays behind in foundry.

Unified telemetry — product events, errors, traces, state transitions, and billable usage in one Mongo envelope, with typed SDKs and a mountable dashboard.

npm renders this file, and it goes stale faster than anything else in the repo.
`standards/done.md` gates on it reflecting the final API.

```bash
npm install @jeffjassky/telemetry
```

## Quick start

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

await pkg.model.createIndexes();

const app = express();
app.use(express.json());          // yours, not ours

app.use('/api/telemetry', requireAuth, pkg.routes);
app.use('/telemetry',    requireAuth, pkg.ui({ mountPath: '/telemetry' }));

app.use('/api/telemetry/admin', requireAuth, requireAdmin, pkg.adminRoutes);
app.use('/admin/telemetry',    requireAuth, requireAdmin,
        pkg.adminUi({ mountPath: '/admin/telemetry' }));
```

Full docs: **https://jeffjassky.github.io/telemetry/**

## The one thing to get right

`isAdmin` from your adapter **gates nothing**. telemetry cannot know what admin
means in your app, so it refuses nobody — your middleware is the entire
boundary around `adminRoutes` and `adminUi()`.

Copy `examples/admin-guard.test.js` into your suite. It has to live in your
repo, because it is the only thing that catches a refactor dropping the guard.

## Requirements

Node 20+, Express 4.18+/5, Mongoose 7/8/9. Both are peer dependencies — all
three Mongoose majors run the full suite in CI.

## Development

```bash
npm install
npm run check-tracked   # run this FIRST — a global gitignore can eat source files
npm run typecheck
npm run build           # server, then the UI bundle into dist/ui
npm test                # after build: the UI tests assert against the bundle
node examples/express/server.js
```

## License

MIT © Jeff Jassky
