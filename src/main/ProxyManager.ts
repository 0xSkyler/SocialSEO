import { EventEmitter } from 'node:events';
import type {
  ProxyAssignment,
  ProxyRecord,
  ReloadProgress,
  ReloadProxiesSummary
} from '../shared/types/proxy';
import { dedupeProxies, parseBulkText } from '../proxy/ProxyParser';
import { ProxyValidator } from '../proxy/ProxyValidator';
import { scoreProxy } from '../proxy/ProxyScorer';
import { fetchProxyScrapeFreeList } from '../proxy/ProxyScrapeProvider';
import { logger } from './Logger';

const VALIDATION_TIMEOUT_MS = 4000;
const MAX_CONCURRENT_CHECKS = 32;
const IP_CHECK_URL = 'https://api.ipify.org?format=json';

interface PreparedProxyPool {
  fetched: number;
  checked: number;
  total: number;
  live: ProxyRecord[];
  preparedAt: string;
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
  private allProxies = new Map<string, ProxyRecord>();
  private assignments = new Map<number, ProxyRecord | null>();
  private validationController: AbortController | null = null;
  private prevalidationController: AbortController | null = null;
  private preparedPool: PreparedProxyPool | null = null;
  private usedProxyIds = new Set<string>();

  async init(): Promise<void> {
    this.allProxies.clear();
    this.assignments.clear();
    this.usedProxyIds.clear();
    this.cancelPreparedValidation();
    logger.info('proxy', 'Proxy manager ready: ProxyScrape API source, session-only state.');
  }

  getAll(): ProxyRecord[] {
    return Array.from(this.allProxies.values()).map((proxy) => ({ ...proxy, password: undefined }));
  }

  getAssignment(browserId: number): ProxyRecord | null {
    return this.assignments.get(browserId) ?? null;
  }

  resetRotationHistory(): void {
    this.usedProxyIds.clear();
  }

  cancelCurrentValidation(): void {
    this.validationController?.abort();
    this.validationController = null;
  }

  cancelPreparedValidation(): void {
    this.prevalidationController?.abort();
    this.prevalidationController = null;
    this.preparedPool = null;
  }

  /**
   * Background preparation for the next rotation.
   *
   * This does not touch the currently assigned browser proxies. It fetches a
   * fresh ProxyScrape list and validates candidates in the background, stopping
   * early once enough previously-unused live proxies have been found for the
   * next cycle. The prepared pool is activated only when the next cycle starts.
   */
  async prepareNextCycle(browserIds: number[]): Promise<void> {
    this.cancelPreparedValidation();
    if (browserIds.length === 0) return;

    const controller = new AbortController();
    this.prevalidationController = controller;

    try {
      const raw = await fetchProxyScrapeFreeList({
        limit: 2000,
        timeoutFilterMs: VALIDATION_TIMEOUT_MS,
        requestTimeoutMs: 15_000,
        signal: controller.signal
      });

      if (controller.signal.aborted) return;

      const parsed = parseBulkText(raw, 'ProxyScrape Free API');
      const replacement = dedupeProxies(parsed.proxies);
      if (replacement.length === 0) {
        logger.warn('proxy', 'Next-cycle prevalidation found no usable ProxyScrape entries.');
        return;
      }

      const usedSnapshot = new Set(this.usedProxyIds);
      const currentAssignmentIds = new Set(
        Array.from(this.assignments.values())
          .filter((proxy): proxy is ProxyRecord => Boolean(proxy))
          .map((proxy) => proxy.id)
      );

      const candidates = [
        ...replacement.filter(
          (proxy) => !usedSnapshot.has(proxy.id) && !currentAssignmentIds.has(proxy.id)
        ),
        ...replacement.filter(
          (proxy) => !usedSnapshot.has(proxy.id) && currentAssignmentIds.has(proxy.id)
        ),
        ...replacement.filter((proxy) => usedSnapshot.has(proxy.id))
      ];

      const targetCount = browserIds.length;
      const liveUnused: ProxyRecord[] = [];
      const liveUsed: ProxyRecord[] = [];
      let cursor = 0;
      let checked = 0;

      const worker = async (): Promise<void> => {
        while (!controller.signal.aborted) {
          if (liveUnused.length >= targetCount) return;

          const index = cursor++;
          if (index >= candidates.length) return;

          const candidate = { ...candidates[index], status: 'checking' as const };
          const result = await ProxyValidator.validate(candidate, {
            timeoutMs: VALIDATION_TIMEOUT_MS,
            ipCheckUrl: IP_CHECK_URL,
            signal: controller.signal
          });

          if (controller.signal.aborted) return;

          checked += 1;
          const validated: ProxyRecord = {
            ...candidate,
            status: result.status,
            latencyMs: result.latencyMs,
            lastChecked: result.checkedAt,
            successCount: candidate.successCount + (result.status === 'working' ? 1 : 0),
            failureCount: candidate.failureCount + (result.status === 'working' ? 0 : 1)
          };
          validated.score = scoreProxy(validated);

          if (validated.status === 'working') {
            if (usedSnapshot.has(validated.id)) liveUsed.push(validated);
            else liveUnused.push(validated);
          }
        }
      };

      const workers = Array.from(
        { length: Math.min(MAX_CONCURRENT_CHECKS, candidates.length) },
        () => worker()
      );
      await Promise.all(workers);

      if (controller.signal.aborted || this.prevalidationController !== controller) return;

      const live = [...liveUnused, ...liveUsed];
      this.preparedPool = {
        fetched: replacement.length,
        checked,
        total: candidates.length,
        live,
        preparedAt: new Date().toISOString()
      };

      logger.info(
        'proxy',
        `Prepared next cycle: ${liveUnused.length} unused live proxy/proxies, ` +
          `${liveUsed.length} previously-used live proxy/proxies after ${checked} checks.`
      );
    } catch (err) {
      if (!controller.signal.aborted) {
        logger.warn('proxy', `Next-cycle prevalidation failed: ${(err as Error).message}`);
      }
    } finally {
      if (this.prevalidationController === controller) {
        this.prevalidationController = null;
      }
    }
  }

