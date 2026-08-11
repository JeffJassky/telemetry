---
layout: home

hero:
  name: telemetry
  text: Telemetry
  tagline: Unified telemetry — product events, errors, traces, state transitions, and billable usage in one Mongo envelope, with typed SDKs and a mountable dashboard.
  actions:
    - theme: brand
      text: Quickstart
      link: /guide/quickstart
    - theme: alt
      text: View on GitHub
      link: https://github.com/JeffJassky/telemetry

features:
  - title: Embedded, not external
    icon: 📦
    details: '`npm install @jeffjassky/telemetry`, mount the routers, done. Your users stay signed in to your app — no redirect to a third-party service, no SSO handshake, no data leaving your database.'
  - title: Your auth, not ours
    icon: 🪪
    details: One `resolveUser(req)` function is the entire integration contract. Sessions, JWTs, API keys — telemetry never authenticates anyone, it just asks who is calling.
  - title: Prebuilt React UI
    icon: 🎛️
    details: One bundle, served from your own domain at any mount path. No bundler in your app, no framework agreement — the host can be Vue, Svelte, or server-rendered.
  - title: Honest about deletion
    icon: 🧹
    details: '`purgeUser()` removes everything telemetry stored about them and repairs every derived value it touches. One call in your account-deletion path.'
---

```js
import mongoose from 'mongoose';
import express from 'express';
import { createTelemetry } from '@jeffjassky/telemetry';

await mongoose.connect(process.env.MONGO_URL);

const pkg = createTelemetry({
  connection: mongoose,
  resolveUser: (req) => req.session.user && {
    id: req.session.user._id,
    email: req.session.user.email,
    displayName: req.session.user.name,
    isAdmin: req.session.user.role === 'admin',
  },
});

const app = express();
app.use(express.json());

// Public
app.use('/api/telemetry', requireAuth, pkg.routes);
app.use('/telemetry',    requireAuth, pkg.ui({ mountPath: '/telemetry' }));

// Admin — separate guard, separate route
app.use('/api/telemetry/admin', requireAuth, requireAdmin, pkg.adminRoutes);
app.use('/admin/telemetry',    requireAuth, requireAdmin,
        pkg.adminUi({ mountPath: '/admin/telemetry' }));
```
