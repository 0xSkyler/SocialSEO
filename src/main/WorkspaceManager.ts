import { EventEmitter } from 'node:events';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { app } from 'electron';
import log from 'electron-log/main';
import type { WorkspacePreferences } from '../shared/types/browser';
import type { ProxyRecord } from '../shared/types/proxy';
import type { WorkspaceState } from '../shared/types/workspace';
import { EngineResolver } from './browser/EngineResolver';
import { getPlaywright, type PwBrowser, type PwContext, type PwPage } from './browser/PlaywrightRuntime';
import { ProxyManager } from './ProxyManager';
import { runKeepAliveSession } from './automation/KeepAliveSession';
import { SettingsManager } from './SettingsManager';

interface WorkspaceRuntime {
  state: WorkspaceState;
  rotationTimer?: NodeJS.Timeout;
  activeClose?: () => Promise<void>;
  activeRunId?: string;
  stopRequested?: boolean;
  automationEnabled?: boolean;
  consecutiveProxyFailures?: number;
}

const DEFAULT_TARGET = 'https://www.google.com/';
const MOBILE_VIEWPORT = { width: 390, height: 844 } as const;
const CLOSE_TIMEOUT_MS = 5000;
const PROXY_RETRY_COOLDOWN_MS = 15_000;
const INITIAL_PAGE_LOAD_TIMEOUT_MS = 10_000;

function isInitialPageLoadTimeout(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return message.includes('page.goto') && message.includes('Timeout ' + INITIAL_PAGE_LOAD_TIMEOUT_MS + 'ms exceeded');
}
function isPageGotoFailure(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return message.includes('page.goto');
}

function isProxyTransportFailure(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return [
    'ERR_PROXY_CONNECTION_FAILED',
    'ERR_TUNNEL_CONNECTION_FAILED',
    'ERR_SOCKS_CONNECTION_FAILED',
    'ERR_NO_SUPPORTED_PROXIES',
    'ERR_PROXY_CERTIFICATE_INVALID',
    'ERR_MANDATORY_PROXY_CONFIGURATION_FAILED',
    'ERR_CONNECTION_RESET',
    'ERR_CONNECTION_REFUSED',
    'ERR_CONNECTION_CLOSED',
    'ERR_ADDRESS_UNREACHABLE',
    'ERR_NETWORK_CHANGED',
    'ERR_TIMED_OUT',
    'ERR_NAME_NOT_RESOLVED',
    'SOCKS connection failed',
    'Proxy connection failed',
    'tunnel connection failed'
  ].some((token) => message.includes(token));
}


async function withTimeout<T>(promise: Promise<T>, timeoutMs: number, label: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<T>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error(`${label} timed out after ${timeoutMs}ms`)), timeoutMs);
      })
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function normalizeUrl(input: string): string {
  const value = input.trim();
  if (!value) return DEFAULT_TARGET;
  const candidate = /^[a-z][a-z0-9+.-]*:/i.test(value) ? value : `https://${value}`;
  let parsed: URL;
  try { parsed = new URL(candidate); } catch { throw new Error('Enter a valid web address'); }
  if (!['http:', 'https:'].includes(parsed.protocol)) throw new Error('Only HTTP and HTTPS pages are allowed');
  return parsed.toString();
}

function publicProxy(proxy?: ProxyRecord): WorkspaceState['proxy'] {
  if (!proxy) return undefined;
  const safe = { ...proxy };
  delete safe.password;
  return safe;
}

function proxyOptions(proxy?: ProxyRecord): Record<string, unknown> | undefined {
  if (!proxy) return undefined;
  return {
    server: `${proxy.protocol}://${proxy.host}:${proxy.port}`,
    username: proxy.username,
    password: proxy.password
  };
}

function mobileOptions(): Record<string, unknown> {
  return {
    viewport: MOBILE_VIEWPORT,
    screen: MOBILE_VIEWPORT,
    deviceScaleFactor: 3,
    hasTouch: true,
    isMobile: true,
    locale: 'en-US',
    colorScheme: 'dark',
    userAgent: 'Mozilla/5.0 (Linux; Android 15; Pixel 9 Pro) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/153.0.0.0 Mobile Safari/537.36'
  };
}

