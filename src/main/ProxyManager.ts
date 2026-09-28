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

  // Temporary zone containing ONLY the live proxies prepared for the next
  // rotation. It is frozen at rotation time, consumed once, then completely
  // erased before preparation for the following rotation begins.
  private storeController: AbortController | null = null;
  private storeRunning = false;
  private storeTargetSize = 1;
  private validatedStore = new Map<string, ProxyRecord>();
  private storeSeenEndpoints = new Set<string>();

  // Retained only for the legacy validate-and-assign fallback below.
  private usedProxyIds = new Set<string>();

  async init(): Promise<void> {
    this.allProxies.clear();
    this.assignments.clear();
    this.usedProxyIds.clear();
    this.stopValidatedProxyStore();
    this.validatedStore.clear();
    this.storeSeenEndpoints.clear();
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
   * Begin preparing the temporary zone used by the very next rotation.
   * Validation happens while the current browser cycle is running.
   */
  startValidatedProxyStore(browserCount: number): void {
    this.storeRunning = true;
    this.prepareFreshRotationBuffer(browserCount);
  }

  /**
   * Stop all next-rotation preparation and discard the temporary zone.
   */
  stopValidatedProxyStore(): void {
    this.storeRunning = false;
    this.storeController?.abort();
    this.storeController = null;
    this.validatedStore.clear();
    this.storeSeenEndpoints.clear();
  }

  /**
   * Freeze the already-prepared temporary zone before a rotation consumes it.
   * No newly validated proxy can enter the zone after this call.
   */
  pauseValidatedProxyStore(): void {
    this.storeController?.abort();
    this.storeController = null;
  }

  getValidatedStoreSize(): number {
    return this.validatedStore.size;
  }

  /**
   * Drop the previous rotation's logical proxy assignments. BrowserManager
   * swaps each browser directly to its newly prepared proxy immediately after
   * this, so there is no deliberate direct-network phase between rotations.
   */
  dropCurrentAssignments(): void {
    this.assignments.clear();
  }

  /**
   * After the prepared proxies have been assigned for this rotation, erase
   * every remaining proxy/check from that temporary zone and immediately start
   * validating a completely new zone for the next rotation.
   */
  resetValidatedStoreForNextRotation(browserCount: number): void {
    this.validatedStore.clear();
    this.storeSeenEndpoints.clear();
    this.allProxies.clear();

    if (!this.storeRunning) return;

    this.prepareFreshRotationBuffer(browserCount);
    logger.info(
      'proxy',
      'Rotation proxies assigned; erased temporary proxy zone and started fresh validation for the next rotation.'
    );
  }

  /**
   * Remove one already-validated proxy from the frozen temporary zone and
   * lease it exclusively to one browser for the current rotation.
   */
  takeValidatedProxy(browserId: number): ProxyRecord | null {
    const candidates = Array.from(this.validatedStore.values())
      .filter((proxy) => proxy.status === 'working')
      .sort((a, b) => (b.score - a.score) || ((a.latencyMs ?? Infinity) - (b.latencyMs ?? Infinity)));

    const proxy = candidates[0];
    if (!proxy) return null;

    this.validatedStore.delete(proxy.id);
    this.assignments.set(browserId, proxy);
    return proxy;
  }

  private prepareFreshRotationBuffer(browserCount: number): void {
    const normalizedCount = Math.max(1, Math.min(100, Math.floor(browserCount || 1)));
    this.storeTargetSize = normalizedCount;

    this.storeController?.abort();
    this.storeController = null;
    this.validatedStore.clear();
    this.storeSeenEndpoints.clear();
    this.allProxies.clear();

    if (!this.storeRunning) return;

    const controller = new AbortController();
    this.storeController = controller;
    void this.runStoreWorker(controller);
  }

  private async runStoreWorker(controller: AbortController): Promise<void> {
    try {
      while (
        this.storeRunning &&
        this.storeController === controller &&
        !controller.signal.aborted
      ) {
        if (this.validatedStore.size >= this.storeTargetSize) {
          logger.info(
            'proxy',
            `Next-rotation proxy zone ready: ${this.validatedStore.size}/${this.storeTargetSize} live proxies.`
          );
          return;
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

          const assignedEndpoints = new Set(
            Array.from(this.assignments.values())
              .filter((proxy): proxy is ProxyRecord => Boolean(proxy))
              .map(endpointKey)
          );
          const bufferedEndpoints = new Set(
            Array.from(this.validatedStore.values()).map(endpointKey)
          );

          const selectCandidates = (respectSeen: boolean): ProxyRecord[] => {
            const selected: ProxyRecord[] = [];
            const selectedEndpoints = new Set<string>();

            for (const proxy of replacement) {
              const endpoint = endpointKey(proxy);
              if (assignedEndpoints.has(endpoint)) continue;
              if (bufferedEndpoints.has(endpoint)) continue;
              if (selectedEndpoints.has(endpoint)) continue;
              if (respectSeen && this.storeSeenEndpoints.has(endpoint)) continue;

              selectedEndpoints.add(endpoint);
              selected.push(proxy);
            }
            return selected;
          };

          let candidates = selectCandidates(true);

          // If the public feed has not changed, dead endpoints may be checked
          // again later. Current-cycle assignments and already-buffered
          // endpoints remain excluded.
          if (candidates.length === 0) {
            this.storeSeenEndpoints.clear();
            candidates = selectCandidates(false);
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
            this.storeSeenEndpoints.add(endpointKey(proxy));
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
                this.storeController !== controller ||
                this.validatedStore.size >= this.storeTargetSize
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

              if (validated.status !== 'working') return;

              const endpoint = endpointKey(validated);
              const currentAssigned = Array.from(this.assignments.values()).some(
                (assigned) => assigned && endpointKey(assigned) === endpoint
              );
              const alreadyBuffered = Array.from(this.validatedStore.values()).some(
                (stored) => endpointKey(stored) === endpoint
              );

              if (!currentAssigned && !alreadyBuffered) {
                this.validatedStore.set(validated.id, validated);
              }
            }
          });

          logger.info(
            'proxy',
            `Preparing next rotation: ${this.validatedStore.size}/${this.storeTargetSize} live proxies ready.`
          );

          await waitWithAbort(STORE_REFILL_PAUSE_MS, controller.signal);
        } catch (err) {
          if (controller.signal.aborted || this.storeController !== controller) return;
          logger.warn('proxy', `Next-rotation proxy validation failed: ${(err as Error).message}`);
          await waitWithAbort(STORE_RETRY_PAUSE_MS, controller.signal);
        }
      }
    } finally {
      if (this.storeController === controller && this.validatedStore.size >= this.storeTargetSize) {
        this.storeController = null;
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

function endpointKey(proxy: Pick<ProxyRecord, 'host' | 'port'>): string {
  return `${proxy.host.toLowerCase()}:${proxy.port}`;
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
