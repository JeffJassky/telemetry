import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { MongoMemoryServer } from 'mongodb-memory-server';

// Boots ONE mongod for the entire run. Each test file used to boot its own
// (via helpers.ts startDb), which meant 12 sequential mongod boots under
// poolOptions.forks.singleFork — the first test in a file paid that boot cost
// and on a loaded CI runner it occasionally pushed past testTimeout, failing
// tests that had nothing wrong with them. One boot removes that tax.
//
// The mongod's dbPath goes on RAM, not the SSD. mongod 7.0+ fsyncs the
// durable catalog on every index build, and macOS honours that as a full
// flush to the platter (~15ms each). A fresh telemetry instance builds ~30
// indexes, so `syncIndexes()` — which nearly every test pays, via
// buildTelemetry() + first write — cost ~570ms on the SSD and ~80ms on RAM.
// Worse, the SSD cost does not parallelise: eight concurrent builds queue on
// the same flush, whether in one mongod or eight. RAM does. Measured
// 2026-09-15 on an M-series Mac, mongod 8.2.6: 15 indexes 210ms → 32ms;
// 8 concurrent 1430ms → 200ms. Set TELEMETRY_TEST_RAMDISK=0 to opt out.
//
// Linux: /dev/shm is tmpfs, fsync is free, nothing to mount.
// macOS: there is no tmpfs, so mount a RAM disk (hdiutil + diskutil, no sudo)
// and eject it in teardown. A run killed mid-way leaves the volume mounted —
// the fixed volume name lets the next run find and eject it first.
const RAMDISK_VOLUME = 'telemetry-test-ramdisk';
const RAMDISK_SECTORS = 2 * 1024 * 1024; // 512-byte sectors → 1 GiB; freed on eject

function sh(cmd: string, args: string[]): string {
  return execFileSync(cmd, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
}

function ejectStaleRamdisk(): void {
  const mount = `/Volumes/${RAMDISK_VOLUME}`;
  if (!fs.existsSync(mount)) return;
  try {
    const node = sh('diskutil', ['info', mount]).match(/Device Node:\s+(\S+)/)?.[1];
    if (node) sh('hdiutil', ['detach', node, '-force']);
  } catch {
    /* leave it; mongod will just use the SSD below */
  }
}

/** Returns { dbPath, cleanup } on RAM, or null when it is unavailable/opted out. */
function ramDbPath(): { dbPath: string; cleanup: () => void } | null {
  if (process.env.TELEMETRY_TEST_RAMDISK === '0') return null;
  if (os.platform() === 'linux' && fs.existsSync('/dev/shm')) {
    const dbPath = fs.mkdtempSync(path.join('/dev/shm', 'telemetry-test-'));
    return { dbPath, cleanup: () => fs.rmSync(dbPath, { recursive: true, force: true }) };
  }
  if (os.platform() === 'darwin') {
    try {
      ejectStaleRamdisk();
      const device = sh('hdiutil', ['attach', '-nomount', `ram://${RAMDISK_SECTORS}`]).split(/\s+/)[0];
      sh('diskutil', ['erasevolume', 'APFS', RAMDISK_VOLUME, device]);
      const dbPath = path.join(`/Volumes/${RAMDISK_VOLUME}`, 'db');
      fs.mkdirSync(dbPath, { recursive: true });
      return {
        dbPath,
        cleanup: () => {
          try { sh('hdiutil', ['detach', device, '-force']); } catch { /* best effort */ }
        },
      };
    } catch {
      return null; // hdiutil/diskutil unavailable or refused — fall back to the SSD
    }
  }
  return null;
}

export default async function setup() {
  const ram = ramDbPath();
  const mongod = await MongoMemoryServer.create(ram ? { instance: { dbPath: ram.dbPath } } : {});
  process.env.TELEMETRY_TEST_MONGO_URI = mongod.getUri();

  return async () => {
    await mongod.stop();
    ram?.cleanup();
  };
}
