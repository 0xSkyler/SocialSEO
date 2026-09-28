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
const STORE_MIN_SIZE = 20;
const STORE_MULTIPLIER = 2;
const STORE_MAX_SIZE = 200;
const STORE_REFILL_PAUSE_MS = 500;
const STORE_RETRY_PAUSE_MS = 5_000;
const STORE_BATCH_SIZE = 256;

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
  private storeController: AbortController | null = null;
  private storeRunning = false;
  private storeTargetSize = STORE_MIN_SIZE;
  private validatedStore = new Map<string, ProxyRecord>();
  private storeSeenIds = new Set<string>();
  private previousCohortIds = new Set<string>();
  private usedProxyIds = new Set<string>();

  async init(): Promise<void> {
    this.allProxies.clear();
    this.assignments.clear();
    this.usedProxyIds.clear();
    this.stopValidatedProxyStore();
    this.validatedStore.clear();
    this.storeSeenIds.clear();
    this.previousCohortIds.clear();
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

  /**
   * Starts a background live-proxy store for the automation session.
   *
   * The worker is independent of cycle boundaries. It validates proxies while
   * browsers are working and keeps a bounded reserve ready for later cycles.
   */
  startValidatedProxyStore(browserCount: number): void {
    const normalizedCount = Math.max(1, Math.min(100, Math.floor(browserCount || 1)));
    this.storeTargetSize = Math.max(
      STORE_MIN_SIZE,
      Math.min(STORE_MAX_SIZE, normalizedCount * STORE_MULTIPLIER)
    );

    if (this.storeRunning) return;

    this.storeRunning = true;
    this.validatedStore.clear();
    this.storeSeenIds.clear();
    this.previousCohortIds.clear();
    this.restartStoreWorker();
  }

  stopValidatedProxyStore(): void {
    this.storeRunning = false;
    this.storeController?.abort();
    this.storeController = null;
  }

  getValidatedStoreSize(): number {
    return this.validatedStore.size;
  }

  /**
   * Called after cycle 5, 10, 15, ... has received its proxies.
   *
   * Remaining stored proxies from the completed five-cycle cohort are deleted.
   * Proxies used in that cohort are excluded from the immediately following
   * cohort so the new store is genuinely rebuilt from fresh endpoints.
   */
  resetValidatedStoreForNextCohort(): void {
    this.previousCohortIds = new Set(this.usedProxyIds);
    this.usedProxyIds.clear();
    this.validatedStore.clear();
    this.storeSeenIds.clear();
    this.allProxies.clear();
    this.restartStoreWorker();
    logger.info('proxy', 'Cleared validated proxy store after five cycles; rebuilding a fresh store.');
  }

  /**
   * Atomically removes one validated proxy from the reserve and leases it to
   * the supplied browser. Assigned endpoints are never present in the reserve.
   */
  takeValidatedProxy(browserId: number): ProxyRecord | null {
    const previousId = this.assignments.get(browserId)?.id;
    const candidates = Array.from(this.validatedStore.values())
      .filter((proxy) => proxy.status === 'working')
      .sort((a, b) => (b.score - a.score) || ((a.latencyMs ?? Infinity) - (b.latencyMs ?? Infinity)));

    if (candidates.length === 0) return null;

    const proxy = candidates.find((candidate) => candidate.id !== previousId) ?? candidates[0];
    this.validatedStore.delete(proxy.id);
    this.assignments.set(browserId, proxy);
    this.usedProxyIds.add(proxy.id);

    // Consuming a stored proxy creates room in the reserve. The background
    // worker notices immediately and continues replenishing it.
    return proxy;
  }

  private restartStoreWorker(): void {
    this.storeController?.abort();
    this.storeController = null;
    if (!this.storeRunning) return;

    const controller = new AbortController();
    this.storeController = controller;
    void this.runStoreWorker(controller);
  }

  private async runStoreWorker(controller: AbortController): Promise<void> {
    while (
      this.storeRunning &&
      this.storeController === controller &&
      !controller.signal.aborted
    ) {
      if (this.validatedStore.size >= this.storeTargetSize) {
        await waitWithAbort(STORE_REFILL_PAUSE_MS, controller.signal);
        continue;
      }

      try {
        const raw = await fetchProxyScrapeFreeList({
          limit: 2000,
          timeoutFilterMs: VALIDATION_TIMEOUT_MS,
          requestTimeoutMs: 15_000,
          signal: controller.signal
        });

        if (controller.signal.aborted || this.storeController !== controller) return;

        const parsed = parseBulkText(raw, 'ProxyScrape Free API');
        const replacement = dedupeProxies(parsed.proxies);
        const assignedIds = new Set(
          Array.from(this.assignments.values())
            .filter((proxy): proxy is ProxyRecord => Boolean(proxy))
            .map((proxy) => proxy.id)
        );

        let candidates = replacement.filter(
          (proxy) =>
            !this.validatedStore.has(proxy.id) &&
            !this.usedProxyIds.has(proxy.id) &&
            !this.previousCohortIds.has(proxy.id) &&
            !assignedIds.has(proxy.id) &&
            !this.storeSeenIds.has(proxy.id)
        );

        // A public feed can remain unchanged for a while. Once every currently
        // eligible endpoint has been checked, allow dead endpoints to be
        // reconsidered on a later pass while still excluding stored/used/
        // assigned/previous-cohort proxies.
        if (candidates.length === 0) {
          this.storeSeenIds.clear();
          candidates = replacement.filter(
            (proxy) =>
              !this.validatedStore.has(proxy.id) &&
              !this.usedProxyIds.has(proxy.id) &&
              !this.previousCohortIds.has(proxy.id) &&
              !assignedIds.has(proxy.id)
          );
        }

        if (candidates.length === 0) {
          await waitWithAbort(STORE_RETRY_PAUSE_MS, controller.signal);
          continue;
        }

        const need = Math.max(1, this.storeTargetSize - this.validatedStore.size);
        const batchSize = Math.min(
          STORE_BATCH_SIZE,
          Math.max(need * 3, Math.min(64, candidates.length))
        );
        const batch = candidates.slice(0, batchSize);

        for (const proxy of batch) {
          this.storeSeenIds.add(proxy.id);
          this.allProxies.set(proxy.id, { ...proxy, status: 'checking' });
        }

        await ProxyValidator.validateMany(batch, {
          timeoutMs: VALIDATION_TIMEOUT_MS,
          ipCheckUrl: IP_CHECK_URL,
          maxConcurrent: MAX_CONCURRENT_CHECKS,
          signal: controller.signal,
          onResult: (result) => {
            if (
              controller.signal.aborted ||
              this.storeController !== controller
            ) {
              return;
            }

            const source = batch.find((proxy) => proxy.id === result.proxyId);
            if (!source) return;

            const validated: ProxyRecord = {
              ...source,
              status: result.status,
              latencyMs: result.latencyMs,
              lastChecked: result.checkedAt,
              successCount: source.successCount + (result.status === 'working' ? 1 : 0),
              failureCount: source.failureCount + (result.status === 'working' ? 0 : 1)
            };
            validated.score = scoreProxy(validated);
            this.allProxies.set(validated.id, validated);

            if (
              validated.status === 'working' &&
              this.validatedStore.size < this.storeTargetSize &&
              !this.usedProxyIds.has(validated.id) &&
              !this.previousCohortIds.has(validated.id) &&
              !Array.from(this.assignments.values()).some(
                (assigned) => assigned?.id === validated.id
              )
            ) {
              this.validatedStore.set(validated.id, validated);
            }
          }
        });

        logger.info(
          'proxy',
          `Validated proxy store: ${this.validatedStore.size}/${this.storeTargetSize} live proxies ready.`
        );

        await waitWithAbort(STORE_REFILL_PAUSE_MS, controller.signal);
      } catch (err) {
        if (controller.signal.aborted || this.storeController !== controller) return;
        logger.warn('proxy', `Continuous proxy validation failed: ${(err as Error).message}`);
        await waitWithAbort(STORE_RETRY_PAUSE_MS, controller.signal);
      }
    }
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

function waitWithAbort(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted) {
      resolve();
      return;
    }
    const timer = setTimeout(resolve, ms);
    signal.addEventListener('abort', () => {
      clearTimeout(timer);
      resolve();
    }, { once: true });
  });
}
