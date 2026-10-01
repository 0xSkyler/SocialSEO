import { randomUUID } from 'node:crypto';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import path from 'node:path';
import { app } from 'electron';
import type { ProxyAssignment, ProxyImportResult, ProxyRecord, ProxyValidationProgress } from '../shared/types/proxy';
import { getProxyProvider, type ProxyProvider } from '../shared/proxySource';
import { parseProxyText } from '../proxy/ProxyParser';
import { ProxyValidator } from './ProxyValidator';
import { SettingsManager } from './SettingsManager';

const BACKGROUND_IDLE_MS = 750;
const PROVIDER_REFRESH_MS = 60_000;
const DEAD_RECHECK_MS = 30_000;
const VALIDATION_BATCH_SIZE = 240;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    timer.unref?.();
  });
}

export class ProxyManager extends EventEmitter {
  private readonly validator = new ProxyValidator();
  private proxies: ProxyRecord[] = [];
  private assignments: ProxyAssignment[] = [];

  // The validated store is deliberately separate from the provider candidate
  // list. Browser slots only consume endpoints from this map.
  private validatedStore = new Map<string, ProxyRecord>();
  private usedThisCycle = new Set<string>();
  private lastImportedIds: string[] = [];

  private validationGeneration = 0;
  private validationProgress: ProxyValidationProgress = this.emptyProgress();

  private continuousGeneration = 0;
  private continuousProvider?: ProxyProvider;
  private continuousOnWorking?: (proxy: ProxyRecord) => void | Promise<void>;
  private lastProviderRefreshAt = 0;
  private lastPurgedBrowserCycle = 0;
  private currentPoolIds = new Set<string>();
  private lastFetchedBrowserCycle = 0;
  private refreshPromise?: Promise<void>;

  constructor(private readonly settings: SettingsManager) {
    super();
    this.removeLegacyProxyCache();
  }

  private emptyProgress(): ProxyValidationProgress {
    return {
      runId: '',
      active: false,
      cancelled: false,
      total: 0,
      completed: 0,
      checking: 0,
      working: 0,
      dead: 0,
      assigned: 0
    };
  }

  private removeLegacyProxyCache(): void {
    const userData = app.getPath('userData');
    for (const file of ['proxies.json', 'assignments.json', 'proxy-credentials.json']) {
      try { fs.rmSync(path.join(userData, file), { force: true }); } catch { /* best effort migration cleanup */ }
    }
  }

  private emitChanged(): void { this.emit('changed', this.getPublicList()); }
  private emitValidationProgress(): void { this.emit('validation-progress', this.getValidationProgress()); }

  getAll(): ProxyRecord[] { return this.proxies.map((proxy) => ({ ...proxy })); }
  getPublicList(): ProxyRecord[] {
    return this.proxies.map((proxy) => {
      const safe = { ...proxy };
      if (safe.status === 'working' && !this.validatedStore.has(safe.id)) safe.status = 'unverified';
      delete safe.password;
      return safe;
    });
  }
  getAssignments(): ProxyAssignment[] { return this.assignments.map((assignment) => ({ ...assignment })); }
  getLastImportedIds(): string[] { return [...this.lastImportedIds]; }
  getValidationProgress(): ProxyValidationProgress { return structuredClone(this.validationProgress); }
  getValidatedStore(): ProxyRecord[] { return [...this.validatedStore.values()].map((proxy) => ({ ...proxy })); }
  isStoredLiveProxy(proxyId?: string): boolean { return Boolean(proxyId && this.validatedStore.get(proxyId)?.status === 'working'); }

  private assignedProxyIds(excludeWorkspaceId?: number): Set<string> {
    return new Set(this.assignments
      .filter((assignment) => assignment.workspaceId !== excludeWorkspaceId && assignment.proxyId)
      .map((assignment) => assignment.proxyId as string));
  }

  private eligiblePool(): ProxyRecord[] {
    return [...this.validatedStore.values()].filter((proxy) =>
      proxy.status === 'working'
      && (this.currentPoolIds.size === 0 || this.currentPoolIds.has(proxy.id))
    );
  }

  private markUsed(proxyId?: string): void {
    if (proxyId) this.usedThisCycle.add(proxyId);
  }

  private beginNextProxyCycle(): void {
    this.usedThisCycle = this.assignedProxyIds();
  }

