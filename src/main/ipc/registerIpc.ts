import fs from 'node:fs';
import { app, BrowserWindow, dialog, ipcMain } from 'electron';
import type { AppSettings } from '../../shared/types/settings';
import type { ProxyProvider } from '../../shared/proxySource';
import type { WorkspaceState } from '../../shared/types/workspace';
import type { ProxyValidationProgress } from '../../shared/types/proxy';
import { getPlaywrightVersion } from '../browser/PlaywrightRuntime';
import { ProxyManager } from '../ProxyManager';
import { SettingsManager } from '../SettingsManager';
import { WorkspaceManager } from '../WorkspaceManager';
import { loadProxyProviderPool, loadProxyTextPool } from '../proxyPipeline';

const CHANNELS = [
  'app:bootstrap',
  'workspace:launch', 'workspace:launch-all', 'workspace:stop', 'workspace:stop-all', 'workspace:focus',
  'workspace:navigate', 'workspace:set-target', 'workspace:reload', 'workspace:reload-all',
  'workspace:keep-alive', 'workspace:keep-alive-all', 'workspace:rotate-proxy',
  'workspace:check-ip', 'workspace:check-all-ips', 'workspace:clear-data',
  'central:apply-targets',
  'proxy:fetch-remote', 'proxy:import-file', 'proxy:list', 'proxy:assign', 'proxy:assign-one', 'proxy:replace', 'proxy:validate', 'proxy:validation-cancel', 'proxy:validation-status', 'proxy:clear',
  'settings:get', 'settings:set', 'engine:detect'
] as const;

export function registerIpc(window: BrowserWindow, settings: SettingsManager, proxies: ProxyManager, workspaces: WorkspaceManager): void {
  for (const channel of CHANNELS) ipcMain.removeHandler(channel);

  ipcMain.handle('app:bootstrap', () => ({
    settings: settings.get(),
    workspaces: workspaces.getStates(),
    proxies: proxies.getPublicList(),
    validationProgress: proxies.getValidationProgress(),
    engines: workspaces.detectEngines(),
    diagnostics: {
      appVersion: app.getVersion(),
      electronVersion: process.versions.electron,
      chromiumVersion: process.versions.chrome,
      nodeVersion: process.versions.node,
      platform: process.platform,
      arch: process.arch,
      playwrightVersion: getPlaywrightVersion()
    }
  }));

  ipcMain.handle('workspace:launch', (_event, id: number) => workspaces.launch(id));
  ipcMain.handle('workspace:launch-all', () => workspaces.launchAll());
  ipcMain.handle('workspace:stop', (_event, id: number) => workspaces.stop(id));
  ipcMain.handle('workspace:stop-all', () => workspaces.stopAll());
  ipcMain.handle('workspace:focus', (_event, id: number) => workspaces.focus(id));
  ipcMain.handle('workspace:navigate', (_event, id: number, url: string) => workspaces.navigate(id, url));
  ipcMain.handle('workspace:set-target', (_event, id: number, url: string) => workspaces.setTarget(id, url));
  ipcMain.handle('workspace:reload', (_event, id: number) => workspaces.reload(id));
  ipcMain.handle('workspace:reload-all', () => workspaces.reloadAll());
  ipcMain.handle('workspace:keep-alive', (_event, id: number, enabled: boolean) => workspaces.setKeepAlive(id, enabled));
  ipcMain.handle('workspace:keep-alive-all', (_event, enabled: boolean) => workspaces.setKeepAliveAll(enabled));
  ipcMain.handle('workspace:rotate-proxy', (_event, id: number) => workspaces.rotateProxy(id));
  ipcMain.handle('workspace:check-ip', (_event, id: number) => workspaces.checkIp(id));
  ipcMain.handle('workspace:check-all-ips', () => workspaces.checkAllIps());
  ipcMain.handle('workspace:clear-data', (_event, workspaceIds: number[]) => workspaces.clearBrowserData(workspaceIds));

  ipcMain.handle('central:apply-targets', (_event, entries: Array<{ id: number; url: string }>) => workspaces.applyTargets(entries));

  ipcMain.handle('proxy:fetch-remote', async (_event, provider?: ProxyProvider) => {
    const selected = provider ?? settings.get().proxyProvider;
    if (provider) settings.set({ proxyProvider: provider });
    return loadProxyProviderPool(selected, settings, proxies, workspaces);
  });
  ipcMain.handle('proxy:import-file', async () => {
    const picked = await dialog.showOpenDialog(window, {
      title: 'Select proxy.txt',
      properties: ['openFile'],
      filters: [{ name: 'Proxy text file', extensions: ['txt'] }]
    });
    if (picked.canceled || !picked.filePaths[0]) return undefined;
    const text = fs.readFileSync(picked.filePaths[0], 'utf8');
    return loadProxyTextPool(text, settings, proxies, workspaces, 'proxy.txt');
  });
  ipcMain.handle('proxy:list', () => proxies.getPublicList());
  ipcMain.handle('proxy:assign', async () => {
    const assignments = await proxies.buildAssignments();
    await workspaces.applyAssignments();
    return assignments.filter((item) => item.proxyId).length;
  });
  ipcMain.handle('proxy:assign-one', async (_event, workspaceId: number, proxyId?: string) => workspaces.assignOne(workspaceId, proxyId));
  ipcMain.handle('proxy:replace', async (_event, workspaceId: number) => workspaces.replaceProxy(workspaceId));
  ipcMain.handle('proxy:validate', async (_event, proxyIds?: string[]) => {
    const currentSettings = settings.get();
    return proxies.validateStreaming(proxyIds, async (proxy) => {
      if (!currentSettings.validation.assignWorkingImmediately) return;
      const assignment = proxies.assignWorkingProxyImmediately(proxy.id);
      if (assignment) void workspaces.applyLiveAssignment(assignment.workspaceId).catch(() => undefined);
    });
  });
  ipcMain.handle('proxy:validation-cancel', () => proxies.cancelValidation());
  ipcMain.handle('proxy:validation-status', () => proxies.getValidationProgress());
  ipcMain.handle('proxy:clear', async () => {
    proxies.clear();
    await workspaces.applyAssignments();
  });

  ipcMain.handle('settings:get', () => settings.get());
  ipcMain.handle('settings:set', async (_event, patch: Partial<AppSettings>) => {
    const previous = settings.get();
    const next = settings.set(patch);

    if (patch.browserCount !== undefined) await workspaces.reconcileBrowserCount(next.browserCount);

    const rotationChanged = patch.defaultRotationSeconds !== undefined
      && next.defaultRotationSeconds !== previous.defaultRotationSeconds;
    const keepAliveChanged = patch.keepAlive !== undefined
      && JSON.stringify(next.keepAlive) !== JSON.stringify(previous.keepAlive);

    if (rotationChanged || keepAliveChanged) {
      await workspaces.applyGlobalRuntimeSettings(next.defaultRotationSeconds, true);
    } else if (patch.defaultRotationSeconds !== undefined) {
      await workspaces.applyGlobalRuntimeSettings(next.defaultRotationSeconds, false);
    }

    return next;
  });
  ipcMain.handle('engine:detect', () => workspaces.detectEngines());

  workspaces.on('state', (state: WorkspaceState) => {
    if (!window.isDestroyed()) window.webContents.send('workspace:state', state);
  });
  proxies.on('changed', () => {
    if (!window.isDestroyed()) window.webContents.send('proxy:changed', proxies.getPublicList());
  });
  proxies.on('validation-progress', (progress: ProxyValidationProgress) => {
    if (!window.isDestroyed()) window.webContents.send('proxy:validation-progress', progress);
  });
}
