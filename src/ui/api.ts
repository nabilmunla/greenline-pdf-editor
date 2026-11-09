// The PC side (Electron preload). Typed access.
/** a file moving to another window: where it is (the file, or the copy of its unsaved work), its name and page */
export interface TabMove {
  path: string | null;
  name: string;
  page: number;
  /** unsaved work: the recovery copy written for the move (and the file it's against, for huge files) */
  rec?: { key: string; file: string; base: { path: string; size: number; mtime: number } | null } | null;
  readOnly?: boolean;
  /** opened with its password: the other window opens it the same way */
  password?: string;
}

export interface AppInfo { version: string; user: string; winUser: string; platform: string; dataDir: string; localDir?: string; theme: 'light' | 'dark' | 'system'; open: string[] }
/** fileMtime: its file's time when the copy was made (the file server's clock, like the file's own) */
export interface Recovery { key: string; file: string; path: string | null; name: string; time: number; base?: { path: string; size: number; mtime: number } | null; fileMtime?: number }

export type AiProvider = 'anthropic' | 'openai';
export type AiPart = { t: 'text'; text: string } | { t: 'image'; b64: string; mime?: string } | { t: 'pdf'; b64: string; name?: string };
export interface AiMessage { role: 'user' | 'assistant'; parts: AiPart[]; cache?: boolean }
export interface AiRequest { model: string; system: string; messages: AiMessage[]; maxTokens?: number }
export type AiEvent = { type: 'delta'; text: string } | { type: 'done'; usage: Record<string, number> | null; stop: string } | { type: 'error'; message: string };

export interface SavedView { anchor: { page: number; x: number; y: number } | null; z: number; fit: 'width' | 'page' | 'none'; pages: number }

/** updates of an installed copy (see electron/updater.cjs) */
export interface UpdateState {
  state: 'idle' | 'checking' | 'none' | 'available' | 'downloading' | 'ready' | 'error' | 'off' | 'unreachable' | 'empty' | 'portable' | 'blocked' | 'setup';
  version: string; installed: boolean; scope: string; dir: string; source: string; setupSource: string; ownSource: boolean;
  /** the source is a web address (GitHub releases) - not a folder; defaultSource: the build's own */
  web?: boolean; defaultSource?: string;
  checked: number; previous: string; pendingAtExit: boolean;
  available?: string; notes?: string[]; groups?: NoteGroups | null; kind?: 'app' | 'full'; size?: number; pct?: number; err?: string; show?: boolean;
  /** 'blocked' / 'setup': the setup to run instead (in the updates folder - or, from the web, its download page) */
  setupPath?: string;
}
export interface ReportStatus { waiting: number; folder: string; queue: string; state: 'idle' | 'sent' | 'failed' | 'nofolder' | 'web'; err: string; at: number; sent: number; /** 'web': a new GitHub issue with the report filled in */ issue?: string;
  /** public build with a report receiver: reports go there anonymously; crashes: crash reports turned on */ anon?: boolean; crashes?: boolean }
/** what's new in a version, by group ("New features", "General polishing", "Fixes") */
export type NoteGroups = Record<string, string[]>;
export interface UpdatedInfo { from: string; to: string; notes: string[]; groups?: NoteGroups | null; back: boolean }

