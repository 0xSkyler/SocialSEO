import path from 'node:path';
import { app, BrowserWindow, powerSaveBlocker } from 'electron';
import log from 'electron-log/main';
import { ProxyManager } from './ProxyManager';
import { SettingsManager } from './SettingsManager';
import { WorkspaceManager } from './WorkspaceManager';
import { registerIpc } from './ipc/registerIpc';

log.initialize();
log.transports.file.fileName = 'application.log';
log.transports.file.level = 'info';

let mainWindow: BrowserWindow | undefined;
let workspaceManager: WorkspaceManager | undefined;
let powerSaveBlockerId: number | undefined;

process.on('uncaughtException', (error) => {
  log.error('Uncaught main-process exception', error);
});
process.on('unhandledRejection', (reason) => {
  log.error('Unhandled main-process rejection', reason);
});

if (!app.requestSingleInstanceLock()) app.quit();

function rendererUrl(): string {
  return process.env.VITE_DEV_SERVER_URL || `file://${path.join(__dirname, '../renderer/index.html')}`;
}

async function createWindow(): Promise<void> {
  const settings = new SettingsManager();
  const proxies = new ProxyManager(settings);
  const workspaces = new WorkspaceManager(settings, proxies);
  const window = new BrowserWindow({
    width: 1540,
    height: 980,
    minWidth: 1050,
    minHeight: 700,
    backgroundColor: '#07101e',
    show: false,
    title: 'Social SEO',
    webPreferences: {
      preload: path.join(__dirname, '../preload/preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webviewTag: false,
      backgroundThrottling: true
    }
  });
  mainWindow = window;
  workspaceManager = workspaces;

  window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  window.webContents.on('will-navigate', (event, url) => {
    const allowedDev = process.env.VITE_DEV_SERVER_URL && url.startsWith(process.env.VITE_DEV_SERVER_URL);
    const allowedFile = url.startsWith('file://');
    if (!allowedDev && !allowedFile) event.preventDefault();
  });
  window.webContents.on('render-process-gone', (_event: unknown, details: { reason?: string; exitCode?: number }) => {
    log.error('Renderer process exited unexpectedly', details);
    if (window.isDestroyed() || details.reason === 'clean-exit') return;
    setTimeout(() => {
      if (!window.isDestroyed()) void window.loadURL(rendererUrl()).catch((error) => log.error('Renderer recovery reload failed', error));
    }, 500);
  });
  window.on('unresponsive', () => {
    // Browser workspaces live in the main process and remain intact. A renderer
    // crash/reload can bootstrap back into the current workspace state.
    log.warn('Social SEO renderer became temporarily unresponsive.');
  });

  registerIpc(window, settings, proxies, workspaces);
  window.once('ready-to-show', () => window.show());
  await window.loadURL(rendererUrl());

  // Proxy acquisition starts only after the user selects a provider in Control Center.
  // Until a validated live proxy is assigned, site Chromium remains blocked.
  window.on('closed', () => {
    void workspaces.destroy();
    workspaceManager = undefined;
    mainWindow = undefined;
  });
}

app.on('second-instance', () => {
  if (!mainWindow) return;
  if (mainWindow.isMinimized()) mainWindow.restore();
  mainWindow.show();
  mainWindow.focus();
});

app.whenReady().then(async () => {
  if (!powerSaveBlocker.isStarted(powerSaveBlockerId ?? -1)) powerSaveBlockerId = powerSaveBlocker.start('prevent-app-suspension');
  await createWindow();
  app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) void createWindow(); });
}).catch((error) => {
  log.error('Fatal startup failure', error);
  app.quit();
});

app.on('child-process-gone', (_event, details) => {
  log.warn('Electron child process exited', details);
});

app.on('before-quit', () => {
  if (powerSaveBlockerId !== undefined && powerSaveBlocker.isStarted(powerSaveBlockerId)) powerSaveBlocker.stop(powerSaveBlockerId);
  void workspaceManager?.destroy();
});
app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });
