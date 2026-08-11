import { defineConfig } from 'tsup';

// Dual ESM/CJS output. The source is ESM-only, but hosts compiled to CommonJS
// (ts-node/tsc with module:CommonJS) can only `require()` — an ESM-only package
// fails there with ERR_REQUIRE_ESM. Shipping both keeps a plain
// `import { createTelemetry } from '@jeffjassky/telemetry'` working either way.
//
// `clean` wipes dist, so the UI bundle must be built AFTER this — see the
// `build` script's ordering. express/mongoose stay external: they are peers,
// and bundling a peer means the host gets two copies of mongoose and a model
// registry that doesn't match itself.
//
// `import.meta.url` (used by src/server/ui.js to locate the SPA) cannot be
// expressed in CJS by esbuild. tsup shims it — verify after every tsup bump:
//   node -e "const p=require('./dist/index.cjs'); console.log(p.defaultSpaDir())"
// See standards/traps.md #7.
export default defineConfig({
  entry: {
    index: 'src/server/index.ts',
    client: 'src/client/index.ts',
  },
  format: ['esm', 'cjs'],
  sourcemap: true,
  clean: true,
  target: 'node20',
  outExtension: ({ format }) => ({
    js: format === 'cjs' ? '.cjs' : '.js',
  }),
  splitting: false,
  treeshake: true,
});
