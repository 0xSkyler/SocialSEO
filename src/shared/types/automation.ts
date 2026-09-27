import type { BroadcastSearchResult } from './browser';

export const PROXY_PROVIDER_IDS = [
  'proxyscrape',
  'proxifly',
  'hproxy',
  'proxmint',
  'thespeedx',
  'monosans'
] as const;

export type ProxyProviderId = (typeof PROXY_PROVIDER_IDS)[number];

export const PROXY_PROVIDER_LABELS: Record<ProxyProviderId, string> = {
  proxyscrape: 'ProxyScrape',
  proxifly: 'Proxifly',
  hproxy: 'HProxy',
  proxmint: 'ProxMint',
  thespeedx: 'TheSpeedX',
  monosans: 'Monosans'
};

export interface SeoAutomationConfig {
  /**
   * One keyword or a comma-separated sequence. Every browser uses the same
   * keyword in a cycle; the next cycle advances to the next keyword and wraps.
   */
  query: string;
  targetWebsite: string;
  /** Public proxy feed selected in the Control Center. */
  proxySource?: ProxyProviderId;
  /** Exact hostname allowed for autonomous click + Keep Alive in controlled testing. */
  controlledTestHost?: string;
  /** Delay after a completed cycle before the next rotation begins. */
  intervalSec: number;
  /** Number of isolated browser workspaces, 1-100. */
  browserCount: number;
  /** Maximum Google result pages to inspect for each browser, 1-100. */
  maxPages: number;
}

export interface SeoAutomationState {
  running: boolean;
  cycleInProgress: boolean;
  proxySource: ProxyProviderId;
  /** Original comma-separated keyword input. */
  query: string;
  /** Parsed keyword sequence used for round-robin cycles. */
  keywords: string[];
  /** Keyword used by all browsers in the current/most recent cycle. */
  currentQuery: string;
  targetWebsite: string;
  controlledTestHost?: string;
  intervalSec: number;
  browserCount: number;
  maxPages: number;
  browserIds: number[];
  cycleNumber: number;
  fetchedProxies: number;
  checkedProxies: number;
  totalProxies: number;
  liveProxies: number;
  assignedBrowsers: number;
  lastCycleStartedAt?: string;
  lastCycleCompletedAt?: string;
  nextCycleAt?: string;
  lastError?: string;
}

export interface SeoAutomationResult {
  cycleNumber: number;
  result: BroadcastSearchResult;
}

export function normalizeAutomationIntervalSeconds(value: number): number {
  if (!Number.isFinite(value)) return 600;
  return Math.max(30, Math.min(86_400, Math.floor(value)));
}

export function normalizeBrowserCount(value: number): number {
  if (!Number.isFinite(value)) return 10;
  return Math.max(1, Math.min(100, Math.floor(value)));
}

export function normalizeSeoMaxPages(value: number): number {
  if (!Number.isFinite(value)) return 20;
  return Math.max(1, Math.min(100, Math.floor(value)));
}

export function normalizeProxyProvider(value: unknown): ProxyProviderId {
  return PROXY_PROVIDER_IDS.includes(value as ProxyProviderId)
    ? (value as ProxyProviderId)
    : 'proxyscrape';
}

export function parseSeoKeywords(value: string): string[] {
  return value
    .split(',')
    .map((keyword) => keyword.trim())
    .filter(Boolean);
}