export interface GccApi {
  /** drawing engines asked for on the command line (tests); 0 = decided by the PC */
  renderers?: number;
  info(): Promise<AppInfo>;
  user(): Promise<string>;
  settings(): Promise<Record<string, any>>;
  /** the view a file was left at (page, spot, zoom) */
  viewGet(p: string): Promise<SavedView | null>;
  viewSet(p: string, v: SavedView): Promise<boolean>;
  setSettings(p: Record<string, unknown>): Promise<boolean>;
  /** a change another window made to the settings */
  onSettings(cb: (patch: Record<string, unknown>) => void): void;
  setTheme(m: 'light' | 'dark'): Promise<boolean>;
  setTitle(t: string): Promise<boolean>;
  read(p: string): Promise<Uint8Array>;
  /** real: the path with links and mapped drives resolved (lower case on Windows); fid: volume:file number ('' if unknown) */
  stat(p: string): Promise<{ size: number; mtime: number; writable: boolean; real?: string; fid?: string } | null>;
  write(p: string, data: Uint8Array, opts?: { noBackup?: boolean }): Promise<{ size: number; mtime: number }>;
  exists(p: string): Promise<boolean>;
  /** PDFs in a folder (kind 'pictures': JPG, PNG, TIFF, BMP, GIF) */
  listPdfs(dir: string, recursive?: boolean, kind?: 'pdf' | 'pictures'): Promise<string[]>;
  systemFont(name: string): Promise<Uint8Array | null>;
  cacheGet(k: string): Promise<Uint8Array | null>;
  cachePut(k: string, data: Uint8Array): Promise<boolean>;
  recoveryWrite(key: string, data: Uint8Array, meta: { path: string | null; name: string }): Promise<boolean>;
  recoveryClear(key: string): Promise<boolean>;
  recoveryList(): Promise<Recovery[]>;
  openDialog(o?: { title?: string; dir?: string; single?: boolean; filters?: { name: string; extensions: string[] }[] }): Promise<string[]>;
  saveDialog(o?: { title?: string; name?: string; path?: string; filters?: { name: string; extensions: string[] }[] }): Promise<string | null>;
  dirDialog(o?: { title?: string; dir?: string }): Promise<string | null>;
  confirm(o: { message: string; detail?: string; buttons: string[]; type?: string }): Promise<number>;
  copyImage(png: Uint8Array): Promise<boolean>;
  copyText(t: string, html?: string): Promise<boolean>;
  pasteImage(): Promise<Uint8Array | null>;
  showInFolder(p: string): Promise<boolean>;
  /** a file or folder the app wrote (or the backups folder) */
  openExternal(p: string): Promise<string>;
  /** a web / e-mail address in the browser (nothing else is opened) */
  openLink(url: string): Promise<boolean>;
  ready(): void;
  /** print: bytes, or an engine temp file */
  print(data: Uint8Array | string, name: string): Promise<boolean>;
  printers(): Promise<{ name: string; displayName: string; description: string; isDefault: boolean; status: number }[]>;
  /** the printer chosen last in this run ('' at first); with a name: remembers it (until the app closes) */
  sessionPrinter(name?: string): Promise<string>;
  /** send an engine print file to a printer (silent), or through Windows' print dialog */
  /** the printer's own preferences window (Windows): ok false when it couldn't open */
  printPrefs(name: string): Promise<{ ok: boolean; reason?: string }>;
  printRun(file: string, o: { deviceName?: string; copies?: number; collate?: boolean; color?: boolean; duplex?: 'simplex' | 'longEdge' | 'shortEdge'; sheet?: { w: number; h: number }; sheets?: number; dialog?: boolean }): Promise<{ ok: boolean; reason: string }>;
  /** pages dragged out: bytes, or an engine temp file (moved into the drag folder) */
  dragPrepare(data: Uint8Array | string, name: string): Promise<string>;
  aiKeys(): Promise<{ anthropic: boolean; openai: boolean; secure: boolean }>;
  /** check: try the key with the service first and keep the old one if it fails */
  aiSetKey(provider: AiProvider, key: string, check?: boolean): Promise<boolean>;
  aiModels(provider: AiProvider): Promise<{ id: string; name: string; created: number | string }[]>;
  aiSend(id: string, provider: AiProvider, req: AiRequest): Promise<boolean>;
  aiCancel(id: string): Promise<boolean>;
  onAiEvent(cb: (id: string, ev: AiEvent) => void): () => void;
  /** offline translator (Mozilla Firefox Translations models, downloaded once per language) */
  mtLanguages(): Promise<string[]>;
  mtStatus(from: string, to: string): Promise<{ ok: boolean; installed?: boolean; download?: number; pivot?: boolean; error?: string; version?: string; update?: { download: number; version: string } | null }>;
  mtInstall(from: string, to: string): Promise<boolean>;
  mtTranslate(from: string, to: string, texts: string[]): Promise<string[]>;
  onMtProgress(cb: (pair: string, done: number, total: number) => void): () => void;
  /** HTML (a translation...) made into a PDF by Chromium; returns a temp file */
  htmlToPdf(html: string, name: string, opts?: { landscape?: boolean }): Promise<string>;
  enginesStart(list: { name: string; role: string }[]): Promise<boolean>;
  /** move an engine temp file to `file` (backup + safe swap) */
  commit(src: string, file: string, opts?: { noBackup?: boolean }): Promise<{ size: number; mtime: number; inPlace: boolean }>;
  dropTemp(paths: string[]): Promise<boolean>;
  toTemp(src: string): Promise<string>;
  docsClosed(): void;
  recoveryPath(key: string): Promise<string>;
  recoveryMeta(key: string, meta: Record<string, unknown>): Promise<boolean>;
  dragStart(file: string, png: Uint8Array | null): void;
  registerOpenWith(): Promise<{ ok: boolean; msg?: string }>;
  pathOf(f: File): string;
  onOpen(cb: (files: string[]) => void): void;
  /** PDFs picked in Explorer > Combine with PDF Editor */
  onCombine(cb: (files: string[]) => void): void;
  onClosing(cb: (o: { restart?: boolean }) => void): void;
  closeCancelled(): void;
  updateGet(): Promise<UpdateState>;
  updateCheck(): Promise<UpdateState>;
  updateDownload(): Promise<UpdateState>;
  updateCancel(): Promise<UpdateState>;
  updateLater(): Promise<boolean>;
  updateSource(v: string | null): Promise<UpdateState>;
  updateRestart(now: boolean): Promise<boolean>;
  updateRollback(): Promise<boolean | 'blocked'>;
  updateAfterStart(): Promise<UpdatedInfo | null>;
  onUpdate(cb: (st: UpdateState) => void): () => void;
  reportCapture(): Promise<string | null>;
  reportProblem(text: string, withShot: boolean, extra?: Record<string, unknown>): Promise<ReportStatus>;
  reportStatus(): Promise<ReportStatus>;
  /** public build: anonymous crash reports on / off; preview = what one looks like (JSON) */
  reportCrashSharing(on: boolean): Promise<ReportStatus>;
  reportPreview(): Promise<string>;
  reportOpenQueue(): Promise<string>;
  reportCrash(where: string, message: string, stack: string): void;
  onReports(cb: () => void): () => void;
  closed(): void;
  tabStrip(r: { x: number; y: number; w: number; h: number }): void;
  tabPaths(list: string[]): void;
  /** files open in this app's other windows (lower case) */
  tabsElsewhere(): Promise<string[]>;
  tabTarget(x: number, y: number): Promise<number | null>;
  tabHover(x: number | null, y: number | null): void;
  tabMove(payload: TabMove, target: number | null, x: number, y: number): Promise<boolean>;
  onAdopt(cb: (p: TabMove & { transfer: number }) => void): void;
  adopted(id: number, ok: boolean): void;
  onTabHover(cb: (on: boolean) => void): void;
  windowCount(): Promise<number>;
  log(line: string): void;
}

export const gcc: GccApi = (window as unknown as { gcc: GccApi }).gcc;

export const baseName = (p: string) => p.split(/[\\/]/).pop() || p;
export const dirName = (p: string) => p.replace(/[\\/][^\\/]*$/, '');
export const joinPath = (d: string, f: string) => d.replace(/[\\/]+$/, '') + (d.includes('\\') ? '\\' : '/') + f;