/**
 * Lightweight slot manager.
 *
 * A "workspace" is a logical configuration slot until Start is pressed.
 * Started slots each own an independent temporary Chromium process/context while
 * Keep Alive is active. All started slots run concurrently; there is no queue.
 * URL distribution itself remains assignment-only and never launches Chromium.
 */
export class WorkspaceManager extends EventEmitter {
  private readonly runtimes = new Map<number, WorkspaceRuntime>();
  private readonly prefsFile = path.join(app.getPath('userData'), 'workspace-preferences.json');
  private readonly resolver = new EngineResolver();
  private prefs: WorkspacePreferences[];

  constructor(private readonly settings: SettingsManager, private readonly proxies: ProxyManager) {
    super();
    this.prefs = this.loadPreferences();
    this.initializeStates();
  }

  private loadPreferences(): WorkspacePreferences[] {
    const settings = this.settings.get();
    let stored: Partial<WorkspacePreferences>[] = [];
    try {
      if (fs.existsSync(this.prefsFile)) stored = JSON.parse(fs.readFileSync(this.prefsFile, 'utf8')) as Partial<WorkspacePreferences>[];
    } catch { stored = []; }

    return Array.from({ length: settings.browserCount }, (_, index) => {
      const id = index + 1;
      const previous = stored.find((item) => item.id === id);
      void previous;
      return {
        id,
        engine: 'chromium',
        targetUrl: DEFAULT_TARGET,
        rotationSeconds: Math.max(0, Math.floor(settings.defaultRotationSeconds)),
        keepAlive: false
      };
    });
  }

  private savePreferences(): void {
    fs.mkdirSync(path.dirname(this.prefsFile), { recursive: true });
    const persisted = this.prefs.map((pref) => ({
      id: pref.id,
      engine: 'chromium' as const,
      targetUrl: DEFAULT_TARGET,
      rotationSeconds: pref.rotationSeconds,
      keepAlive: false
    }));
    fs.writeFileSync(this.prefsFile, JSON.stringify(persisted, null, 2), 'utf8');
  }

  private initializeStates(): void {
    for (const pref of this.prefs) {
      const engine = this.resolver.get();
      this.runtimes.set(pref.id, {
        state: {
          id: pref.id,
          title: `Slot ${pref.id}`,
          url: pref.targetUrl,
          targetUrl: pref.targetUrl,
          status: engine.available ? 'stopped' : 'unavailable',
          engine: 'chromium',
          engineLabel: 'Chromium · on demand',
          engineAvailable: engine.available,
          keepAlive: false,
          rotationSeconds: pref.rotationSeconds,
          visitedLinks: 0,
          runCount: 0,
          proxy: publicProxy(this.proxies.getAssignedProxy(pref.id)),
          error: engine.available ? undefined : engine.detail
        }
      });
    }
  }

  getStates(): WorkspaceState[] {
    return [...this.runtimes.values()]
      .sort((a, b) => a.state.id - b.state.id)
      .map((runtime) => structuredClone(runtime.state));
  }

  private workspaceIds(): number[] {
    return [...this.runtimes.keys()].sort((a, b) => a - b);
  }

  private require(id: number): WorkspaceRuntime {
    const runtime = this.runtimes.get(id);
    if (!runtime) throw new Error(`Unknown slot ${id}`);
    return runtime;
  }

  private getPref(id: number): WorkspacePreferences {
    const pref = this.prefs.find((item) => item.id === id);
    if (!pref) throw new Error(`Unknown slot ${id}`);
    return pref;
  }

  private patch(id: number, patch: Partial<WorkspaceState>): void {
    const runtime = this.require(id);
    runtime.state = { ...runtime.state, ...patch };
    this.emit('state', structuredClone(runtime.state));
  }

