import fs from 'node:fs';
import path from 'node:path';
import { app } from 'electron';
import type { AppSettings } from '../shared/types/settings';
import { DEFAULT_PROXY_PROVIDER, PROXY_PROVIDERS, type ProxyProvider } from '../shared/proxySource';


const DEFAULT_SETTINGS: AppSettings = {
  browserCount: 10,
  theme: 'dark',
  defaultRotationSeconds: 0,
  proxyProvider: DEFAULT_PROXY_PROVIDER,
  autoAssignOnImport: true,
  allowProxyReuse: false,
  validation: {
    validateBeforeAssign: false,
    autoStartOnImport: false,
    assignWorkingImmediately: true,
    timeoutSeconds: 3,
    attempts: 1,
    concurrency: 20,
    testUrl: 'https://api.ipify.org?format=json',
    maxLatencyMs: 0
  },
  keepAlive: {
    minActionSeconds: 8,
    maxActionSeconds: 20,
    followLinkChancePercent: 100,
    maxArticleHops: 1000,
    sameOriginOnly: true
  },
  savedUrlPool: [],
  ipCheckUrl: 'https://api.ipify.org?format=json',
};

function sanitizeSettings(input: Partial<AppSettings>): AppSettings {
  const validation = { ...DEFAULT_SETTINGS.validation, ...(input.validation ?? {}) };
  const keepAlive = { ...DEFAULT_SETTINGS.keepAlive, ...(input.keepAlive ?? {}) };
  const browserCount = Math.min(100, Math.max(1, Math.floor(Number(input.browserCount ?? DEFAULT_SETTINGS.browserCount) || DEFAULT_SETTINGS.browserCount)));
  const savedUrlPool = Array.isArray(input.savedUrlPool)
    ? input.savedUrlPool.filter((value): value is string => typeof value === 'string').map((value) => value.trim()).filter(Boolean).slice(0, 5000)
    : [];
  return {
    browserCount,
    theme: input.theme === 'light' || input.theme === 'system' ? input.theme : 'dark',
    defaultRotationSeconds: Math.max(0, Math.floor(Number(input.defaultRotationSeconds ?? DEFAULT_SETTINGS.defaultRotationSeconds))),
    proxyProvider: (PROXY_PROVIDERS.some((item) => item.id === input.proxyProvider) ? input.proxyProvider : DEFAULT_PROXY_PROVIDER) as ProxyProvider,
    autoAssignOnImport: typeof input.autoAssignOnImport === 'boolean' ? input.autoAssignOnImport : DEFAULT_SETTINGS.autoAssignOnImport,
    allowProxyReuse: typeof input.allowProxyReuse === 'boolean' ? input.allowProxyReuse : DEFAULT_SETTINGS.allowProxyReuse,
    validation: {
      ...validation,
            // 4.5.0 trusts the private proxy API. No validation is performed.
      validateBeforeAssign: false,
      autoStartOnImport: false,
      assignWorkingImmediately: true,
      timeoutSeconds: 3,
      attempts: 1,
      concurrency: 1,
      maxLatencyMs: 0
    },
    keepAlive: {
      ...keepAlive,
      minActionSeconds: Math.min(300, Math.max(3, Number(keepAlive.minActionSeconds) || 8)),
      maxActionSeconds: Math.min(600, Math.max(Number(keepAlive.minActionSeconds) || 8, Number(keepAlive.maxActionSeconds) || 20)),
      followLinkChancePercent: Math.min(100, Math.max(0, Number(keepAlive.followLinkChancePercent) || 0)),
      maxArticleHops: Math.min(1000, Math.max(0, Number(keepAlive.maxArticleHops) || 0))
    },
    savedUrlPool,
    ipCheckUrl: typeof input.ipCheckUrl === 'string' && input.ipCheckUrl.trim() ? input.ipCheckUrl.trim() : DEFAULT_SETTINGS.ipCheckUrl
  };
}

export class SettingsManager {
  private settings: AppSettings = DEFAULT_SETTINGS;
  private readonly filePath = path.join(app.getPath('userData'), 'settings.json');

  constructor() { this.load(); }

  private load(): void {
    try {
      if (!fs.existsSync(this.filePath)) return;
      const stored = JSON.parse(fs.readFileSync(this.filePath, 'utf8')) as Partial<AppSettings>;
      this.settings = sanitizeSettings(stored);
    } catch {
      this.settings = DEFAULT_SETTINGS;
    }
  }

  get(): AppSettings { return structuredClone(this.settings); }

  set(patch: Partial<AppSettings>): AppSettings {
    this.settings = sanitizeSettings({ ...this.settings, ...patch });
    fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
    fs.writeFileSync(this.filePath, JSON.stringify(this.settings, null, 2), 'utf8');
    return this.get();
  }
}

