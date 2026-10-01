import type { AppSettings } from './settings';
import type { ProxyProvider } from '../proxySource';
import type { EngineInfo } from './browser';
import type { ProxyImportResult, ProxyRecord, ProxyValidationProgress } from './proxy';
import type { WorkspaceState } from './workspace';

export interface DiagnosticsInfo {
  appVersion: string;
  electronVersion: string;
  chromiumVersion: string;
  nodeVersion: string;
  platform: string;
  arch: string;
  playwrightVersion?: string;
}

export interface ProxyDeskApi {
  bootstrap(): Promise<{ settings: AppSettings; workspaces: WorkspaceState[]; proxies: ProxyRecord[]; validationProgress: ProxyValidationProgress; engines: EngineInfo[]; diagnostics: DiagnosticsInfo }>;
  workspace: {
    launch(id: number): Promise<void>;
    launchAll(): Promise<void>;
    stop(id: number): Promise<void>;
    stopAll(): Promise<void>;
    focus(id: number): Promise<void>;
    navigate(id: number, url: string): Promise<void>;
    setTarget(id: number, url: string): Promise<void>;
    reload(id: number): Promise<void>;
    reloadAll(): Promise<void>;
    setKeepAlive(id: number, enabled: boolean): Promise<void>;
    setKeepAliveAll(enabled: boolean): Promise<void>;
    rotateProxy(id: number): Promise<boolean>;
    checkIp(id: number): Promise<string | undefined>;
    checkAllIps(): Promise<Array<{ id: number; ip?: string; error?: string }>>;
    clearData(workspaceIds: number[]): Promise<number[]>;
  };
  central: {
    applyTargets(entries: Array<{ id: number; url: string }>): Promise<void>;
  };
  proxy: {
    fetchRemote(provider?: ProxyProvider): Promise<ProxyImportResult>;
    importFile(): Promise<ProxyImportResult | undefined>;
    list(): Promise<ProxyRecord[]>;
    assign(): Promise<number>;
    assignOne(workspaceId: number, proxyId?: string): Promise<void>;
    replace(workspaceId: number): Promise<boolean>;
    validate(proxyIds?: string[]): Promise<ProxyRecord[]>;
    validationStatus(): Promise<ProxyValidationProgress>;
    cancelValidation(): Promise<void>;
    clear(): Promise<void>;
  };
  settings: {
    get(): Promise<AppSettings>;
    set(patch: Partial<AppSettings>): Promise<AppSettings>;
  };
  engine: {
    detect(): Promise<EngineInfo[]>;
  };
  onWorkspaceState(listener: (state: WorkspaceState) => void): () => void;
  onProxiesChanged(listener: (proxies: ProxyRecord[]) => void): () => void;
  onValidationProgress(listener: (progress: ProxyValidationProgress) => void): () => void;
}
