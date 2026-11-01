/**
 * Managed downloads: the wake word model and the Electron runtime that hosts the pet window when it
 * runs outside an app. Files land at `<CORTICO_HOME>/runtimes/<id>/<version>/` and
 * `<CORTICO_HOME>/models/desktop-pet/<model id>/`, are written to `.partial` first and renamed into
 * place when complete.
 *
 * Archives are unpacked with the system `tar` (bsdtar on Windows and macOS reads zip too);
 * Linux zips go through `unzip`. A `.tar.bz2` is expanded in process first: Windows' bsdtar carries
 * no bzip2 of its own and asks for an external `bzip2`, which most machines do not have.
 */
import { spawn } from 'node:child_process';
import { createReadStream, createWriteStream, existsSync, mkdirSync, readdirSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { basename, join, resolve } from 'node:path';
import { pipeline } from 'node:stream/promises';
import unbzip2 from 'unbzip2-stream';
import { downloadFile, type DownloadOptions } from './download.ts';
import { petText, type PetText } from '../i18n/index.ts';

/** The words of the download steps, in the language at the time of each step. */
type StoreText = () => PetText['store'];

export type Phase = 'absent' | 'working' | 'ready' | 'error';

export interface ArtifactState {
  phase: Phase;
  /** Where the artifact lives (a directory for runtimes, a file for models). */
  path: string;
  done: number;
  total: number | null;
  detail: string | null;
}

const platformKey = (): string => `${process.platform}-${process.arch}`;

/**
 * The wake word model: sherpa-onnx's zipformer keyword spotter over WenetSpeech, about 3 MB in all
 * (Apache-2.0, export by k2-fsa). It comes as one archive rather than as four named files: the
 * export's names carry its epoch and chunk size, so what a file is gets read off the name
 * (`pickExport`). Upstream publishes neither a size nor a digest for the archive that could be
 * pinned here, so what is checked is that every file arrived and is not empty.
 */
export const KWS_MODEL: KwsModelSpec = {
  id: 'kws-zipformer-wenetspeech-3.3M-2024-01-01',
  archive: 'sherpa-onnx-kws-zipformer-wenetspeech-3.3M-2024-01-01.tar.bz2',
  tokens: /^tokens\.txt$/,
  sources: [(file: string) => `https://github.com/k2-fsa/sherpa-onnx/releases/download/kws-models/${file}`],
};

export const ELECTRON_RUNTIME = {
  id: 'electron',
  version: '44.4.4',
  assets: {
    'win32-x64': { file: 'electron-v44.4.4-win32-x64.zip', bytes: 158_149_795 },
    'darwin-arm64': { file: 'electron-v44.4.4-darwin-arm64.zip', bytes: 130_390_806 },
    'darwin-x64': { file: 'electron-v44.4.4-darwin-x64.zip', bytes: 134_174_708 },
    'linux-x64': { file: 'electron-v44.4.4-linux-x64.zip', bytes: 122_970_570 },
  } as Record<string, { file: string; bytes: number }>,
  url: (file: string) => `https://github.com/electron/electron/releases/download/v44.4.4/${file}`,
  executable: process.platform === 'win32' ? 'electron.exe' : process.platform === 'darwin' ? 'Electron' : 'electron',
} as const;

/** Depth-first search for a file name under `dir`. */
function findFile(dir: string, name: string, depth = 5): string | null {
  if (!existsSync(dir) || depth < 0) return null;
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isFile() && entry.name === name) return full;
  }
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (!entry.isDirectory() || entry.name.endsWith('.partial')) continue;
    const hit = findFile(join(dir, entry.name), name, depth - 1);
    if (hit) return hit;
  }
  return null;
}

/**
 * Depth-first search for a file whose name `match` takes; the int8 export first, then the shortest
 * name, so an archived model with several exports resolves to one of them the same way every time.
 */
