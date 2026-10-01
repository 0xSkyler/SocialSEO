export type BrowserEngine = 'chromium';

export interface EngineInfo {
  engine: BrowserEngine;
  label: string;
  available: boolean;
  detail: string;
  executablePath?: string;
  bundled: boolean;
}

export interface WorkspacePreferences {
  id: number;
  engine: BrowserEngine;
  targetUrl: string;
  rotationSeconds: number;
  keepAlive: boolean;
}