  private resetProxyCycle(): void {
    this.usedThisCycle.clear();
  }

  getAssignedProxy(workspaceId: number): ProxyRecord | undefined {
    const proxyId = this.assignments.find((item) => item.workspaceId === workspaceId)?.proxyId;
    const proxy = proxyId ? this.proxies.find((item) => item.id === proxyId) : undefined;
    return proxy ? { ...proxy } : undefined;
  }

  private mergeProxyText(text: string, source: string, resetTouchedState: boolean): ProxyImportResult {
    const parsed = parseProxyText(text, source);
    const existing = new Map(this.proxies.map((proxy) => [`${proxy.protocol}|${proxy.host.toLowerCase()}|${proxy.port}`, proxy]));
    let existingDuplicates = 0;
    const touchedIds: string[] = [];

    for (const proxy of parsed.proxies) {
      const key = `${proxy.protocol}|${proxy.host.toLowerCase()}|${proxy.port}`;
      const previous = existing.get(key);
      if (previous) {
        existingDuplicates += 1;
        previous.username = proxy.username ?? previous.username;
        previous.password = proxy.password ?? previous.password;
        if (resetTouchedState && !this.validatedStore.has(previous.id) && !this.assignedProxyIds().has(previous.id)) {
          previous.status = 'unverified';
          previous.latencyMs = undefined;
          previous.lastCheckedAt = undefined;
          previous.lastError = undefined;
        }
        touchedIds.push(previous.id);
        continue;
      }
      this.proxies.push(proxy);
      existing.set(key, proxy);
      touchedIds.push(proxy.id);
    }

    this.lastImportedIds = [...new Set(touchedIds)];
    for (const id of this.lastImportedIds) {
      const index = this.proxies.findIndex((proxy) => proxy.id === id);
      if (index < 0) continue;
      const trusted = {
        ...this.proxies[index]!,
        status: 'working' as const,
        latencyMs: undefined,
        lastCheckedAt: undefined,
        lastError: undefined
      };
      this.proxies[index] = trusted;
      this.validatedStore.set(id, { ...trusted });
    }
    return {
      imported: parsed.proxies.length + parsed.errors.length + parsed.duplicates,
      valid: parsed.proxies.length - existingDuplicates,
      invalid: parsed.errors.length,
      duplicates: parsed.duplicates + existingDuplicates,
      assigned: 0,
      errors: parsed.errors
    };
  }

  async importText(text: string, source = 'proxy.txt'): Promise<ProxyImportResult> {
    this.stopContinuousValidation();
    this.cancelValidation();
    this.validatedStore.clear();
    this.resetProxyCycle();
    const result = this.mergeProxyText(text, source, true);
    this.currentPoolIds = new Set(this.lastImportedIds);
    this.validationProgress = this.emptyProgress();
    this.validationProgress.total = this.currentPoolIds.size;
    this.validationProgress.completed = this.currentPoolIds.size;
    this.validationProgress.working = this.currentPoolIds.size;
    this.emitValidationProgress();
    this.emitChanged();
    return result;
  }

