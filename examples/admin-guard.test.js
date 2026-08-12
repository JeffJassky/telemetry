/**
 * COPY THIS TEST INTO YOUR APP.
 *
 * `createDashboard` refuses to construct without a `viewerAdapter`, because an
 * unauthenticated telemetry dashboard is a data leak with charts. But that is
 * the only thing this package can enforce on its own: once you hand it a
 * `resolveViewer`, whatever that function returns IS the access decision.
 * Return a viewer and the caller reads that tenant's telemetry. Return
 * `{ tenantId: '*' }` and they read EVERY tenant's.
 *
 * So the boundary lives in your code, and a test in your repo is the only
 * thing that proves it is still there after someone refactors your session
 * middleware. This file is shipped in `examples/` for exactly that reason. It
 * is not run by this package's own suite — see standards/testing.md.
 *
 * Adjust the mount path, the session helper, and the role names to match your
 * app. Do not adjust what is being asserted.
 */
import { describe, expect, it } from 'vitest';
import request from 'supertest';
import { app } from '../src/app.js'; // ← your app, not ours

// ← your session helper. Must produce a real signed-in cookie; a hand-made
//   header proves nothing about the middleware that actually runs.
import { sessionFor } from '../test/helpers.js';

const MOUNT = '/telemetry'; // ← wherever you mounted createDashboard

describe('the telemetry dashboard guard', () => {
  it('refuses an unauthenticated caller', async () => {
    const res = await request(app).get(`${MOUNT}/api/records?range=24h`);
    expect(res.status).toBe(401);
  });

  // NOTE: the package's viewer gate covers `/api` only. The SPA shell is static
  // and carries no tenant data — it embeds the API base, the mount path and a
  // title, nothing else — so a stranger who loads it gets a UI that 401s on
  // every request. That is the ordinary SPA pattern and it is not a leak.
  //
  // If you would rather strangers not see the UI at all, wrap the whole mount
  // in your own middleware and assert it here:
  //
  //   it('refuses them the shell too', async () => {
  //     expect((await request(app).get(MOUNT)).status).toBe(401);
  //   });

  it('scopes a signed-in user to their OWN tenant', async () => {
    // The single most valuable assertion here. resolveViewer returning the
    // wrong tenantId is not a crash — it is a silent cross-tenant read that
    // looks exactly like a working dashboard.
    const res = await request(app)
      .get(`${MOUNT}/api/records?range=24h`)
      .set('cookie', await sessionFor({ tenantId: 'acc_mine', role: 'member' }));

    expect(res.status).toBe(200);
    for (const row of res.body.items) expect(row.tenantId).toBe('acc_mine');
  });

  it('does not let the CALLER choose the tenant', async () => {
    // Query strings, headers and bodies are all attacker-controlled. The
    // tenantId must come from the session, and from nowhere else.
    const res = await request(app)
      .get(`${MOUNT}/api/records?range=24h&tenantId=acc_theirs`)
      .set('cookie', await sessionFor({ tenantId: 'acc_mine', role: 'member' }));

    for (const row of res.body.items) expect(row.tenantId).toBe('acc_mine');
  });

  it('refuses a non-admin the admin-only system actions', async () => {
    // `GET /api/system` is readable by any viewer — it returns counters, the
    // index budget, and an EMPTY key list for non-admins. Revoking is the
    // admin-gated action, so that is what proves your adapter is not handing
    // out `role: 'admin'` by accident.
    const res = await request(app)
      .post(`${MOUNT}/api/system/keys/some_key_id/revoke`)
      .set('cookie', await sessionFor({ tenantId: 'acc_mine', role: 'member' }));

    expect(res.status).toBe(403);
  });

  it('does not list keys to a non-admin', async () => {
    const res = await request(app)
      .get(`${MOUNT}/api/system`)
      .set('cookie', await sessionFor({ tenantId: 'acc_mine', role: 'member' }));

    expect(res.status).toBe(200);
    expect(res.body.keys).toEqual([]); // present but empty — never populated
  });

  it('never grants the platform scope from a session alone', async () => {
    // '*' means "read every tenant". If your resolveViewer can produce it for
    // an ordinary signed-in user — because a role string was mistyped, or a
    // staff flag leaked into the session — this test is what catches it.
    const res = await request(app)
      .get(`${MOUNT}/api/records?range=24h`)
      .set('cookie', await sessionFor({ tenantId: 'acc_mine', role: 'admin' }));

    // a tenant admin is an admin OF THEIR TENANT, not of the platform
    const tenants = new Set(res.body.items.map((r) => r.tenantId));
    expect([...tenants]).toEqual(['acc_mine']);
  });
});
