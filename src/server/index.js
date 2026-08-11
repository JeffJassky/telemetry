import { resolveConfig } from './config.js';
import { createRoutes, createAdminRoutes } from './routes/index.js';
import { createPublicUiRouter, createAdminUiRouter, defaultSpaDir } from './ui.js';

export { defaultResolveUser, createUserAdapter } from './config.js';
export { createTelemetryEventModel, buildTelemetryEventSchema } from './model-factory.js';
export { HttpError } from './errors.js';
export { defaultSpaDir };

/**
 * Telemetry — the package factory.
 *
 * Returns routers the host mounts. Never an app, never a server.
 *
 *   const pkg = createTelemetry({ connection: mongoose, resolveUser });
 *
 *   app.use(express.json());                        // the host's job, not ours
 *   app.use('/api/telemetry', requireAuth, pkg.routes);
 *   app.use('/telemetry',    requireAuth, pkg.ui({ mountPath: '/telemetry' }));
 *
 *   app.use('/api/telemetry/admin', requireAuth, requireAdmin, pkg.adminRoutes);
 *   app.use('/admin/telemetry',    requireAuth, requireAdmin,
 *           pkg.adminUi({ mountPath: '/admin/telemetry' }));
 */
export function createTelemetry(config = {}) {
  const ctx = resolveConfig(config);

  return {
    /** The Mongoose model. Exposed so hosts can `await model.createIndexes()`. */
    model: ctx.Model,
    /** Public JSON API. */
    routes: createRoutes(ctx),
    /** Admin JSON API. The host guards it — this router does not. */
    adminRoutes: createAdminRoutes(ctx),
    /** Public SPA router. */
    ui: (opts) => createPublicUiRouter(opts),
    /** Admin SPA router. */
    adminUi: (opts) => createAdminUiRouter(opts),

    /**
     * Outbound adapter direction: the host tells us a user is gone.
     *
     * We store references into a user system we do not own, and nothing else
     * will ever clean them up. Repair every derived value this touches, and
     * make it idempotent — it will be called twice.
     */
    async purgeUser(userId) {
      const { deletedCount = 0 } = await ctx.Model.deleteMany({ userId });
      return { removed: deletedCount };
    },
  };
}