  /**
   * Activates the already-validated background pool without performing any
   * network validation. Returns null when no prepared live pool is available,
   * allowing the caller to fall back to the original streaming validation.
   */
  activatePreparedAssignments(
    browserIds: number[],
    onAssignment: (assignment: ProxyAssignment, checked: number, total: number) => void,
    onProgress?: (checked: number, total: number, working: number, assigned: number, fetched: number) => void
  ): ReloadProxiesSummary | null {
    const prepared = this.preparedPool;
    if (!prepared || prepared.live.length === 0) return null;

    const previousAssignments = new Map(this.assignments);
    let eligible = prepared.live.filter((proxy) => !this.usedProxyIds.has(proxy.id));

    // Preserve the original v0.5.4 rotation rule: only reset history when all
    // currently-live prepared endpoints have already been consumed.
    if (
      eligible.length === 0 &&
      prepared.live.length > 0 &&
      prepared.live.every((proxy) => this.usedProxyIds.has(proxy.id))
    ) {
      this.usedProxyIds.clear();
      eligible = [...prepared.live];
    }

    if (eligible.length === 0) return null;

    this.allProxies.clear();
    this.assignments.clear();
    for (const proxy of prepared.live) this.allProxies.set(proxy.id, proxy);

    const remaining = [...eligible];
    let assigned = 0;

    onProgress?.(
      prepared.checked,
      prepared.total,
      prepared.live.length,
      0,
      prepared.fetched
    );

    for (const browserId of browserIds) {
      if (remaining.length === 0) break;

      const previousId = previousAssignments.get(browserId)?.id;
      const index = remaining.findIndex((proxy) => proxy.id !== previousId);
      const selectedIndex = index >= 0 ? index : 0;
      const [proxy] = remaining.splice(selectedIndex, 1);

      this.assignments.set(browserId, proxy);
      this.usedProxyIds.add(proxy.id);
      assigned += 1;
      onAssignment({ browserId, proxy }, prepared.checked, prepared.total);
    }

    const summary = this.summary(browserIds, prepared.fetched, prepared.live.length);
    this.preparedPool = null;

    onProgress?.(
      prepared.checked,
      prepared.total,
      prepared.live.length,
      assigned,
      prepared.fetched
    );
    this.emit('assignmentsChanged', summary);

    logger.info(
      'proxy',
      `Activated prevalidated proxy pool prepared at ${prepared.preparedAt}; ` +
        `${assigned}/${browserIds.length} browser(s) assigned without revalidation.`
    );

    return summary;
  }

