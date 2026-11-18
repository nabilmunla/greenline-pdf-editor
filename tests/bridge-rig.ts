// A rig for the bridge (PLAN 11): electron/updater.cjs - the current one, or any older copy of it - run in plain
// node with a stand-in for Electron's utility process (the real update-worker.cjs in a child process), a
// settings file in a temp folder and an install folder in a temp folder. Never a real share: "shares" are temp
// folders. Not a test itself (tests/*.test.ts are).
import { createRequire } from 'node:module';
import Module from 'node:module';
import { fork } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

export const ROOT = resolve(import.meta.dirname, '..');
export const KEY_FILE = join(ROOT, 'keys', 'update-signing-key.pem');
export const haveKey = existsSync(KEY_FILE);
const SHIM = join(ROOT, 'tests', 'bridge-shim.cjs');
const req = createRequire(import.meta.url);

/** the signed latest.json text for a payload (the publisher's side) */
export function signed(payload: Record<string, unknown>): string {
  const { signLatest } = req(join(ROOT, 'electron', 'updsig.cjs'));
  return JSON.stringify(signLatest(payload, readFileSync(KEY_FILE, 'utf8')), null, 2);
}

/** load updater.cjs from a folder (its siblings - updsig, feed, update-worker - come from the same folder) */
export function loadUpdater(electronDir: string): { create(o: Record<string, unknown>): any } {
  process.env.PDFED_UPDATE_TIMEOUT = process.env.PDFED_UPDATE_TIMEOUT || '8000';
  const fakeElectron = {
    app: { getPath: () => tmpdir() },
    powerMonitor: { on() {} },
    utilityProcess: {
      fork(file: string, args: string[]) {
        return fork(file, args, { execArgv: ['-r', SHIM], stdio: ['ignore', 'ignore', 'ignore', 'ipc'] });
      },
    },
  };
  const M = Module as any;
  const orig = M._load;
  M._load = function (name: string, ...rest: unknown[]) { return name === 'electron' ? fakeElectron : orig.call(this, name, ...rest); };
  try { return createRequire(join(electronDir, 'x.cjs'))(join(electronDir, 'updater.cjs')); } finally { M._load = orig; }
}

export interface Rig {
  dir: string; inst: string; settingsFile: string; updateJson: string; logs: string[]; dropped: number;
  settings(): any; setSettings(s: unknown): void; updateJsonNow(): any;
  readonly: boolean;
  make(o?: Record<string, unknown>): any;
  done(): void;
}
/** an install folder (install.json, resources/app.old/package.json when `appOld`) + settings, in a temp folder */
export function rig(o: { appOld?: Record<string, unknown> | null; updateJson?: Record<string, unknown> | null; settings?: Record<string, unknown>; electronDir?: string; version?: string; build?: string; feedUrl?: string } = {}): Rig {
  const dir = mkdtempSync(join(tmpdir(), 'bridge-'));
  const inst = join(dir, 'install');
  mkdirSync(join(inst, 'resources', 'app.old'), { recursive: true });
  writeFileSync(join(inst, 'install.json'), JSON.stringify({ scope: 'user', version: o.version || '0.13.0' }));
  if (o.appOld !== null) writeFileSync(join(inst, 'resources', 'app.old', 'package.json'), JSON.stringify(o.appOld || { version: '0.12.1' }));
  if (o.updateJson) writeFileSync(join(inst, 'update.json'), JSON.stringify(o.updateJson));
  const settingsFile = join(dir, 'settings.json');
  if (o.settings) writeFileSync(settingsFile, JSON.stringify(o.settings));
  process.env.PDFED_INSTALL_DIR = inst;
  const r: Rig = {
    dir, inst, settingsFile, updateJson: join(inst, 'update.json'), logs: [], dropped: 0, readonly: false,
    settings: () => (existsSync(settingsFile) ? JSON.parse(readFileSync(settingsFile, 'utf8')) : {}),
    setSettings: (s) => writeFileSync(settingsFile, JSON.stringify(s)),
    updateJsonNow: () => { try { return JSON.parse(readFileSync(join(inst, 'update.json'), 'utf8')); } catch { return null; } },
    make(more = {}) {
      process.env.PDFED_INSTALL_DIR = inst;
      const { create } = loadUpdater(o.electronDir || join(ROOT, 'electron'));
      return create({
        version: o.version || '0.13.0', appName: 'PDF Editor', send: () => {}, log: (m: string) => r.logs.push(String(m)),
        readSettings: r.settings, writeSettings: (s: unknown) => writeFileSync(settingsFile, JSON.stringify(s)),
        defaultSource: o.feedUrl || '', build: o.build || 'greenline', onMoved: () => { r.dropped++; }, ...more,
      });
    },
    done: () => rmSync(dir, { recursive: true, force: true }),
  };
  return r;
}

/** a fake share: a folder with a signed latest.json and a package of the given size */
export function share(dir: string, payload: Record<string, unknown>, pkgBytes = 2000): string {
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'app-v9.9.9.zip'), Buffer.alloc(pkgBytes, 7));
  writeFileSync(join(dir, 'latest.json'), signed({ version: '9.9.9', runtime: process.versions.electron, notes: ['x'], app: { file: 'app-v9.9.9.zip', sha256: '0'.repeat(64), size: pkgBytes }, ...payload }));
  return dir;
}