  async reconcileBrowserCount(count: number): Promise<void> {
    const target = Math.min(100, Math.max(1, Math.floor(Number(count) || 10)));

    for (const id of this.workspaceIds().filter((value) => value > target)) {
      await this.stop(id);
      this.runtimes.delete(id);
    }
    this.prefs = this.prefs.filter((pref) => pref.id <= target);

    const settings = this.settings.get();
    for (let id = 1; id <= target; id += 1) {
      if (this.runtimes.has(id)) continue;
      const engine = this.resolver.get();
      const pref: WorkspacePreferences = {
        id,
        engine: 'chromium',
        targetUrl: DEFAULT_TARGET,
        rotationSeconds: Math.max(0, Math.floor(settings.defaultRotationSeconds)),
        keepAlive: false
      };
      this.prefs.push(pref);
      this.runtimes.set(id, {
        state: {
          id,
          title: `Slot ${id}`,
          url: DEFAULT_TARGET,
          targetUrl: DEFAULT_TARGET,
          status: engine.available ? 'stopped' : 'unavailable',
          engine: 'chromium',
          engineLabel: 'Chromium · on demand',
          engineAvailable: engine.available,
          keepAlive: false,
          rotationSeconds: pref.rotationSeconds,
          visitedLinks: 0,
          runCount: 0,
          proxy: publicProxy(this.proxies.getAssignedProxy(id)),
          error: engine.available ? undefined : engine.detail
        }
      });
    }

    this.prefs.sort((a, b) => a.id - b.id);
    this.proxies.syncBrowserCount(target);
    this.savePreferences();
  }

  private browserLaunchOptions(): Record<string, unknown> {
    return {
      headless: true,
      timeout: 20_000,
      args: [
        '--disable-background-timer-throttling',
        '--disable-backgrounding-occluded-windows',
        '--disable-renderer-backgrounding',
        '--disable-features=CalculateNativeWinOcclusion',
        '--disk-cache-size=1',
        '--media-cache-size=1',
        '--disable-application-cache'
      ]
    };
  }

  private contextOptions(proxy: ProxyRecord): Record<string, unknown> {
    if (proxy.status !== 'working') throw new Error('NO_LIVE_PROXY_ASSIGNED');
    return {
      ...mobileOptions(),
      proxy: proxyOptions(proxy),
      acceptDownloads: false,
      ignoreHTTPSErrors: false,
      serviceWorkers: 'block',
      extraHTTPHeaders: {
        'Cache-Control': 'no-cache, no-store, max-age=0',
        Pragma: 'no-cache'
      }
    };
  }

  private async closeTemporary(browser?: PwBrowser, context?: PwContext): Promise<void> {
    if (context) {
      await withTimeout(context.close(), CLOSE_TIMEOUT_MS, 'Temporary Chromium context close').catch((error) => {
        log.warn('[lightweight] Temporary context close did not complete cleanly', error);
      });
    }
    if (browser?.isConnected()) {
      await withTimeout(browser.close(), CLOSE_TIMEOUT_MS, 'Temporary Chromium process close').catch((error) => {
        log.warn('[lightweight] Temporary browser close did not complete cleanly', error);
      });
    }
  }