  /**
   * Fetches ProxyScrape's public feed, validates it locally, and assigns live
   * proxies immediately as individual validation results arrive.
   *
   * One proxy is exclusive to one browser in a cycle. Across cycles, proxies
   * already used by automation stay ineligible until the available live pool
   * has been exhausted, at which point a new rotation round begins.
   */
  async fetchValidateAssignStreaming(
    browserIds: number[],
    onAssignment: (assignment: ProxyAssignment, checked: number, total: number) => void,
    onProgress?: (checked: number, total: number, working: number, assigned: number, fetched: number) => void
  ): Promise<ReloadProxiesSummary> {
    this.cancelCurrentValidation();
    const controller = new AbortController();
    this.validationController = controller;

    const previousAssignments = new Map(this.assignments);

    const raw = await fetchProxyScrapeFreeList({
      limit: 2000,
      timeoutFilterMs: VALIDATION_TIMEOUT_MS,
      requestTimeoutMs: 15_000,
      signal: controller.signal
    });

    if (controller.signal.aborted) throw new Error('Proxy validation cancelled.');

    const parsed = parseBulkText(raw, 'ProxyScrape Free API');
    const replacement = dedupeProxies(parsed.proxies);
    if (replacement.length === 0) {
      throw new Error('ProxyScrape returned no usable proxies.');
    }

    // Keep rotation history only for endpoints that still exist in the newly
    // fetched public feed.
    const replacementIds = new Set(replacement.map((proxy) => proxy.id));
    for (const id of Array.from(this.usedProxyIds)) {
      if (!replacementIds.has(id)) this.usedProxyIds.delete(id);
    }
    if (replacement.every((proxy) => this.usedProxyIds.has(proxy.id))) {
      this.usedProxyIds.clear();
    }

    this.allProxies.clear();
    this.assignments.clear();
    for (const proxy of replacement) {
      this.allProxies.set(proxy.id, { ...proxy, status: 'checking' });
    }

    const candidates = Array.from(this.allProxies.values());
    const total = candidates.length;
    const remainingBrowsers = new Set(browserIds);
    const usedThisCycle = new Set<string>();
    let working = 0;
    let assigned = 0;

    const emitProgress = (checked: number) => {
      this.emit('reloadProgress', { checked, total });
      onProgress?.(checked, total, working, assigned, replacement.length);
    };

    emitProgress(0);

    const chooseBrowser = (proxy: ProxyRecord): number | null => {
      if (this.usedProxyIds.has(proxy.id) || usedThisCycle.has(proxy.id)) return null;
      const ids = Array.from(remainingBrowsers);
      if (ids.length === 0) return null;
      return ids.find((id) => previousAssignments.get(id)?.id !== proxy.id) ?? ids[0] ?? null;
    };

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
            this.emitAssignments(browserIds, replacement.length, working);
          }
        }

        this.emit('reloadProgress', { checked, total: resultTotal });
        onProgress?.(checked, resultTotal, working, assigned, replacement.length);
      }
    });

    if (controller.signal.aborted || this.validationController !== controller) {
      return this.summary(browserIds, replacement.length, working);
    }

    // Preserve final states from the validator.
    for (const result of results) {
      const proxy = this.allProxies.get(result.proxyId);
      if (!proxy) continue;
      proxy.status = result.status;
      proxy.latencyMs = result.latencyMs;
      proxy.lastChecked = result.checkedAt;
      proxy.score = scoreProxy(proxy);
      this.allProxies.set(proxy.id, proxy);
    }

    // If every live endpoint has already been consumed in earlier rounds,
    // begin a new round and fill any browsers that did not receive a proxy.
    const live = Array.from(this.allProxies.values()).filter((proxy) => proxy.status === 'working');
    if (
      remainingBrowsers.size > 0 &&
      live.length > 0 &&
      live.every((proxy) => this.usedProxyIds.has(proxy.id))
    ) {
      this.usedProxyIds.clear();
      for (const browserId of Array.from(remainingBrowsers)) {
        const available = live.filter((proxy) => !usedThisCycle.has(proxy.id));
        if (available.length === 0) break;
        const previousId = previousAssignments.get(browserId)?.id;
        const proxy = available.find((candidate) => candidate.id !== previousId) ?? available[0];
        this.assignments.set(browserId, proxy);
        remainingBrowsers.delete(browserId);
        usedThisCycle.add(proxy.id);
        this.usedProxyIds.add(proxy.id);
        assigned += 1;
        onAssignment({ browserId, proxy }, total, total);
      }
    }

    emitProgress(total);
    const summary = this.summary(browserIds, replacement.length, working);
    this.emit('assignmentsChanged', summary);
    if (this.validationController === controller) this.validationController = null;
    return summary;
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