function findByMatch(dir: string, match: RegExp, depth = 5): string | null {
  if (!existsSync(dir) || depth < 0) return null;
  const here = readdirSync(dir, { withFileTypes: true })
    .filter((entry) => entry.isFile() && match.test(entry.name))
    .map((entry) => entry.name)
    .sort((a, b) => Number(b.includes('.int8.')) - Number(a.includes('.int8.')) || a.length - b.length);
  if (here.length) return join(dir, here[0]!);
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (!entry.isDirectory() || entry.name.endsWith('.partial')) continue;
    const hit = findByMatch(join(dir, entry.name), match, depth - 1);
    if (hit) return hit;
  }
  return null;
}

/** Every file under `dir`, five directories deep at most, `.partial` directories left out. */
function filesUnder(dir: string, depth = 5): string[] {
  if (!existsSync(dir) || depth < 0) return [];
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isFile()) out.push(full);
    else if (entry.isDirectory() && !entry.name.endsWith('.partial')) out.push(...filesUnder(full, depth - 1));
  }
  return out;
}

/** The roles the spotter loads, in the order a missing one is reported. */
const KWS_ROLES = ['encoder', 'decoder', 'joiner', 'tokens'] as const;

/** `encoder-epoch-99-avg-1-chunk-16-left-64.int8.onnx`: the role, the export it belongs to, and its cut. */
const EXPORT = /^(encoder|decoder|joiner)-(.+?)(\.int8)?\.onnx$/;

/**
 * The encoder, decoder and joiner of one export. An archive ships two exports, each in a float and
 * an int8 cut, and the three files the spotter loads must come from the same one: int8 first, then
 * the newest epoch. Null when no export is complete.
 */
function pickExport(dir: string): Record<'encoder' | 'decoder' | 'joiner', string> | null {
  const groups = new Map<string, Partial<Record<'encoder' | 'decoder' | 'joiner', string>>>();
  for (const file of filesUnder(dir)) {
    const m = EXPORT.exec(basename(file));
    if (!m) continue;
    const key = `${m[2]}${m[3] ? ' int8' : ''}`;
    const group = groups.get(key) ?? {};
    group[m[1] as 'encoder'] = file;
    groups.set(key, group);
  }
  const whole = [...groups].filter(([, g]) => g.encoder && g.decoder && g.joiner);
  whole.sort(([a], [b]) => Number(b.endsWith(' int8')) - Number(a.endsWith(' int8'))
    || Number(/epoch-(\d+)/.exec(b)?.[1] ?? 0) - Number(/epoch-(\d+)/.exec(a)?.[1] ?? 0) || a.localeCompare(b));
  return whole.length ? (whole[0]![1] as Record<'encoder' | 'decoder' | 'joiner', string>) : null;
}

/** A model shipped as one archive, its files found by name inside it (`KWS_MODEL`). */
export interface KwsModelSpec {
  id: string;
  /** The archive's file name in the release. */
  archive: string;
  /** The tokens table the keywords are written in; the three model files are found by `pickExport`. */
  tokens: RegExp;
  sources: ReadonlyArray<(file: string) => string>;
}

function run(cmd: string, args: string[], cwd: string, t: PetText['store']): Promise<void> {
  return new Promise((done, fail) => {
    const child = spawn(cmd, args, { cwd, windowsHide: true, stdio: ['ignore', 'ignore', 'pipe'] });
    let err = '';
    child.stderr.on('data', (d: Buffer) => { err += d.toString(); });
    child.on('error', fail);
    child.on('close', (code) => (code === 0 ? done() : fail(new Error(t.exitCode(cmd, code, err.trim().slice(0, 300))))));
  });
}

/** The tar inside a `.tar.bz2`, expanded to the file beside it; the archive itself when it needs no bzip2. */
async function bunzip(archive: string): Promise<string> {
  if (!archive.endsWith('.bz2')) return archive;
  const tar = archive.slice(0, -4);
  await pipeline(createReadStream(archive), unbzip2(), createWriteStream(tar));
  return tar;
}