  private async withTemporaryPage<T>(
    id: number,
    initialUrl: string,
    operation: (page: PwPage, context: PwContext) => Promise<T>,
    settleAfter = true
  ): Promise<T> {
    const runtime = this.require(id);
    const engine = this.resolver.get();
    if (!engine.available) {
      this.patch(id, { status: 'unavailable', engineAvailable: false, error: engine.detail });
      throw new Error(engine.detail);
    }

    if (runtime.activeRunId) throw new Error(`Slot ${id} is already running.`);

    const assignedProxy = this.proxies.getAssignedProxy(id);
    if (!assignedProxy || assignedProxy.status !== 'working' || !this.proxies.isStoredLiveProxy(assignedProxy.id)) {
      this.patch(id, {
        status: 'waiting_proxy',
        error: 'Waiting for a validated live proxy. Chromium has not been launched.',
        proxy: publicProxy(assignedProxy),
        engineAvailable: true,
        engineLabel: 'Chromium · blocked until proxy is live'
      });
      throw new Error('NO_LIVE_PROXY_ASSIGNED');
    }

    this.patch(id, {
      status: 'launching',
      error: undefined,
      proxy: publicProxy(assignedProxy),
      engineAvailable: true,
      engineLabel: 'Chromium · temporary'
    });

    const runId = randomUUID();
    runtime.activeRunId = runId;
    runtime.stopRequested = false;

    let browser: PwBrowser | undefined;
    let context: PwContext | undefined;
    try {
      browser = await withTimeout(
        getPlaywright().chromium.launch(this.browserLaunchOptions()),
        20_000,
        `Slot ${id} Chromium launch`
      );
      runtime.activeClose = () => this.closeTemporary(browser, context);
      context = await withTimeout(
        browser.newContext(this.contextOptions(assignedProxy)),
        15_000,
        `Slot ${id} temporary context creation`
      );
      context.setDefaultTimeout(15_000);
      context.setDefaultNavigationTimeout(45_000);
      const page = context.pages()[0] ?? await context.newPage();
      this.patch(id, { status: 'loading' });
      await page.goto(initialUrl, { waitUntil: 'domcontentloaded', timeout: INITIAL_PAGE_LOAD_TIMEOUT_MS });
      runtime.consecutiveProxyFailures = 0;
      this.patch(id, { status: 'running', url: page.url(), title: (await page.title()) || `Slot ${id}` });
      return await operation(page, context);
    } catch (error) {
      if (runtime.activeRunId === runId && runtime.stopRequested) {
        this.patch(id, { status: 'stopped', error: undefined });
        throw new Error(`Slot ${id} stopped by user.`);
      }
      const message = error instanceof Error ? error.message : String(error);
      this.patch(id, { status: 'error', error: message });
      throw error;
    } finally {
      await this.closeTemporary(browser, context);
      if (runtime.activeRunId === runId) {
        runtime.activeClose = undefined;
        runtime.activeRunId = undefined;
        runtime.stopRequested = false;
      }
      if (settleAfter && !runtime.automationEnabled) {
        const current = this.require(id);
        this.patch(id, {
          status: current.state.engineAvailable ? 'stopped' : 'unavailable',
          engineLabel: 'Chromium · on demand',
          nextRotationAt: undefined
        });
      } else {
        this.patch(id, { engineLabel: 'Chromium · on demand' });
      }
    }
  }

  private startVisit(id: number): void {
    const runtime = this.require(id);
    if (!runtime.automationEnabled || runtime.activeRunId) return;
    void this.performVisitCycle(id).catch((error) => {
      log.warn(`[concurrent] Slot ${id} visit cycle failed unexpectedly`, error);
    });
  }

