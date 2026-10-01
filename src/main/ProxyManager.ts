import { EventEmitter } from 'node:events';
import type {
  ProxyAssignment,
  ProxyRecord,
  ReloadProgress,
  ReloadProxiesSummary
} from '../shared/types/proxy';
import { fetchHighProxyBatch, HIGH_PROXY_URL } from '../proxy/HighProxyProvider';
import { logger } from './Logger';

export interface CycleProxyLoadResult extends ReloadProxiesSummary {
  rawEntries: number;
  parsedEntries: number;
  invalidEntries: number;
}

// eslint-disable-next-line @typescript-eslint/no-unsafe-declaration-merging
export declare interface ProxyManager {
  on(event: 'assignmentsChanged', listener: (summary: ReloadProxiesSummary) => void): this;
  emit(event: 'assignmentsChanged', summary: ReloadProxiesSummary): boolean;
  on(event: 'reloadProgress', listener: (progress: ReloadProgress) => void): this;
  emit(event: 'reloadProgress', progress: ReloadProgress): boolean;
}

// eslint-disable-next-line @typescript-eslint/no-unsafe-declaration-merging
export class ProxyManager extends EventEmitter {
  private currentCycleProxies = new Map<string, ProxyRecord>();
  private assignments = new Map<number, ProxyRecord | null>();
  private fetchController: AbortController | null = null;

  async init(): Promise<void> {
    this.cancelCurrentFetch();
    this.currentCycleProxies.clear();
    this.assignments.clear();
    logger.info('proxy', `Proxy manager ready: direct cycle source ${HIGH_PROXY_URL}.`);
  }

  getAll(): ProxyRecord[] {
    return Array.from(this.currentCycleProxies.values()).map((proxy) => ({
      ...proxy,
      password: undefined
    }));
  }

  getAssignment(browserId: number): ProxyRecord | null {
    return this.assignments.get(browserId) ?? null;
  }

  clearAssignments(): void {
    this.assignments.clear();
    this.currentCycleProxies.clear();
  }

  cancelCurrentFetch(): void {
    this.fetchController?.abort();
    this.fetchController = null;
  }

  /**
   * Fetch one authoritative proxy list for exactly one automation cycle.
   * No validation, scoring, latency probing, IP checking, or future-cycle
   * buffering occurs here.
   */
  async loadCycleProxies(browserIds: number[]): Promise<CycleProxyLoadResult> {
    this.cancelCurrentFetch();
    const controller = new AbortController();
    this.fetchController = controller;

    try {
      const batch = await fetchHighProxyBatch(controller.signal);
      if (controller.signal.aborted || this.fetchController !== controller) {
        throw new Error('Proxy API request cancelled.');
      }

      // Each call owns an entirely fresh cycle snapshot. Nothing from a
      // previous response is carried forward.
      this.currentCycleProxies.clear();
      this.assignments.clear();

      for (const proxy of batch.proxies) {
        this.currentCycleProxies.set(proxy.id, proxy);
      }

      const assignments: ProxyAssignment[] = browserIds.map((browserId, index) => {
        const proxy = batch.proxies[index] ?? null;
        this.assignments.set(browserId, proxy);
        return { browserId, proxy };
      });

      const assignedCount = assignments.filter((assignment) => assignment.proxy).length;
      const summary: CycleProxyLoadResult = {
        found: batch.proxies.length,
        countryMatched: batch.proxies.length,
        working: batch.proxies.length,
        assignments,
        rawEntries: batch.rawEntries,
        parsedEntries: batch.parsedEntries,
        invalidEntries: batch.invalidEntries
      };

      this.emit('reloadProgress', {
        checked: batch.proxies.length,
        total: batch.proxies.length
      });
      this.emit('assignmentsChanged', summary);

      logger.info(
        'proxy',
        `High API cycle fetch: raw=${batch.rawEntries}, parsed=${batch.parsedEntries}, ` +
          `unique=${batch.proxies.length}, assigned=${assignedCount}/${browserIds.length}.`
      );

      return summary;
    } finally {
      if (this.fetchController === controller) this.fetchController = null;
    }
  }
}
