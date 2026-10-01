import { create } from 'zustand';
import type { EngineInfo } from '../../shared/types/browser';
import type { DiagnosticsInfo } from '../../shared/types/ipc';
import type { ProxyImportResult, ProxyRecord, ProxyValidationProgress } from '../../shared/types/proxy';
import type { AppSettings } from '../../shared/types/settings';
import type { ProxyProvider } from '../../shared/proxySource';
import type { WorkspaceState } from '../../shared/types/workspace';

export type AppPage = 'workspaces' | 'settings';

interface AppStore {
  ready: boolean;
  page: AppPage;
  settings?: AppSettings;
  workspaces: WorkspaceState[];
  proxies: ProxyRecord[];
  validationProgress: ProxyValidationProgress;
  engines: EngineInfo[];
  diagnostics?: DiagnosticsInfo;
  lastImport?: ProxyImportResult;
  error?: string;
  bootstrap(): Promise<void>;
  setPage(page: AppPage): void;
  fetchRemote(provider?: ProxyProvider): Promise<ProxyImportResult>;
  importFile(): Promise<ProxyImportResult | undefined>;
  assign(): Promise<number>;
  refreshEngines(): Promise<void>;
  updateSettings(patch: Partial<AppSettings>): Promise<void>;
}

let subscriptionsStarted = false;

export const useAppStore = create<AppStore>((set) => ({
  ready: false,
  page: 'workspaces',
  workspaces: [],
  proxies: [],
  validationProgress: { runId: '', active: false, cancelled: false, total: 0, completed: 0, checking: 0, working: 0, dead: 0, assigned: 0 },
  engines: [],
  async bootstrap() {
    try {
      const data = await window.proxydesk.bootstrap();
      set({ ...data, ready: true });
      if (!subscriptionsStarted) {
        subscriptionsStarted = true;
        window.proxydesk.onWorkspaceState((state) => set((current) => ({
          workspaces: current.workspaces.map((item) => item.id === state.id ? state : item)
        })));
        window.proxydesk.onProxiesChanged((proxies) => set({ proxies }));
        window.proxydesk.onValidationProgress((validationProgress) => set({ validationProgress }));
      }
    } catch (error) {
      set({ error: error instanceof Error ? error.message : String(error), ready: true });
    }
  },
  setPage(page) { set({ page }); },
  async fetchRemote(provider) {
    const result = await window.proxydesk.proxy.fetchRemote(provider);
    set({
      lastImport: result,
      proxies: await window.proxydesk.proxy.list(),
      settings: await window.proxydesk.settings.get()
    });
    return result;
  },
  async importFile() {
    const result = await window.proxydesk.proxy.importFile();
    if (result) set({ lastImport: result, proxies: await window.proxydesk.proxy.list() });
    return result;
  },
  async assign() { return window.proxydesk.proxy.assign(); },
  async refreshEngines() { set({ engines: await window.proxydesk.engine.detect() }); },
  async updateSettings(patch) {
    const settings = await window.proxydesk.settings.set(patch);
    if (patch.browserCount !== undefined || patch.defaultRotationSeconds !== undefined || patch.keepAlive !== undefined) {
      const data = await window.proxydesk.bootstrap();
      set({ ...data, settings, ready: true });
    } else {
      set({ settings });
    }
    const theme = settings.theme === 'system' ? (matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark') : settings.theme;
    document.documentElement.dataset.theme = theme;
  }
}));
