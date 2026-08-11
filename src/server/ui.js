import express from 'express';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));

// Published builds run from `dist/index.js`, so the UI bundle sits alongside at
// `dist/ui`; running from source (tests, the example) it is two levels up. Pick
// whichever exists rather than guessing from a build flag — the two cases
// resolve differently and a flag gets it wrong in one of them.
// See standards/traps.md #7.
const SPA_DIR_CANDIDATES = ['./ui', '../../dist/ui'];

export function defaultSpaDir() {
  for (const candidate of SPA_DIR_CANDIDATES) {
    const dir = path.resolve(here, candidate);
    if (fs.existsSync(path.join(dir, 'index.html'))) return dir;
  }
  return path.resolve(here, SPA_DIR_CANDIDATES[SPA_DIR_CANDIDATES.length - 1]);
}

function escapeJson(value) {
  // `</script>` inside injected JSON would close the tag early; `<!--` would
  // open an HTML comment. Both are escaped at the `<` so the payload stays
  // inert regardless of what a config string contains. Test this.
  return JSON.stringify(value).replace(/</g, '\\u003c');
}

/**
 * Serve the built React SPA.
 *
 *   app.use('/telemetry', requireAuth, pkg.ui({ mountPath: '/telemetry' }))
 *
 * One build serves every mount path: assets are referenced relatively and the
 * server injects `<base href="<mountPath>/">` plus a runtime config blob, so
 * `apiBase` and admin mode are decided here rather than at build time.
 * Remounting needs no rebuild — but `mountPath` MUST match where the router is
 * actually mounted or every asset 404s. Behind a proxy that strips a prefix,
 * it is the path the *browser* sees, not the one Express sees.
 * See standards/traps.md #8.
 *
 * `loginUrl` is where the SPA sends someone whose session ends while the page
 * is open. The host's own guard handles signed-out-on-arrival; an *expiring*
 * session produces a 401 (or a 403, if their admin role was revoked) with the
 * page already rendered, and that case is ours. The current URL — hash route
 * included — is appended as `returnParam` so a login flow that honors it
 * returns the user to the exact view they were reading. Leave it null to
 * surface API errors inline instead.
 */
export function createUiRouter({
  mountPath = '/telemetry',
  apiBase = '/api/telemetry',
  adminApiBase = '/api/telemetry/admin',
  admin = false,
  title = 'Telemetry',
  spaDir = defaultSpaDir(),
  loginUrl = null,
  returnParam = 'next',
} = {}) {
  const router = express.Router();
  const indexPath = path.join(spaDir, 'index.html');

  // Hashed filenames — safe to cache hard.
  router.use('/_assets', express.static(path.join(spaDir, '_assets'), {
    maxAge: '1y',
    immutable: true,
    index: false,
  }));

  const base = `${mountPath.replace(/\/$/, '')}/`;

  router.get(/.*/, (req, res) => {
    let html;
    try {
      html = fs.readFileSync(indexPath, 'utf8');
    } catch {
      // The normal state of a fresh git checkout. A human explanation, not a
      // stack trace — the reader is usually a host developer, not us.
      return res.status(503).type('text/plain').send(
        'telemetry: UI bundle not found. Run `npm run build` in the package, '
        + 'or pass an explicit `spaDir`.',
      );
    }

    const config = escapeJson({ apiBase, adminApiBase, admin, title, loginUrl, returnParam });
    const injected = html.replace(
      '<!--telemetry-config-->',
      `<base href="${base}" />\n    <script>window.__TELEMETRY__=${config}</script>`,
    );
    res.type('html').send(injected);
  });

  return router;
}

/**
 * User-facing UI. Mount behind ordinary user auth.
 */
export function createPublicUiRouter(opts = {}) {
  return createUiRouter({
    mountPath: '/telemetry',
    title: 'Telemetry',
    ...opts,
    admin: false,
  });
}

/**
 * Admin UI — a separate bundle instance at a separate mount, behind the host's
 * admin guard. It is NOT the same page with a flag flipped client-side: a
 * non-admin who guesses the URL is stopped by the host's middleware before any
 * HTML is served.
 *
 *   app.use('/admin/telemetry', requireAuth, requireAdmin,
 *           pkg.adminUi({ mountPath: '/admin/telemetry' }))
 */
export function createAdminUiRouter(opts = {}) {
  return createUiRouter({
    mountPath: '/admin/telemetry',
    title: 'Telemetry — admin',
    ...opts,
    admin: true,
  });
}