  private async performVisitCycle(id: number): Promise<void> {
    const runtime = this.require(id);
    if (!runtime.automationEnabled) return;
    const pref = this.getPref(id);
    const started = Date.now();
    const rotationMs = pref.rotationSeconds > 0 ? pref.rotationSeconds * 1000 : 0;
    let rotationDeadline: number | undefined;

    try {
      this.patch(id, { keepAlive: false, visitedLinks: 0, nextRotationAt: undefined });

      const liveProxy = await this.proxies.ensureWorkingProxy(id);
      if (!liveProxy) {
        this.patch(id, {
          status: 'waiting_proxy',
          proxy: publicProxy(this.proxies.getAssignedProxy(id)),
          keepAlive: false,
          nextRotationAt: new Date(Date.now() + PROXY_RETRY_COOLDOWN_MS).toISOString(),
          error: 'No proxy is available from the private API yet. Chromium remains closed.'
        });
        this.scheduleVisitAfter(id, PROXY_RETRY_COOLDOWN_MS, 'Waiting for a proxy from the private API. No direct-network browser launch is allowed.');
        return;
      }
      this.patch(id, { proxy: publicProxy(liveProxy), error: undefined });

      await this.withTemporaryPage(id, pref.targetUrl, async (page) => {
        await new Promise((resolve) => setTimeout(resolve, 1200));
        if (runtime.stopRequested) throw new Error(`Slot ${id} stopped by user.`);
        this.patch(id, { url: page.url(), title: (await page.title()) || `Slot ${id}` });

        if (rotationMs > 0) {
          rotationDeadline = Date.now() + rotationMs;
          this.patch(id, { status: 'running', keepAlive: true, nextRotationAt: new Date(rotationDeadline).toISOString() });
          await runKeepAliveSession(page, {
            deadlineMs: rotationDeadline,
            rules: { ...this.settings.get().keepAlive, sameOriginOnly: true },
            shouldStop: () => Boolean(runtime.stopRequested || !runtime.automationEnabled),
            onHop: async (url) => {
              const current = this.require(id);
              this.patch(id, {
                url,
                title: (await page.title()) || current.state.title,
                visitedLinks: current.state.visitedLinks + 1,
                status: 'running',
                keepAlive: true
              });
            },
            onActivity: async (url) => {
              this.patch(id, { url, title: (await page.title()) || `Slot ${id}`, status: 'running', keepAlive: true });
            }
          });
        }
      }, false);

      if (!runtime.automationEnabled) return;
      const completedAt = new Date().toISOString();
      const runCount = (runtime.state.runCount ?? 0) + 1;
      this.patch(id, {
        runCount,
        lastRunAt: completedAt,
        lastRunDurationMs: Date.now() - started,
        keepAlive: false,
        error: undefined,
        nextRotationAt: undefined
      });
      await this.proxies.refreshForBrowserCycle(runCount).catch((error) => {
        log.warn('[proxy-source] Cycle ' + runCount + ' refresh failed; current sessions continue.', error);
      });

      if (pref.rotationSeconds > 0) {
        this.patch(id, { status: 'rotating' });
        await this.rotateProxy(id).catch(() => false);
        if (runtime.automationEnabled) this.startVisit(id);
      } else {
        runtime.automationEnabled = false;
        this.patch(id, { status: 'completed', keepAlive: false, nextRotationAt: undefined });
      }
    } catch (error) {
      this.patch(id, { keepAlive: false });
      if (!runtime.automationEnabled || runtime.stopRequested || String(error).includes('stopped by user')) {
        this.patch(id, { status: runtime.state.engineAvailable ? 'stopped' : 'unavailable', nextRotationAt: undefined });
        return;
      }

      const message = error instanceof Error ? error.message : String(error);
      this.patch(id, {
        lastRunAt: new Date().toISOString(),
        lastRunDurationMs: Date.now() - started,
        error: message
      });

      if (isInitialPageLoadTimeout(error)) {
        this.proxies.markAssignedProxyDead(id, message);
        const replacement = await this.proxies.ensureWorkingProxy(id).catch(() => undefined);
        if (replacement) {
          runtime.consecutiveProxyFailures = 0;
          this.patch(id, {
            status: 'rotating',
            proxy: publicProxy(replacement),
            keepAlive: false,
            nextRotationAt: undefined,
            error: 'Page did not load within 10 seconds. Rotating immediately to a different unused proxy.'
          });
          this.startVisit(id);
          return;
        }
        this.scheduleVisitAfter(id, 1000, 'No unused proxy is available. Refreshing the private proxy API; Chromium remains closed.');
        return;
      }

      if (isPageGotoFailure(error) || isProxyTransportFailure(error)) {
        runtime.consecutiveProxyFailures = 0;
        this.proxies.markAssignedProxyDead(id, message);
        this.patch(id, {
          status: 'rotating',
          keepAlive: false,
          nextRotationAt: undefined,
          error: 'Proxy/network error detected. Rotating immediately.'
        });

        const replacement = await this.proxies.ensureWorkingProxy(id).catch(() => undefined);
        if (replacement) {
          this.patch(id, { proxy: publicProxy(replacement), error: undefined });
          this.startVisit(id);
          return;
        }

        this.scheduleVisitAfter(id, 1000, 'No unused proxy is available. Refreshing the private proxy API; Chromium remains closed.');
        return;
      }

      runtime.consecutiveProxyFailures = 0;
      if (pref.rotationSeconds > 0) {
        // Non-proxy failures retain the configured cadence instead of rapidly retrying.
        this.patch(id, { status: 'running' });
        this.scheduleNextVisit(id);
      } else {
        runtime.automationEnabled = false;
        this.patch(id, { status: 'error', nextRotationAt: undefined });
      }
    }
  }