  private async fetchText(url: string): Promise<string> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 20_000);
    timeout.unref?.();
    try {
      const response = await fetch(url, {
        method: 'GET',
        headers: {
          accept: 'text/plain',
          'cache-control': 'no-cache, no-store, max-age=0',
          pragma: 'no-cache'
        },
        signal: controller.signal
      });
      if (!response.ok) throw new Error(`Proxy provider returned HTTP ${response.status}`);
      const body = await response.text();
      if (!body.trim()) throw new Error('Proxy provider returned an empty proxy list.');
      if (body.length > 12_000_000) throw new Error('Proxy provider response exceeded the 12 MB safety limit.');
      return body;
    } catch (error) {
      if (controller.signal.aborted) throw new Error('Proxy provider request timed out after 20 seconds.');
      throw error;
    } finally {
      clearTimeout(timeout);
    }
  }

  private async fetchProviderText(provider: ProxyProvider): Promise<{ text: string; label: string }> {
    void provider;
    const definition = getProxyProvider('private-api');
    const text = await this.fetchText(definition.feeds[0]!.url);
    return { text, label: definition.label };
  }

  async fetchProvider(provider: ProxyProvider = this.settings.get().proxyProvider): Promise<ProxyImportResult> {
    const fetched = await this.fetchProviderText(provider);
    this.clear();
    const result = await this.importText(fetched.text, fetched.label);
    this.currentPoolIds = new Set(this.lastImportedIds);
    this.lastProviderRefreshAt = Date.now();
    return result;
  }

  async fetchProxyScrape(): Promise<ProxyImportResult> {
    return this.fetchProvider('private-api');
  }

  private async refreshProviderCandidates(provider: ProxyProvider): Promise<void> {
    const fetched = await this.fetchProviderText(provider);
    this.mergeProxyText(fetched.text, fetched.label, false);
    this.lastProviderRefreshAt = Date.now();
    this.emitChanged();
  }

  private shouldRevalidate(proxy: ProxyRecord, now: number): boolean {
    if (this.validatedStore.has(proxy.id)) return false;
    if (this.assignedProxyIds().has(proxy.id) || proxy.status === 'checking') return false;
    if (proxy.status === 'unverified') return true;
    if (!proxy.lastCheckedAt) return true;
    const checkedAt = Date.parse(proxy.lastCheckedAt);
    return !Number.isFinite(checkedAt) || now - checkedAt >= DEAD_RECHECK_MS;
  }

  private purgeValidatedStore(): void {
    const oldStoreIds = [...this.validatedStore.keys()];
    this.validatedStore.clear();
    this.resetProxyCycle();

    const leased = this.assignedProxyIds();
    for (const proxy of this.proxies) {
      if (oldStoreIds.includes(proxy.id) && !leased.has(proxy.id)) {
        proxy.status = 'unverified';
        proxy.latencyMs = undefined;
        proxy.lastError = undefined;
      }
    }

    this.validationProgress.working = 0;
    this.validationProgress.assigned = this.assignments.filter((assignment) => assignment.proxyId && this.validatedStore.has(assignment.proxyId)).length;
    this.lastProviderRefreshAt = 0;
    this.currentPoolIds.clear();
    this.lastFetchedBrowserCycle = 0;
    this.refreshPromise = undefined;
    this.emitChanged();
    this.emitValidationProgress();
  }

  noteCompletedBrowserCycle(cycleNumber: number): boolean {
    void cycleNumber;
    return false;
  }

  private async refreshCurrentPool(): Promise<void> {
    const fetched = await this.fetchProviderText('private-api');
    const assigned = this.assignedProxyIds();
    this.mergeProxyText(fetched.text, fetched.label, true);
    const freshIds = new Set(this.lastImportedIds);
    this.currentPoolIds = freshIds;

    this.proxies = this.proxies.filter((proxy) => freshIds.has(proxy.id) || assigned.has(proxy.id));
    for (const id of [...this.validatedStore.keys()]) {
      if (!freshIds.has(id) && !assigned.has(id)) this.validatedStore.delete(id);
    }

    this.lastProviderRefreshAt = Date.now();
    this.validationProgress.total = freshIds.size;
    this.validationProgress.completed = freshIds.size;
    this.validationProgress.checking = 0;
    this.validationProgress.working = this.eligiblePool().length;
    this.validationProgress.dead = 0;
    this.validationProgress.assigned = this.assignments.filter((assignment) => Boolean(assignment.proxyId)).length;
    this.emitChanged();
    this.emitValidationProgress();
  }

  async refreshForBrowserCycle(cycleNumber: number): Promise<void> {
    const cycle = Math.max(1, Math.floor(Number(cycleNumber) || 1));
    if (cycle <= this.lastFetchedBrowserCycle) return;
    if (this.refreshPromise) {
      await this.refreshPromise;
      if (cycle <= this.lastFetchedBrowserCycle) return;
    }
    this.refreshPromise = (async () => {
      this.resetProxyCycle();
      await this.refreshCurrentPool();
      this.lastFetchedBrowserCycle = Math.max(this.lastFetchedBrowserCycle, cycle);
    })();
    try {
      await this.refreshPromise;
    } finally {
      this.refreshPromise = undefined;
    }
  }

  startContinuousValidation(
    provider?: ProxyProvider,
    onWorking?: (proxy: ProxyRecord) => void | Promise<void>
  ): void {
    void provider;
    void onWorking;
    this.stopContinuousValidation();
  }

  stopContinuousValidation(): void {
    this.continuousGeneration += 1;
    this.continuousProvider = undefined;
    this.continuousOnWorking = undefined;
  }

  private async runContinuousValidation(generation: number): Promise<void> {
    while (generation === this.continuousGeneration) {
      if (this.continuousProvider && Date.now() - this.lastProviderRefreshAt >= PROVIDER_REFRESH_MS) {
        try { await this.refreshProviderCandidates(this.continuousProvider); } catch { /* keep validating the current candidate list */ }
        if (generation !== this.continuousGeneration) return;
      }

      const now = Date.now();
      const candidates = this.proxies
        .filter((proxy) => this.shouldRevalidate(proxy, now))
        .slice(0, VALIDATION_BATCH_SIZE);

      if (!candidates.length) {
        await sleep(BACKGROUND_IDLE_MS);
        continue;
      }

      await this.validateStreaming(candidates.map((proxy) => proxy.id), this.continuousOnWorking);
      if (generation !== this.continuousGeneration) return;
      await sleep(50);
    }
  }

  /**
   * Validate proxies concurrently and publish every state transition to the UI.
   * Passing endpoints are copied into the separate validated store immediately.
   */
  async validateStreaming(
    proxyIds?: string[],
    onWorking?: (proxy: ProxyRecord) => void | Promise<void>
  ): Promise<ProxyRecord[]> {
    const ids = proxyIds?.length ? new Set(proxyIds) : undefined;
    const targets = this.proxies.filter((proxy) => !ids || ids.has(proxy.id));
    this.validationProgress = {
      runId: randomUUID(),
      active: false,
      cancelled: false,
      total: targets.length,
      completed: targets.length,
      checking: 0,
      working: targets.length,
      dead: 0,
      assigned: this.assignments.filter((assignment) => Boolean(assignment.proxyId)).length,
      startedAt: new Date().toISOString(),
      finishedAt: new Date().toISOString()
    };
    for (const target of targets) {
      target.status = 'working';
      target.latencyMs = undefined;
      target.lastCheckedAt = undefined;
      target.lastError = undefined;
      this.validatedStore.set(target.id, { ...target });
      if (onWorking) await onWorking({ ...target });
    }
    this.emitChanged();
    this.emitValidationProgress();
    return this.getPublicList();
  }

  async validate(proxyIds?: string[]): Promise<ProxyRecord[]> {
    return this.validateStreaming(proxyIds);
  }

  cancelValidation(): void {
    if (!this.validationProgress.active) return;
    this.validationGeneration += 1;
    this.validationProgress = {
      ...this.validationProgress,
      active: false,
      cancelled: true,
      checking: 0,
      working: this.validatedStore.size,
      finishedAt: new Date().toISOString()
    };
    for (const proxy of this.proxies) {
      if (proxy.status === 'checking') proxy.status = 'unverified';
    }
    this.emitChanged();
    this.emitValidationProgress();
  }

  /** Assign a newly validated endpoint to the next workspace that does not yet
   * have a validated-store lease. Leases remain exclusive. */
  assignWorkingProxyImmediately(proxyId: string): ProxyAssignment | undefined {
    const proxy = this.validatedStore.get(proxyId);
    if (!proxy || proxy.status !== 'working') return undefined;
    const settings = this.settings.get();
    const usedBy = this.assignments.find((item) => item.proxyId === proxyId)?.workspaceId;
    if (usedBy) return { workspaceId: usedBy, proxyId };

    for (let workspaceId = 1; workspaceId <= settings.browserCount; workspaceId += 1) {
      const current = this.getAssignedProxy(workspaceId);
      if (current) continue;
      if (this.assignedProxyIds(workspaceId).has(proxyId)) continue;
      this.setAssignment(workspaceId, proxyId);
      this.markUsed(proxyId);
      this.validationProgress.assigned = this.assignments.filter((assignment) => assignment.proxyId && this.validatedStore.has(assignment.proxyId)).length;
      this.emitValidationProgress();
      this.emit('assignment-live', { workspaceId, proxyId } satisfies ProxyAssignment);
      return { workspaceId, proxyId };
    }
    return undefined;
  }

  async buildAssignments(preferredIds: string[] = []): Promise<ProxyAssignment[]> {
    const settings = this.settings.get();
    const preferred = new Set(preferredIds);
    const basePool = this.eligiblePool();
    const ordered = preferred.size
      ? [...basePool.filter((proxy) => preferred.has(proxy.id)), ...basePool.filter((proxy) => !preferred.has(proxy.id))]
      : basePool;

    // Browser assignment never performs validation. It only consumes the
    // already-populated validated store.
    this.assignments = Array.from({ length: settings.browserCount }, (_, index) => ({
      workspaceId: index + 1,
      proxyId: ordered[index]?.id
    }));
    this.resetProxyCycle();
    for (const assignment of this.assignments) this.markUsed(assignment.proxyId);
    return this.getAssignments();
  }

  setAssignment(workspaceId: number, proxyId?: string): void {
    if (proxyId) {
      const owner = this.assignments.find((item) => item.workspaceId !== workspaceId && item.proxyId === proxyId);
      if (owner) throw new Error(`Proxy is already leased to Browser ${owner.workspaceId}.`);
    }
    const existing = this.assignments.find((item) => item.workspaceId === workspaceId);
    if (existing) existing.proxyId = proxyId;
    else this.assignments.push({ workspaceId, proxyId });
    this.markUsed(proxyId);
  }

  markAssignedProxyDead(workspaceId: number, reason: string): void {
    const proxyId = this.assignments.find((item) => item.workspaceId === workspaceId)?.proxyId;
    if (!proxyId) return;
    this.validatedStore.delete(proxyId);
    const index = this.proxies.findIndex((proxy) => proxy.id === proxyId);
    if (index < 0) return;

    this.proxies[index] = {
      ...this.proxies[index]!,
      status: 'dead',
      latencyMs: undefined,
      lastCheckedAt: new Date().toISOString(),
      lastError: reason
    };
    const assignment = this.assignments.find((item) => item.workspaceId === workspaceId);
    if (assignment) assignment.proxyId = undefined;
    this.validationProgress.working = this.validatedStore.size;
    this.emitChanged();
    this.emitValidationProgress();
  }

  replaceTimedOutProxyWithUnusedLive(workspaceId: number, reason: string): ProxyRecord | undefined {
    const currentId = this.assignments.find((item) => item.workspaceId === workspaceId)?.proxyId;
    const leasedElsewhere = this.assignedProxyIds(workspaceId);
    const candidate = this.eligiblePool().find((proxy) =>
      proxy.id !== currentId
      && !leasedElsewhere.has(proxy.id)
      && !this.usedThisCycle.has(proxy.id)
    );

    if (!candidate) return undefined;

    this.markAssignedProxyDead(workspaceId, reason);
    this.setAssignment(workspaceId, candidate.id);
    return { ...candidate };
  }

  chooseReplacement(workspaceId: number): ProxyRecord | undefined {
    const currentId = this.assignments.find((item) => item.workspaceId === workspaceId)?.proxyId;
    const leasedElsewhere = this.assignedProxyIds(workspaceId);
    const candidate = this.eligiblePool().find((proxy) =>
      proxy.id !== currentId
      && !leasedElsewhere.has(proxy.id)
      && !this.usedThisCycle.has(proxy.id)
    );
    if (candidate) this.setAssignment(workspaceId, candidate.id);
    return candidate ? { ...candidate } : undefined;
  }

  async ensureWorkingProxy(workspaceId: number): Promise<ProxyRecord | undefined> {
    const current = this.getAssignedProxy(workspaceId);
    if (current?.status === 'working' && this.validatedStore.has(current.id)) return current;
    if (current) this.setAssignment(workspaceId, undefined);

    let replacement = this.chooseReplacement(workspaceId);
    if (replacement) return replacement;

    try {
      await this.refreshCurrentPool();
    } catch {
      return undefined;
    }
    replacement = this.chooseReplacement(workspaceId);
    return replacement;
  }

  syncBrowserCount(count: number): void {
    const target = Math.min(100, Math.max(1, Math.floor(Number(count) || 10)));
    this.assignments = this.assignments.filter((assignment) => assignment.workspaceId <= target);
  }

  clear(): void {
    this.stopContinuousValidation();
    this.cancelValidation();
    this.proxies = [];
    this.assignments = [];
    this.validatedStore.clear();
    this.lastImportedIds = [];
    this.resetProxyCycle();
    this.validationProgress = this.emptyProgress();
    this.lastProviderRefreshAt = 0;
    this.emitChanged();
    this.emitValidationProgress();
  }
}


