import { contextBridge, ipcRenderer } from 'electron';
import type { EngineInfo } from '../shared/types/browser';
import type { ProxyDeskApi } from '../shared/types/ipc';
import type { ProxyRecord, ProxyValidationProgress } from '../shared/types/proxy';
import type { AppSettings } from '../shared/types/settings';
import type { WorkspaceState } from '../shared/types/workspace';

const api: ProxyDeskApi = {
  bootstrap: () => ipcRenderer.invoke('app:bootstrap'),
  workspace: {
    launch: (id) => ipcRenderer.invoke('workspace:launch', id),
    launchAll: () => ipcRenderer.invoke('workspace:launch-all'),
    stop: (id) => ipcRenderer.invoke('workspace:stop', id),
    stopAll: () => ipcRenderer.invoke('workspace:stop-all'),
    focus: (id) => ipcRenderer.invoke('workspace:focus', id),
    navigate: (id, url) => ipcRenderer.invoke('workspace:navigate', id, url),
    setTarget: (id, url) => ipcRenderer.invoke('workspace:set-target', id, url),
    reload: (id) => ipcRenderer.invoke('workspace:reload', id),
    reloadAll: () => ipcRenderer.invoke('workspace:reload-all'),
    setKeepAlive: (id, enabled) => ipcRenderer.invoke('workspace:keep-alive', id, enabled),
    setKeepAliveAll: (enabled) => ipcRenderer.invoke('workspace:keep-alive-all', enabled),
    rotateProxy: (id) => ipcRenderer.invoke('workspace:rotate-proxy', id),
    checkIp: (id) => ipcRenderer.invoke('workspace:check-ip', id),
    checkAllIps: () => ipcRenderer.invoke('workspace:check-all-ips'),
    clearData: (workspaceIds) => ipcRenderer.invoke('workspace:clear-data', workspaceIds)
  },
  central: {
    applyTargets: (entries) => ipcRenderer.invoke('central:apply-targets', entries)
  },
  proxy: {
    fetchRemote: (provider) => ipcRenderer.invoke('proxy:fetch-remote', provider),
    importFile: () => ipcRenderer.invoke('proxy:import-file'),
    list: () => ipcRenderer.invoke('proxy:list'),
    assign: () => ipcRenderer.invoke('proxy:assign'),
    assignOne: (workspaceId, proxyId) => ipcRenderer.invoke('proxy:assign-one', workspaceId, proxyId),
    replace: (workspaceId) => ipcRenderer.invoke('proxy:replace', workspaceId),
    validate: (proxyIds) => ipcRenderer.invoke('proxy:validate', proxyIds),
    validationStatus: () => ipcRenderer.invoke('proxy:validation-status'),
    cancelValidation: () => ipcRenderer.invoke('proxy:validation-cancel'),
    clear: () => ipcRenderer.invoke('proxy:clear')
  },
  settings: {
    get: () => ipcRenderer.invoke('settings:get'),
    set: (patch: Partial<AppSettings>) => ipcRenderer.invoke('settings:set', patch)
  },
  engine: {
    detect: () => ipcRenderer.invoke('engine:detect') as Promise<EngineInfo[]>
  },
  onWorkspaceState: (listener: (state: WorkspaceState) => void) => {
    const handler = (_event: Electron.IpcRendererEvent, state: WorkspaceState) => listener(state);
    ipcRenderer.on('workspace:state', handler);
    return () => ipcRenderer.removeListener('workspace:state', handler);
  },
  onProxiesChanged: (listener: (proxies: ProxyRecord[]) => void) => {
    const handler = (_event: Electron.IpcRendererEvent, proxies: ProxyRecord[]) => listener(proxies);
    ipcRenderer.on('proxy:changed', handler);
    return () => ipcRenderer.removeListener('proxy:changed', handler);
  },
  onValidationProgress: (listener: (progress: ProxyValidationProgress) => void) => {
    const handler = (_event: Electron.IpcRendererEvent, progress: ProxyValidationProgress) => listener(progress);
    ipcRenderer.on('proxy:validation-progress', handler);
    return () => ipcRenderer.removeListener('proxy:validation-progress', handler);
  },
};

contextBridge.exposeInMainWorld('proxydesk', api);