  private scheduleVisitAfter(id: number, delayMs: number, statusMessage?: string): void {
    const runtime = this.require(id);
    if (runtime.rotationTimer) clearTimeout(runtime.rotationTimer);
    runtime.rotationTimer = undefined;

    if (!runtime.automationEnabled) {
      this.patch(id, { nextRotationAt: undefined });
      return;
    }

    const safeDelayMs = Math.max(250, Math.floor(delayMs));
    const next = new Date(Date.now() + safeDelayMs).toISOString();
    this.patch(id, {
      status: 'rotating',
      nextRotationAt: next,
      error: statusMessage
    });
    runtime.rotationTimer = setTimeout(() => {
      runtime.rotationTimer = undefined;
      if (!runtime.automationEnabled) return;
      this.startVisit(id);
    }, safeDelayMs);
    runtime.rotationTimer.unref?.();
  }

  private scheduleNextVisit(id: number): void {
    const runtime = this.require(id);
    const pref = this.getPref(id);
    if (runtime.rotationTimer) clearTimeout(runtime.rotationTimer);
    runtime.rotationTimer = undefined;

    if (!runtime.automationEnabled || pref.rotationSeconds <= 0) {
      this.patch(id, { nextRotationAt: undefined });
      return;
    }

    const next = new Date(Date.now() + pref.rotationSeconds * 1000).toISOString();
    this.patch(id, { status: 'running', nextRotationAt: next });
    runtime.rotationTimer = setTimeout(() => {
      runtime.rotationTimer = undefined;
      if (!runtime.automationEnabled) return;
      void this.rotateProxy(id)
        .catch(() => false)
        .finally(() => this.startVisit(id));
    }, pref.rotationSeconds * 1000);
    runtime.rotationTimer.unref?.();
  }

  private assignTarget(id: number, input: string): string {
    const url = normalizeUrl(input);
    const pref = this.getPref(id);
    const runtime = this.require(id);
    pref.targetUrl = url;
    pref.keepAlive = false;
    this.patch(id, {
      targetUrl: url,
      url,
      keepAlive: false,
      visitedLinks: 0,
      error: undefined,
      status: runtime.automationEnabled ? runtime.state.status : (runtime.state.engineAvailable ? 'stopped' : 'unavailable')
    });
    return url;
  }

  async clearBrowserData(workspaceIds: number[]): Promise<number[]> {
    const ids = [...new Set(workspaceIds)]
      .filter((id) => Number.isInteger(id) && this.runtimes.has(id))
      .sort((a, b) => a - b);

    for (const id of ids) {
      await this.stop(id);
      const pref = this.getPref(id);
      pref.targetUrl = DEFAULT_TARGET;
      pref.keepAlive = false;
      this.patch(id, {
        title: `Slot ${id}`,
        targetUrl: DEFAULT_TARGET,
        url: DEFAULT_TARGET,
        keepAlive: false,
        visitedLinks: 0,
        runCount: 0,
        lastRunAt: undefined,
        lastRunDurationMs: undefined,
        detectedIp: undefined,
        lastIpCheckAt: undefined,
        error: undefined,
        status: this.require(id).state.engineAvailable ? 'stopped' : 'unavailable'
      });
    }
    this.savePreferences();
    return ids;
  }

