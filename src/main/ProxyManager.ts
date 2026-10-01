import { EventEmitter } from 'node:events';
import type {
  ProxyAssignment,
  ProxyRecord,
  ReloadProgress,
  ReloadProxiesSummary
} from '../shared/types/proxy';
import { parseBulkText } from '../proxy/ProxyParser';
import { fetchAllWorkingProxyText } from '../proxy/AllWorkingProxyProvider';
import { logger } from './Logger';

// eslint-disable-next-line @typescript-eslint/no-unsafe-declaration-merging
export declare interface ProxyManager {
  on(event: 'assignmentsChanged', listener: (summary: ReloadProxiesSummary) => void): this;
  emit(event: 'assignmentsChanged', summary: ReloadProxiesSummary): boolean;
  on(event: 'reloadProgress', listener: (progress: ReloadProgress) => void): this;
  emit(event: 'reloadProgress', progress: ReloadProgress): boolean;
}

// eslint-disable-next-line @typescript-eslint/no-unsafe-declaration-merging
export class ProxyManager extends EventEmitter {
  private allProxies = new Map<string, ProxyRecord>();
  private assignments = new Map<number, ProxyRecord | null>();
  private fetchController: AbortController | null = null;

  async init(): Promise<void> {
    this.cancelCurrentFetch();
    this.allProxies.clear();
    this.assignments.clear();
    logger.info('proxy', 'Proxy manager ready: All Working API direct assignment.');
  }

  getAll(): ProxyRecord[] {
    return Array.from(this.allProxies.values()).map((proxy) => ({ ...proxy, password: undefined }));
  }

  getAssignment(browserId: number): ProxyRecord | null {
    return this.assignments.get(browserId) ?? null;
  }

  cancelCurrentFetch(): void {
    this.fetchController?.abort();
    this.fetchController = null;
  }

  /**
   * Fetches the current all-working.txt response and assigns proxies directly.
   * No proxy connectivity validation, latency testing, scoring, or background
   * preparation is performed.
   */
  async fetchAssignDirect(
    browserIds: number[],
    onAssignment: (assignment: ProxyAssignment, checked: number, total: number) => void,
    onProgress?: (checked: number, total: number, working: number, assigned: number, fetched: number) => void
  ): Promise<ReloadProxiesSummary> {
    this.cancelCurrentFetch();
    const controller = new AbortController();
    this.fetchController = controller;

    try {
      const raw = await fetchAllWorkingProxyText(controller.signal);
      if (controller.signal.aborted || this.fetchController !== controller) {
        throw new Error('Proxy API request cancelled.');
      }

      const parsed = parseBulkText(raw, 'All Working API');

      // Deduplicate by network endpoint so the same host:port is not assigned
      // to multiple browsers in the same cycle, regardless of protocol label.
      const endpointSeen = new Set<string>();
      const proxies: ProxyRecord[] = [];
      for (const proxy of parsed.proxies) {
        const endpoint = `${proxy.host.toLowerCase()}:${proxy.port}`;
        if (endpointSeen.has(endpoint)) continue;
        endpointSeen.add(endpoint);
        proxies.push(proxy);
      }

      if (proxies.length === 0) {
        throw new Error('All Working API returned no usable proxy entries.');
      }

      this.allProxies.clear();
      this.assignments.clear();
      for (const proxy of proxies) this.allProxies.set(proxy.id, proxy);

      const assignedCount = Math.min(browserIds.length, proxies.length);
      const total = proxies.length;

      this.emit('reloadProgress', { checked: total, total });
      onProgress?.(total, total, total, assignedCount, parsed.proxies.length);

      for (let index = 0; index < assignedCount; index += 1) {
        const browserId = browserIds[index];
        const proxy = proxies[index];
        this.assignments.set(browserId, proxy);
        onAssignment({ browserId, proxy }, total, total);
      }

      for (let index = assignedCount; index < browserIds.length; index += 1) {
        this.assignments.set(browserIds[index], null);
      }

      const summary = this.summary(browserIds, parsed.proxies.length, proxies.length);
      this.emit('assignmentsChanged', summary);

      logger.info(
        'proxy',
        `All Working API: fetched=${parsed.proxies.length}, unique=${proxies.length}, assigned=${assignedCount}/${browserIds.length}.`
      );

      return summary;
    } finally {
      if (this.fetchController === controller) this.fetchController = null;
    }
  }

  private summary(browserIds: number[], found: number, available: number): ReloadProxiesSummary {
    return {
      found,
      countryMatched: found,
      working: available,
      assignments: browserIds.map((browserId) => ({
        browserId,
        proxy: this.assignments.get(browserId) ?? null
      }))
    };
  }
}
