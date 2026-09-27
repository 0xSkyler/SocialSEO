import { EventEmitter } from 'node:events';
import type {
  ProxyAssignment,
  ProxyRecord,
  ReloadProgress,
  ReloadProxiesSummary
} from '../shared/types/proxy';
import type { ProxyProviderId } from '../shared/types/automation';
import { dedupeProxies, parseBulkText } from '../proxy/ProxyParser';
import { ProxyValidator } from '../proxy/ProxyValidator';
import { scoreProxy } from '../proxy/ProxyScorer';
import { fetchProxyProviderList } from '../proxy/ProxyProvider';
import { logger } from './Logger';

const VALIDATION_TIMEOUT_MS = 4000;
const MAX_CONCURRENT_CHECKS = 32;
const IP_CHECK_URL = 'https://api.ipify.org?format=json';

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
  private validationController: AbortController | null = null;
  private usedProxyIds = new Set<string>();
  private quarantinedProxyIds = new Set<string>();
  private fetchedCount = 0;

  async init(): Promise<void> {
    this.allProxies.clear();
    this.assignments.clear();
    this.usedProxyIds.clear();
    this.quarantinedProxyIds.clear();
    this.fetchedCount = 0;
    logger.info('proxy', 'Proxy manager ready: selectable public providers, session-only state.');
  }

  getAll(): ProxyRecord[] {
    return Array.from(this.allProxies.values()).map((proxy) => ({ ...proxy, password: undefined }));
  }

  getAssignment(browserId: number): ProxyRecord | null {
    return this.assignments.get(browserId) ?? null;
  }

  getWorkingCount(): number {
    return Array.from(this.allProxies.values()).filter(
      (proxy) => proxy.status === 'working' && !this.quarantinedProxyIds.has(proxy.id)
    ).length;
  }

  getAssignedCount(): number {
    return Array.from(this.assignments.values()).filter(Boolean).length;
  }

  isValidationInProgress(): boolean {
    return this.validationController !== null;
  }

  resetRotationHistory(): void {
    this.usedProxyIds.clear();
  }

  cancelCurrentValidation(): void {
    this.validationController?.abort();
    this.validationController = null;
  }

  rejectAssignment(browserId: number, proxyId: string, reason?: string): void {
    const assigned = this.assignments.get(browserId);
    if (assigned?.id === proxyId) this.assignments.delete(browserId);

    this.quarantinedProxyIds.add(proxyId);
    const proxy = this.allProxies.get(proxyId);
    if (proxy) {
      proxy.status = 'dead';
      proxy.failureCount += 1;
      proxy.score = scoreProxy(proxy);
      this.allProxies.set(proxy.id, proxy);
    }

    if (reason) {
      logger.warn('proxy', `Browser ${browserId} rejected proxy ${proxyId}: ${reason}`);
    }
  }

  leaseNextWorking(browserId: number, excludedIds: Set<string> = new Set()): ProxyRecord | null {
    const assignedElsewhere = new Set(
      Array.from(this.assignments.entries())
        .filter(([id, proxy]) => id !== browserId && proxy)
        .map(([, proxy]) => (proxy as ProxyRecord).id)
    );

    const available = Array.from(this.allProxies.values())
      .filter(
        (proxy) =>
          proxy.status === 'working' &&
          !this.quarantinedProxyIds.has(proxy.id) &&
          !excludedIds.has(proxy.id) &&
          !assignedElsewhere.has(proxy.id)
      )
      .sort((a, b) => (b.score - a.score) || ((a.latencyMs ?? Infinity) - (b.latencyMs ?? Infinity)));

    if (available.length === 0) return null;

    let proxy = available.find((candidate) => !this.usedProxyIds.has(candidate.id));
    if (!proxy) {
      for (const candidate of available) this.usedProxyIds.delete(candidate.id);
      proxy = available[0];
    }

    this.assignments.set(browserId, proxy);
    this.usedProxyIds.add(proxy.id);
    return proxy;
  }

  async fetchValidateAssignStreaming(
    provider: ProxyProviderId,
    browserIds: number[],
    onAssignment: (assignment: ProxyAssignment, checked: number, total: number) => void,
    onProgress?: (checked: number, total: number, working: number, assigned: number, fetched: number) => void
  ): Promise<ReloadProxiesSummary> {
    this.cancelCurrentValidation();
    const controller = new AbortController();
    this.validationController = controller;
    this.quarantinedProxyIds.clear();

    const previousAssignments = new Map(this.assignments);
    const fetched = await fetchProxyProviderList(provider, {
      limit: 2000,
      timeoutFilterMs: VALIDATION_TIMEOUT_MS,
      requestTimeoutMs: 15_000,
      signal: controller.signal
    });

    if (controller.signal.aborted) throw new Error('Proxy validation cancelled.');

    const parsed = parseBulkText(fetched.raw, fetched.label);
    const replacement = dedupeProxies(parsed.proxies);
    if (replacement.length === 0) {
      throw new Error(`${fetched.label} returned no usable proxies.`);
    }

    this.fetchedCount = replacement.length;
    const replacementIds = new Set(replacement.map((proxy) => proxy.id));
    for (const id of Array.from(this.usedProxyIds)) {
      if (!replacementIds.has(id)) this.usedProxyIds.delete(id);
    }
    if (replacement.every((proxy) => this.usedProxyIds.has(proxy.id))) {
      this.usedProxyIds.clear();
    }

    const ordered = [
      ...replacement.filter((proxy) => !this.usedProxyIds.has(proxy.id)),
      ...replacement.filter((proxy) => this.usedProxyIds.has(proxy.id))
    ];
    const validationLimit = Math.min(
      ordered.length,
      Math.max(200, Math.min(800, browserIds.length * 8))
    );
    const candidates = ordered.slice(0, validationLimit);

    this.allProxies.clear();
    this.assignments.clear();
    for (const proxy of candidates) {
      this.allProxies.set(proxy.id, { ...proxy, status: 'checking' });
    }

    const total = candidates.length;
    const remainingBrowsers = new Set(browserIds);
    const usedThisCycle = new Set<string>();
    let working = 0;
    let assigned = 0;

    const emitProgress = (checked: number) => {
      this.emit('reloadProgress', { checked, total });
      onProgress?.(checked, total, working, assigned, this.fetchedCount);
    };

    emitProgress(0);

    const chooseBrowser = (proxy: ProxyRecord): number | null => {
      if (this.usedProxyIds.has(proxy.id) || usedThisCycle.has(proxy.id)) return null;
      const ids = Array.from(remainingBrowsers);
      if (ids.length === 0) return null;
      return ids.find((id) => previousAssignments.get(id)?.id !== proxy.id) ?? ids[0] ?? null;
    };

    try {
      const results = await ProxyValidator.validateMany(candidates, {
        timeoutMs: VALIDATION_TIMEOUT_MS,
        ipCheckUrl: IP_CHECK_URL,
        maxConcurrent: MAX_CONCURRENT_CHECKS,
        signal: controller.signal,
        onResult: (result, checked, resultTotal) => {
          if (controller.signal.aborted) return;
          const proxy = this.allProxies.get(result.proxyId);
          if (!proxy) return;

          proxy.status = result.status;
          proxy.latencyMs = result.latencyMs;
          proxy.lastChecked = result.checkedAt;
          if (result.status === 'working') {
            proxy.successCount += 1;
            working += 1;
          } else {
            proxy.failureCount += 1;
          }
          proxy.score = scoreProxy(proxy);
          this.allProxies.set(proxy.id, proxy);

          if (result.status === 'working') {
            const browserId = chooseBrowser(proxy);
            if (browserId != null) {
              this.assignments.set(browserId, proxy);
              remainingBrowsers.delete(browserId);
              usedThisCycle.add(proxy.id);
              this.usedProxyIds.add(proxy.id);
              assigned += 1;
              onAssignment({ browserId, proxy }, checked, resultTotal);
              this.emitAssignments(browserIds, this.fetchedCount, working);
            }
          }

          this.emit('reloadProgress', { checked, total: resultTotal });
          onProgress?.(checked, resultTotal, working, assigned, this.fetchedCount);
        }
      });

      if (controller.signal.aborted || this.validationController !== controller) {
        return this.summary(browserIds, this.fetchedCount, this.getWorkingCount());
      }

      for (const result of results) {
        const proxy = this.allProxies.get(result.proxyId);
        if (!proxy || this.quarantinedProxyIds.has(proxy.id)) continue;
        proxy.status = result.status;
        proxy.latencyMs = result.latencyMs;
        proxy.lastChecked = result.checkedAt;
        proxy.score = scoreProxy(proxy);
        this.allProxies.set(proxy.id, proxy);
      }

      const live = Array.from(this.allProxies.values()).filter(
        (proxy) => proxy.status === 'working' && !this.quarantinedProxyIds.has(proxy.id)
      );
      if (
        remainingBrowsers.size > 0 &&
        live.length > 0 &&
        live.every((proxy) => this.usedProxyIds.has(proxy.id))
      ) {
        for (const proxy of live) {
          if (!Array.from(this.assignments.values()).some((assignedProxy) => assignedProxy?.id === proxy.id)) {
            this.usedProxyIds.delete(proxy.id);
          }
        }

        for (const browserId of Array.from(remainingBrowsers)) {
          const proxy = this.leaseNextWorking(browserId, usedThisCycle);
          if (!proxy) break;
          remainingBrowsers.delete(browserId);
          usedThisCycle.add(proxy.id);
          assigned += 1;
          onAssignment({ browserId, proxy }, total, total);
        }
      }

      emitProgress(total);
      const summary = this.summary(browserIds, this.fetchedCount, this.getWorkingCount());
      this.emit('assignmentsChanged', summary);
      return summary;
    } finally {
      if (this.validationController === controller) this.validationController = null;
    }
  }

  private emitAssignments(browserIds: number[], found: number, working: number): void {
    this.emit('assignmentsChanged', this.summary(browserIds, found, working));
  }

  private summary(browserIds: number[], found: number, working: number): ReloadProxiesSummary {
    return {
      found,
      countryMatched: found,
      working,
      assignments: browserIds.map((browserId) => ({
        browserId,
        proxy: this.assignments.get(browserId) ?? null
      }))
    };
  }
}
