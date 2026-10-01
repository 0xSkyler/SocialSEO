import type { BrowserEngine } from './browser';
import type { ProxyRecord } from './proxy';

export type WorkspaceStatus = 'stopped' | 'waiting_proxy' | 'launching' | 'loading' | 'running' | 'completed' | 'rotating' | 'error' | 'unavailable';

export interface WorkspaceState {
  id: number;
  title: string;
  url: string;
  targetUrl: string;
  status: WorkspaceStatus;
  error?: string;
  engine: BrowserEngine;
  engineLabel: string;
  engineAvailable: boolean;
  proxy?: Omit<ProxyRecord, 'password'>;
  detectedIp?: string;
  lastIpCheckAt?: string;
  keepAlive: boolean;
  rotationSeconds: number;
  nextRotationAt?: string;
  visitedLinks: number;
  runCount?: number;
  lastRunAt?: string;
  lastRunDurationMs?: number;
}