  /**
   * Start a logical slot. The slot remains logically active without keeping a
   * browser resident while idle. A positive rotation interval keeps one temporary
   * Chromium session alive for that slot, runs Keep Alive (scroll + same-origin
   * article hops) until the rotation deadline, closes Chromium, rotates the proxy,
   * and immediately starts a fresh session. Rotation 0 performs one visit and ends COMPLETED.
   */
  async launch(id: number): Promise<void> {
    const runtime = this.require(id);
    if (!runtime.state.engineAvailable) throw new Error(runtime.state.error ?? 'Chromium is unavailable.');
    runtime.automationEnabled = true;
    runtime.stopRequested = false;
    runtime.consecutiveProxyFailures = 0;
    if (runtime.rotationTimer) clearTimeout(runtime.rotationTimer);
    runtime.rotationTimer = undefined;
    this.startVisit(id);
  }

  async launchAll(): Promise<void> {
    await Promise.all(this.workspaceIds().map((id) => this.launch(id)));
  }

  async stop(id: number): Promise<void> {
    const runtime = this.require(id);
    runtime.automationEnabled = false;
    runtime.stopRequested = true;
    runtime.consecutiveProxyFailures = 0;
    if (runtime.rotationTimer) clearTimeout(runtime.rotationTimer);
    runtime.rotationTimer = undefined;
    if (runtime.activeClose) {
      await runtime.activeClose().catch(() => undefined);
      runtime.activeClose = undefined;
    }
    this.patch(id, {
      status: runtime.state.engineAvailable ? 'stopped' : 'unavailable',
      nextRotationAt: undefined,
      error: undefined
    });
  }

  async stopAll(): Promise<void> {
    await Promise.all(this.workspaceIds().map((id) => this.stop(id)));
  }

  async focus(id: number): Promise<void> {
    await this.launch(id);
  }

  /** One-off compatibility navigation. Central distribution uses setTarget/applyTargets instead. */
  async navigate(id: number, input: string): Promise<void> {
    const url = this.assignTarget(id, input);
    await this.withTemporaryPage(id, url, async () => undefined);
  }

  /** Save a URL into a logical slot. This never launches Chromium. */
  async setTarget(id: number, input: string): Promise<void> {
    this.assignTarget(id, input);
  }

  /** Pure in-memory target distribution. No browser process is created here. */
  async applyTargets(entries: Array<{ id: number; url: string }>): Promise<void> {
    const byWorkspace = new Map<number, string>();
    for (const entry of entries) {
      if (this.runtimes.has(entry.id)) byWorkspace.set(entry.id, entry.url);
    }
    for (const [id, url] of byWorkspace) this.assignTarget(id, url);
  }


  async reload(id: number): Promise<void> {
    const runtime = this.require(id);
    if (runtime.automationEnabled || runtime.activeRunId) await this.stop(id);
    await this.launch(id);
  }

  async reloadAll(): Promise<void> {
    await Promise.all(this.workspaceIds().map((id) => this.reload(id)));
  }

