/**
 * COPY THIS TEST INTO YOUR APP.
 *
 * telemetry ships `isAdmin` on the resolved user, and it gates nothing — the
 * package cannot know what "admin" means in your system, so it never refuses
 * anyone. The middleware you wrap `adminRoutes` in is the entire boundary, and
 * a test in your repo is the only thing that proves it is still there after
 * someone refactors your router file.
 *
 * This file is shipped in `examples/` for exactly that reason. It is not run by
 * this package's own suite — see standards/testing.md.
 */
import { describe, expect, it } from 'vitest';
import request from 'supertest';
import { app } from '../src/app.js'; // ← your app, not ours

describe('the admin guard', () => {
  it('refuses a signed-in non-admin', async () => {
    const res = await request(app)
      .get('/api/telemetry/admin/summary')
      .set('cookie', await sessionFor({ isAdmin: false }));
    expect(res.status).toBe(403);
  });

  it('refuses an unauthenticated caller', async () => {
    const res = await request(app).get('/api/telemetry/admin/summary');
    expect([401, 403]).toContain(res.status);
  });

  it('refuses a non-admin the admin UI too, before any HTML is served', async () => {
    // The admin UI is a separate mount behind the same guard — not the same
    // page with a client-side flag a curious user can flip in devtools.
    const res = await request(app)
      .get('/admin/telemetry/')
      .set('cookie', await sessionFor({ isAdmin: false }));
    expect(res.status).toBe(403);
    expect(res.text).not.toContain('__TELEMETRY__');
  });

  it('admits an admin', async () => {
    const res = await request(app)
      .get('/api/telemetry/admin/summary')
      .set('cookie', await sessionFor({ isAdmin: true }));
    expect(res.status).toBe(200);
  });
});
