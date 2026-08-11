import express from 'express';
import { wrapWithHttpErrors } from '../errors.js';

/**
 * Public JSON routes.
 *
 * The host mounts this. It is a Router, never an app and never a server — see
 * standards/house-style.md.
 *
 * The host is also responsible for `app.use(express.json())`. Mounting a body
 * parser inside a library router silently changes body parsing for everything
 * mounted after it, and the symptom (every POST looks like a validation
 * failure) does not point at the cause. See standards/traps.md #5.
 */
export function createRoutes(ctx) {
  const { Model, resolveUser, logger, listLimit } = ctx;
  const router = express.Router();
  const wrap = (h) => wrapWithHttpErrors(logger, h);

  // ---- literal paths FIRST ----
  // `GET /:id` will happily swallow `/me` and `/summary`. Declare literals
  // first, and keep the test named after the failure so nobody reorders this
  // file back. See standards/traps.md #4.

  router.get('/me', wrap(async (req, res) => {
    const user = resolveUser(req);
    if (!user) return res.status(401).json({ error: 'unauthenticated' });
    // Internal ids never leave — the UI renders a name, not a key.
    res.json({ user: { email: user.email, displayName: user.displayName, isAdmin: !!user.isAdmin } });
  }));

  router.get('/', wrap(async (req, res) => {
    const user = resolveUser(req);
    if (!user) return res.status(401).json({ error: 'unauthenticated' });

    // Cap it. Always. An unbounded read here is an outage on the first host
    // with real data. See standards/traps.md #18.
    const limit = Math.min(Number(req.query.limit) || listLimit, listLimit);
    const items = await Model.find({}).sort({ createdAt: -1 }).limit(limit).lean();
    res.json({ items, limit });
  }));

  // ---- parameter paths LAST ----
  router.get('/:id', wrap(async (req, res) => {
    const user = resolveUser(req);
    if (!user) return res.status(401).json({ error: 'unauthenticated' });
    const doc = await Model.findById(req.params.id).lean();
    if (!doc) return res.status(404).json({ error: 'not_found' });
    res.json({ item: doc });
  }));

  return router;
}

/**
 * Admin JSON routes.
 *
 * These do NOT check `isAdmin` themselves — the package cannot know what admin
 * means in a host. The host wraps this router in its own guard:
 *
 *   app.use('/api/telemetry/admin', requireAuth, requireAdmin, pkg.adminRoutes)
 *
 * Say that loudly in the docs, and ship the "a non-admin gets 403" test in
 * `examples/` so hosts can copy it — their test is the only net.
 * See standards/adapters.md.
 */
export function createAdminRoutes(ctx) {
  const { Model, logger, adminListLimit } = ctx;
  const router = express.Router();
  const wrap = (h) => wrapWithHttpErrors(logger, h);

  router.get('/summary', wrap(async (_req, res) => {
    res.json({ total: await Model.estimatedDocumentCount() });
  }));

  router.get('/', wrap(async (req, res) => {
    const limit = Math.min(Number(req.query.limit) || adminListLimit, adminListLimit);
    const items = await Model.find({}).sort({ createdAt: -1 }).limit(limit).lean();
    res.json({ items, limit });
  }));

  return router;
}