  /**
   * Apply the central Keep Alive / rotation interval to every logical slot.
   * When requested, active slots are restarted concurrently so both the new
   * deadline and newly saved Keep Alive rules take effect immediately.
   */
  async applyGlobalRuntimeSettings(seconds: number, restartActive: boolean): Promise<void> {
    const normalized = Math.max(0, Math.floor(Number(seconds) || 0));
    const activeIds = this.workspaceIds().filter((id) => Boolean(this.require(id).automationEnabled));

    for (const id of this.workspaceIds()) {
      const pref = this.getPref(id);
      pref.rotationSeconds = normalized;
      this.patch(id, { rotationSeconds: normalized });
    }
    this.savePreferences();

    if (!restartActive || activeIds.length === 0) return;

    // Close current sessions first so no slot briefly owns two Chromium processes.
    await Promise.all(activeIds.map((id) => this.stop(id)));

    // Browser close interrupts the in-flight Keep Alive operation asynchronously.
    // Wait for each old run to finish its cleanup before starting the replacement.
    await Promise.all(activeIds.map(async (id) => {
      const started = Date.now();
      while (this.require(id).activeRunId && Date.now() - started < 10_000) {
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
      if (this.require(id).activeRunId) throw new Error(`Slot ${id} did not stop cleanly while applying settings.`);
    }));

    await Promise.all(activeIds.map((id) => this.launch(id)));
  }

  async setKeepAlive(id: number, enabled: boolean): Promise<void> {
    const pref = this.getPref(id);
    pref.keepAlive = enabled;
    this.patch(id, { keepAlive: enabled && Boolean(this.require(id).activeRunId), visitedLinks: enabled ? this.require(id).state.visitedLinks : 0 });
    this.savePreferences();
  }

  async setKeepAliveAll(enabled: boolean): Promise<void> {
    for (const id of this.workspaceIds()) {
      const pref = this.getPref(id);
      pref.keepAlive = enabled;
      this.patch(id, { keepAlive: enabled && Boolean(this.require(id).activeRunId), visitedLinks: enabled ? this.require(id).state.visitedLinks : 0 });
    }
    this.savePreferences();
  }

  async rotateProxy(id: number): Promise<boolean> {
    const replacement = this.proxies.chooseReplacement(id);
    if (!replacement || replacement.status !== 'working') {
      this.patch(id, { status: 'waiting_proxy', error: 'No unused proxy from the current API pool is available yet.' });
      return false;
    }
    this.patch(id, {
      proxy: publicProxy(replacement),
      detectedIp: undefined,
      error: undefined
    });
    return true;
  }

  async applyAssignments(): Promise<void> {
    for (const id of this.workspaceIds()) {
      this.patch(id, {
        proxy: publicProxy(this.proxies.getAssignedProxy(id)),
        detectedIp: undefined,
        error: undefined
      });
    }
  }

  async applyLiveAssignment(id: number): Promise<void> {
    this.patch(id, {
      proxy: publicProxy(this.proxies.getAssignedProxy(id)),
      detectedIp: undefined,
      error: undefined
    });
  }

  /** Wake a slot as soon as the background validator assigns a stored live proxy. */
  async onLiveProxyAssigned(id: number): Promise<void> {
    await this.applyLiveAssignment(id);
    const runtime = this.require(id);
    if (runtime.automationEnabled && !runtime.activeRunId) this.startVisit(id);
  }

  async assignOne(id: number, proxyId?: string): Promise<void> {
    this.proxies.setAssignment(id, proxyId);
    this.patch(id, {
      proxy: publicProxy(this.proxies.getAssignedProxy(id)),
      detectedIp: undefined,
      error: undefined
    });
  }

  async replaceProxy(id: number): Promise<boolean> {
    return this.rotateProxy(id);
  }

  async checkIp(id: number): Promise<string | undefined> {
    const checkUrl = this.settings.get().ipCheckUrl;
    let ip: string | undefined;
    await this.withTemporaryPage(id, DEFAULT_TARGET, async (_page, context) => {
      const response = await context.request.get(checkUrl, { timeout: this.settings.get().validation.timeoutSeconds * 1000 });
      if (!response.ok()) throw new Error(`IP check returned HTTP ${response.status()}`);
      const text = await response.text();
      ip = text.trim();
      try {
        const parsed = JSON.parse(text) as { ip?: string };
        ip = parsed.ip ?? ip;
      } catch { /* plain text response */ }
      this.patch(id, { detectedIp: ip, lastIpCheckAt: new Date().toISOString() });
    });
    return ip;
  }

  async checkAllIps(): Promise<Array<{ id: number; ip?: string; error?: string }>> {
    const results: Array<{ id: number; ip?: string; error?: string }> = [];
    // Sequential by design to keep peak memory low.
    for (const id of this.workspaceIds()) {
      try { results.push({ id, ip: await this.checkIp(id) }); }
      catch (error) { results.push({ id, error: error instanceof Error ? error.message : String(error) }); }
    }
    return results;
  }


  detectEngines() {
    return this.resolver.detect();
  }

  async destroy(): Promise<void> {
    await Promise.all([...this.runtimes.values()].map(async (runtime) => {
      runtime.automationEnabled = false;
      runtime.stopRequested = true;
      if (runtime.rotationTimer) clearTimeout(runtime.rotationTimer);
      runtime.rotationTimer = undefined;
      if (runtime.activeClose) await runtime.activeClose().catch(() => undefined);
      runtime.activeClose = undefined;
    }));
  }
}



