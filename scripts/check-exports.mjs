#!/usr/bin/env node
/**
 * The hand-written .d.ts files ARE the published contract, and nothing but
 * discipline keeps them in step with what `dist/` actually exports.
 *
 * types/test-d.ts is the first line of defence, but it only catches drift
 * someone remembered to write a line for — and it has a blind spot that already
 * bit us. `import type { TelemetryKind }` compiles happily whether the
 * declaration is a `const` object or a bare union, so six vocabulary exports
 * shipped as runtime consts while the contract declared them type-only:
 * `TelemetryKind.Usage` was working code that failed `tsc`.
 *
 * This check has no blind spot, because it does not read the source. It asks
 * the TypeScript checker which names each .d.ts exports IN VALUE POSITION, then
 * imports the built bundle and asks it which names it actually has. Both
 * directions are errors:
 *
 *   missing  — shipped by dist, absent from the contract (the bug above)
 *   phantom  — promised by the contract, absent from dist (a broken import)
 *
 * Runs after `build`, because it needs the artifact. See standards/traps.md #9.
 */
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import path from 'node:path';
import fs from 'node:fs';
import ts from 'typescript';

const require = createRequire(import.meta.url);
const root = path.resolve(import.meta.dirname, '..');
const pkg = require(path.join(root, 'package.json'));

/** every subpath with both a declaration and an ESM build */
const entries = Object.entries(pkg.exports)
  .filter(([, v]) => v && typeof v === 'object' && v.types && v.import)
  .map(([subpath, v]) => ({
    subpath,
    types: path.join(root, v.types),
    dist: path.join(root, v.import),
  }));

const missingBuild = entries.filter((e) => !fs.existsSync(e.dist));
if (missingBuild.length) {
  console.error(
    `check-exports: no build at ${missingBuild.map((e) => path.relative(root, e.dist)).join(', ')}\n` +
    '  Run `npm run build` first — this check compares the contract against the artifact.',
  );
  process.exit(1);
}

// One program over every declaration file: the checker resolves cross-file
// re-exports (types/index.d.ts pulls from types/core.d.ts) that a text scan
// for `export declare` would miss.
const program = ts.createProgram(entries.map((e) => e.types), {
  noEmit: true,
  skipLibCheck: true,
  moduleResolution: ts.ModuleResolutionKind.NodeNext,
  module: ts.ModuleKind.NodeNext,
  target: ts.ScriptTarget.ES2022,
});
const checker = program.getTypeChecker();

/** names a .d.ts exports in VALUE position — consts, functions, classes, enums */
function declaredValues(file) {
  const source = program.getSourceFile(file);
  if (!source) throw new Error(`check-exports: could not load ${path.relative(root, file)}`);
  const moduleSymbol = checker.getSymbolAtLocation(source);
  if (!moduleSymbol) return new Set(); // no top-level export statement at all
  return new Set(
    checker
      .getExportsOfModule(moduleSymbol)
      .filter((s) => {
        // an alias (`export { x } from './y'`) reports its own flags as Alias;
        // resolve it before asking whether the target is a value
        const target = s.flags & ts.SymbolFlags.Alias ? checker.getAliasedSymbol(s) : s;
        return (target.flags & ts.SymbolFlags.Value) !== 0;
      })
      .map((s) => s.name),
  );
}

let failed = false;

for (const entry of entries) {
  const declared = declaredValues(entry.types);
  const runtime = new Set(Object.keys(await import(pathToFileURL(entry.dist).href)));
  runtime.delete('default');

  const missing = [...runtime].filter((n) => !declared.has(n)).sort();
  const phantom = [...declared].filter((n) => !runtime.has(n)).sort();

  if (missing.length || phantom.length) {
    failed = true;
    console.error(`\n  ${pkg.name}${entry.subpath.slice(1)}  (${path.relative(root, entry.types)})`);
    if (missing.length) {
      console.error(`    shipped but NOT declared as a value — hosts get code that fails tsc:`);
      for (const n of missing) console.error(`      ${n}`);
    }
    if (phantom.length) {
      console.error(`    declared but NOT shipped — hosts get an import that resolves to undefined:`);
      for (const n of phantom) console.error(`      ${n}`);
    }
  }
}

if (failed) {
  console.error(
    '\ncheck-exports: the published contract disagrees with the build.\n' +
    '  Declare the missing names in types/ (use the `const` + `type` twin pattern for\n' +
    '  vocabulary objects), and exercise each one as a VALUE in types/test-d.ts.\n',
  );
  process.exit(1);
}

console.log(`check-exports: ${entries.length} entry points, contract matches the build.`);
