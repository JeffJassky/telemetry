import { describe, expect, it } from 'vitest';
import express from 'express';
import fs from 'node:fs';
import path from 'node:path';
import request from 'supertest';
import { createUiRouter, defaultSpaDir } from '../src/server/ui.js';

const bundleExists = fs.existsSync(path.join(defaultSpaDir(), 'index.html'));

describe('SPA serving', () => {
  it('answers 503 with a human explanation when the bundle is missing', async () => {
    const app = express();
    app.use('/telemetry', createUiRouter({ mountPath: '/telemetry', spaDir: '/nonexistent' }));
    const res = await request(app).get('/telemetry/');
    expect(res.status).toBe(503);
    // Not a stack trace — this is the normal state of a fresh checkout.
    expect(res.text).toMatch(/npm run build/);
  });

  // These need `npm run build` first. CI builds before testing for exactly
  // this reason — see standards/traps.md #11.
  describe.skipIf(!bundleExists)('against the built bundle', () => {
    it('injects a <base href> matching the mount path', async () => {
      const app = express();
      app.use('/mounted/elsewhere', createUiRouter({ mountPath: '/mounted/elsewhere' }));
      const res = await request(app).get('/mounted/elsewhere/');
      expect(res.status).toBe(200);
      // A mismatch here 404s every asset — the failure looks like a broken
      // build and is actually a wrong string.
      expect(res.text).toContain('<base href="/mounted/elsewhere/" />');
    });

    it('escapes `<` in the injected config so a title cannot close the script tag', async () => {
      const app = express();
      app.use('/telemetry', createUiRouter({
        mountPath: '/telemetry',
        title: '</script><script>alert(1)</script>',
      }));
      const res = await request(app).get('/telemetry/');
      expect(res.text).not.toContain('</script><script>alert(1)');
      expect(res.text).toContain('\\u003c');
    });

    it('serves one build at any mount path without a rebuild', async () => {
      const app = express();
      app.use('/a', createUiRouter({ mountPath: '/a' }));
      app.use('/b', createUiRouter({ mountPath: '/b' }));
      expect((await request(app).get('/a/')).text).toContain('<base href="/a/" />');
      expect((await request(app).get('/b/')).text).toContain('<base href="/b/" />');
    });
  });
});

describe('defaultSpaDir', () => {
  // esbuild cannot express import.meta.url in CJS; tsup shims it. Verify after
  // every tsup bump. See standards/traps.md #7.
  it('returns an absolute path from ESM source', () => {
    expect(path.isAbsolute(defaultSpaDir())).toBe(true);
  });
});
