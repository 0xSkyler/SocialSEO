import type { ProxyProvider } from '../proxySource';

export type ThemeMode = 'dark' | 'light' | 'system';

export interface ValidationRules {
  validateBeforeAssign: boolean;
  autoStartOnImport: boolean;
  assignWorkingImmediately: boolean;
  timeoutSeconds: number;
  attempts: number;
  concurrency: number;
  testUrl: string;
  maxLatencyMs: number;
}

export interface KeepAliveRules {
  minActionSeconds: number;
  maxActionSeconds: number;
  followLinkChancePercent: number;
  maxArticleHops: number;
  sameOriginOnly: boolean;
}

export interface AppSettings {
  browserCount: number;
  theme: ThemeMode;
  defaultRotationSeconds: number;
  proxyProvider: ProxyProvider;
  autoAssignOnImport: boolean;
  allowProxyReuse: boolean;
  validation: ValidationRules;
  keepAlive: KeepAliveRules;
  savedUrlPool: string[];
  ipCheckUrl: string;
}