export async function extract(archive: string, into: string, t: PetText['store'] = petText().store): Promise<void> {
  mkdirSync(into, { recursive: true });
  const file = await bunzip(archive);
  try {
    if (process.platform === 'win32') {
      // bsdtar ships with Windows 10+; GNU tar earlier on PATH (Git's) cannot read zip
      const tar = resolve(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'tar.exe');
      await run(tar, ['-xf', file, '-C', into], into, t);
    } else if (file.endsWith('.zip') && process.platform === 'linux') {
      await run('unzip', ['-q', '-o', file, '-d', into], into, t);
    } else {
      await run('tar', ['-xf', file, '-C', into], into, t);
    }
  } finally {
    if (file !== archive) rmSync(file, { force: true });
  }
}

interface Job { state: ArtifactState; promise: Promise<void> | null }

/** Tracks one runtime directory: present when its executable is found inside. */
class RuntimeSlot {
  private job: Job;
  constructor(
    private readonly root: () => string,
    private readonly spec: typeof ELECTRON_RUNTIME,
    private readonly text: StoreText,
    private readonly fetchImpl?: typeof fetch,
  ) {
    this.job = { state: { phase: 'absent', path: '', done: 0, total: null, detail: null }, promise: null };
  }

  get dir(): string {
    return join(this.root(), this.spec.id, this.spec.version);
  }

  get supported(): boolean {
    return platformKey() in this.spec.assets;
  }

  /** The executable inside the installed runtime, or null. */
  executable(): string | null {
    if (process.platform === 'darwin' && this.spec.id === 'electron') {
      const app = join(this.dir, 'Electron.app', 'Contents', 'MacOS', 'Electron');
      return existsSync(app) ? app : null;
    }
    return findFile(this.dir, this.spec.executable);
  }

  state(): ArtifactState {
    if (this.job.promise) return { ...this.job.state };
    const exe = this.executable();
    if (exe) return { phase: 'ready', path: this.dir, done: 0, total: null, detail: null };
    return { ...this.job.state, phase: this.job.state.phase === 'error' ? 'error' : 'absent', path: this.dir };
  }

  install(): Promise<void> {
    if (this.job.promise) return this.job.promise;
    const asset = this.spec.assets[platformKey()];
    if (!asset) {
      this.job.state = { phase: 'error', path: this.dir, done: 0, total: null, detail: this.text().noBuild(platformKey()) };
      return Promise.resolve();
    }
    this.job.state = { phase: 'working', path: this.dir, done: 0, total: asset.bytes, detail: this.text().downloading(asset.file) };
    const partial = `${this.dir}.partial`;
    const work = (async () => {
      rmSync(partial, { recursive: true, force: true });
      mkdirSync(partial, { recursive: true });
      const archive = join(partial, asset.file);
      const opts: DownloadOptions = { fetchImpl: this.fetchImpl, onProgress: (done, total) => { this.job.state.done = done; this.job.state.total = total ?? asset.bytes; } };
      await downloadFile(this.spec.url(asset.file), archive, opts);
      this.job.state.detail = this.text().unpacking;
      await extract(archive, partial, this.text());
      rmSync(archive, { force: true });
      writeFileSync(join(partial, 'cortico-runtime.json'), JSON.stringify({ id: this.spec.id, version: this.spec.version, source: this.spec.url(asset.file) }, null, 2));
      rmSync(this.dir, { recursive: true, force: true });
      renameSync(partial, this.dir);
      this.job.state = { phase: 'ready', path: this.dir, done: asset.bytes, total: asset.bytes, detail: null };
    })().catch((err: Error) => {
      rmSync(partial, { recursive: true, force: true });
      this.job.state = { phase: 'error', path: this.dir, done: 0, total: null, detail: err.message };
    }).finally(() => { this.job.promise = null; });
    this.job.promise = work;
    return work;
  }
}

/**
 * A model that comes as one archive: present when a file for every role is found inside and none
 * of them is empty. The archive is unpacked into the model's own directory, so a second download
 * starts from nothing rather than from half of two releases.
 */
class KwsSlot {
  private job: Job;
  constructor(private readonly root: () => string, private readonly spec: KwsModelSpec, private readonly text: StoreText, private readonly fetchImpl?: typeof fetch) {
    this.job = { state: { phase: 'absent', path: '', done: 0, total: null, detail: null }, promise: null };
  }

