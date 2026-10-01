import path from 'node:path';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import { app } from 'electron';

export interface PwResponse {
  ok(): boolean;
  status(): number;
  text(): Promise<string>;
  json(): Promise<unknown>;
}

export interface PwApiRequest {
  get(url: string, options?: Record<string, unknown>): Promise<PwResponse>;
}

export interface PwApiRequestContext extends PwApiRequest {
  dispose(): Promise<void>;
}

export interface PwRequestFactory {
  newContext(options?: Record<string, unknown>): Promise<PwApiRequestContext>;
}

export interface PwMouse {
  move(x: number, y: number, options?: Record<string, unknown>): Promise<void>;
  down(options?: Record<string, unknown>): Promise<void>;
  up(options?: Record<string, unknown>): Promise<void>;
  click(x: number, y: number, options?: Record<string, unknown>): Promise<void>;
  wheel(deltaX: number, deltaY: number): Promise<void>;
}

export interface PwKeyboard {
  press(key: string, options?: Record<string, unknown>): Promise<void>;
  insertText(text: string): Promise<void>;
}

export interface PwPage {
  url(): string;
  title(): Promise<string>;
  goto(url: string, options?: Record<string, unknown>): Promise<PwResponse | null>;
  reload(options?: Record<string, unknown>): Promise<PwResponse | null>;
  bringToFront(): Promise<void>;
  screenshot(options?: Record<string, unknown>): Promise<Buffer>;
  mouse: PwMouse;
  keyboard: PwKeyboard;
  evaluate<R>(fn: () => R | Promise<R>): Promise<R>;
  evaluate<R, A>(fn: (arg: A) => R | Promise<R>, arg: A): Promise<R>;
  on(event: string, listener: (...args: unknown[]) => void): this;
  isClosed(): boolean;
}

export interface PwContext {
  pages(): PwPage[];
  newPage(): Promise<PwPage>;
  close(): Promise<void>;
  clearCookies(): Promise<void>;
  request: PwApiRequest;
  setDefaultTimeout(timeout: number): void;
  setDefaultNavigationTimeout(timeout: number): void;
  on(event: string, listener: (...args: unknown[]) => void): this;
}

export interface PwBrowser {
  newContext(options?: Record<string, unknown>): Promise<PwContext>;
  close(options?: Record<string, unknown>): Promise<void>;
  isConnected(): boolean;
  on(event: string, listener: (...args: unknown[]) => void): this;
}

export interface PwBrowserType {
  executablePath(): string;
  launch(options?: Record<string, unknown>): Promise<PwBrowser>;
}

export interface PwRuntime {
  chromium: PwBrowserType;
  request: PwRequestFactory;
  devices: Record<string, Record<string, unknown>>;
}

let cached: PwRuntime | undefined;
const runtimeRequire = createRequire(__filename);

export function configurePlaywrightBrowserPath(): void {
  if (process.env.PLAYWRIGHT_BROWSERS_PATH) return;
  const devPath = path.join(app.getAppPath(), 'node_modules', 'playwright-core', '.local-browsers');
  const packagedPath = path.join(process.resourcesPath, 'playwright-browsers');
  const candidate = app.isPackaged ? packagedPath : devPath;
  if (fs.existsSync(candidate)) process.env.PLAYWRIGHT_BROWSERS_PATH = candidate;
}

export function getPlaywright(): PwRuntime {
  if (cached) return cached;
  configurePlaywrightBrowserPath();
  // Runtime require is deliberate: it lets packaged builds set PLAYWRIGHT_BROWSERS_PATH
  // before Playwright resolves its bundled executable locations.
  const runtime = runtimeRequire('playwright') as PwRuntime;
  cached = runtime;
  return runtime;
}

export function getPlaywrightVersion(): string | undefined {
  try {
    const pkg = runtimeRequire('playwright/package.json') as { version?: string };
    return pkg.version;
  } catch {
    return undefined;
  }
}
