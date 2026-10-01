import type { ProxyImportResult } from '../shared/types/proxy';
import type { ProxyProvider } from '../shared/proxySource';
import { ProxyManager } from './ProxyManager';
import { SettingsManager } from './SettingsManager';
import { WorkspaceManager } from './WorkspaceManager';

async function applyDirectPool(
  result: ProxyImportResult,
  proxies: ProxyManager,
  workspaces: WorkspaceManager
): Promise<ProxyImportResult> {
  const assignments = await proxies.buildAssignments();
  await workspaces.applyAssignments();
  return {
    ...result,
    assigned: assignments.filter((item) => Boolean(item.proxyId)).length
  };
}

export async function loadProxyTextPool(
  text: string,
  _settings: SettingsManager,
  proxies: ProxyManager,
  workspaces: WorkspaceManager,
  source = 'proxy.txt'
): Promise<ProxyImportResult> {
  proxies.clear();
  const result = await proxies.importText(text, source);
  return applyDirectPool(result, proxies, workspaces);
}

export async function loadProxyProviderPool(
  provider: ProxyProvider,
  _settings: SettingsManager,
  proxies: ProxyManager,
  workspaces: WorkspaceManager
): Promise<ProxyImportResult> {
  const result = await proxies.fetchProvider(provider);
  return applyDirectPool(result, proxies, workspaces);
}

export async function loadProxyScrapePool(
  settings: SettingsManager,
  proxies: ProxyManager,
  workspaces: WorkspaceManager
): Promise<ProxyImportResult> {
  return loadProxyProviderPool('private-api', settings, proxies, workspaces);
}