  get dir(): string {
    return join(this.root(), this.spec.id);
  }

  private findTokens(): string | null {
    return findByMatch(this.dir, this.spec.tokens);
  }

  /** Where each file lives, by role; a role whose file is missing is left out. */
  paths(): Record<string, string> {
    const out: Record<string, string> = { ...(pickExport(this.dir) ?? {}) };
    const tokens = this.findTokens();
    if (tokens) out.tokens = tokens;
    return out;
  }

  private whole(): boolean {
    const paths = this.paths();
    return KWS_ROLES.every((role) => {
      const hit = paths[role];
      return hit !== undefined && statSync(hit).size > 0;
    });
  }

  state(): ArtifactState {
    if (this.job.promise) return { ...this.job.state };
    if (this.whole()) return { phase: 'ready', path: this.dir, done: 0, total: null, detail: null };
    return { ...this.job.state, phase: this.job.state.phase === 'error' ? 'error' : 'absent', path: this.dir };
  }

  install(): Promise<void> {
    if (this.job.promise) return this.job.promise;
    this.job.state = { phase: 'working', path: this.dir, done: 0, total: null, detail: this.text().downloadingWake };
    const partial = `${this.dir}.partial`;
    const work = (async () => {
      rmSync(partial, { recursive: true, force: true });
      mkdirSync(partial, { recursive: true });
      const archive = join(partial, this.spec.archive);
      const errors: string[] = [];
      for (const source of this.spec.sources) {
        const url = source(this.spec.archive);
        try {
          this.job.state.detail = this.text().downloadingFrom(this.spec.archive, new URL(url).host);
          await downloadFile(url, archive, { fetchImpl: this.fetchImpl, onProgress: (done, total) => { this.job.state.done = done; this.job.state.total = total; } });
          break;
        } catch (err) {
          rmSync(archive, { force: true });
          errors.push(`${new URL(url).host}: ${(err as Error).message}`);
        }
      }
      if (!existsSync(archive)) throw new Error(this.text().failed(this.spec.archive, errors.join('; ')));
      this.job.state.detail = this.text().unpacking;
      await extract(archive, partial, this.text());
      rmSync(archive, { force: true });
      // the files are looked for inside `partial` before it is moved: a moved directory is easier to
      // get wrong than to check, and half of a model would then read as a whole one; the model that
      // is there stays until the new one has checked out whole
      if (!pickExport(partial) || !findByMatch(partial, this.spec.tokens)) {
        rmSync(partial, { recursive: true, force: true });
        throw new Error(this.text().failed(this.spec.archive, KWS_ROLES.join(' ')));
      }
      rmSync(this.dir, { recursive: true, force: true });
      renameSync(partial, this.dir);
      this.job.state = { phase: 'ready', path: this.dir, done: this.job.state.done, total: this.job.state.total, detail: null };
    })().catch((err: Error) => {
      rmSync(partial, { recursive: true, force: true });
      this.job.state = { phase: 'error', path: this.dir, done: 0, total: null, detail: err.message };
    }).finally(() => { this.job.promise = null; });
    this.job.promise = work;
    return work;
  }
}

export interface RuntimeStoreOptions {
  runtimesRoot: () => string;
  modelsDir: () => string;
  fetchImpl?: typeof fetch;
  /** The wake word model; tests pass a small archive. */
  kwsModel?: KwsModelSpec;
  /** The text table of the app language, read at each step; Chinese when absent. */
  text?: () => PetText;
}

export class RuntimeStore {
  readonly electron: RuntimeSlot;
  /** The wake word model (`src/voice/kws.ts`), downloaded as one archive. */
  readonly kws: KwsSlot;

  constructor(opts: RuntimeStoreOptions) {
    const text = () => (opts.text?.() ?? petText()).store;
    this.electron = new RuntimeSlot(opts.runtimesRoot, ELECTRON_RUNTIME, text, opts.fetchImpl);
    this.kws = new KwsSlot(opts.modelsDir, opts.kwsModel ?? KWS_MODEL, text, opts.fetchImpl);
  }
}
