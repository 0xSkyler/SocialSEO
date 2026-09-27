import { EventEmitter } from 'node:events';
import type { ProxyAssignment, ProxyRecord } from '../shared/types/proxy';
import type {
  SeoAutomationConfig,
  SeoAutomationResult,
  SeoAutomationState
} from '../shared/types/automation';
import {
  normalizeAutomationIntervalSeconds,
  normalizeBrowserCount,
  normalizeProxyProvider,
  normalizeSeoMaxPages,
  parseSeoKeywords
} from '../shared/types/automation';
import { normalizeTargetHost } from '../shared/seo';
import type { BrowserManager } from './BrowserManager';
import type { ProxyManager } from './ProxyManager';
import { logger } from './Logger';

// eslint-disable-next-line @typescript-eslint/no-unsafe-declaration-merging
export declare interface SeoAutomationManager {
  on(event: 'stateChanged', listener: (state: SeoAutomationState) => void): this;
  emit(event: 'stateChanged', state: SeoAutomationState): boolean;
  on(event: 'seoResult', listener: (payload: SeoAutomationResult) => void): this;
  emit(event: 'seoResult', payload: SeoAutomationResult): boolean;
}

/**
 * Fail-closed SEO automation:
 *
 * selected provider -> local validation -> exclusive proxy lease -> exact
 * Electron-session IP verification -> Google workflow -> Keep Alive.
 *
 * A browser is parked behind an unreachable local proxy whenever it has no
 * verified lease. Browser-level proxy failures quarantine that endpoint and
 * automatically lease another currently-unassigned live proxy.
 */
// eslint-disable-next-line @typescript-eslint/no-unsafe-declaration-merging
export class SeoAutomationManager extends EventEmitter {
  private timer: NodeJS.Timeout | null = null;
  private generation = 0;
  private pendingCycle = false;
  private recoveringBrowsers = new Set<number>();

  private state: SeoAutomationState = {
    running: false,
    cycleInProgress: false,
    proxySource: 'proxyscrape',
    query: '',
    keywords: [],
    currentQuery: '',
    targetWebsite: '',
    intervalSec: 600,
    browserCount: 10,
    maxPages: 20,
    browserIds: [],
    cycleNumber: 0,
    fetchedProxies: 0,
    checkedProxies: 0,
    totalProxies: 0,
    liveProxies: 0,
    assignedBrowsers: 0
  };

  constructor(
    private readonly proxyManager: ProxyManager,
    private readonly browserManager: BrowserManager,
    private readonly ensureBrowserCount: (count: number) => Promise<number[]>
  ) {
    super();

    this.browserManager.on('proxyFailed', (browserId, error) => {
      if (!this.state.running || !this.state.browserIds.includes(browserId)) return;
      this.queueBrowserConnection(
        this.generation,
        this.state.cycleNumber,
        browserId,
        null,
        this.state.currentQuery,
        this.state.targetWebsite,
        this.state.controlledTestHost,
        this.state.maxPages,
        error
      );
    });
  }

  getState(): SeoAutomationState {
    return {
      ...this.state,
      keywords: [...this.state.keywords],
      browserIds: [...this.state.browserIds]
    };
  }

  isRunning(): boolean {
    return this.state.running;
  }

  async start(config: SeoAutomationConfig): Promise<SeoAutomationState> {
    const query = config.query.trim();
    const keywords = parseSeoKeywords(query);
    const targetWebsite = config.targetWebsite.trim();
    const targetHost = normalizeTargetHost(targetWebsite);
    const requestedInteractionHost = normalizeTargetHost(config.controlledTestHost ?? '');
    if (keywords.length === 0) throw new Error('Enter at least one Google search keyword.');
    if (!targetHost) throw new Error('Enter a valid target website or site name.');

    const controlledTestHost = requestedInteractionHost || targetHost;
    if (controlledTestHost !== targetHost) {
      throw new Error('Interaction host must exactly match the Target website host.');
    }

    const browserCount = normalizeBrowserCount(config.browserCount);
    const maxPages = normalizeSeoMaxPages(config.maxPages);
    const intervalSec = normalizeAutomationIntervalSeconds(config.intervalSec);
    const proxySource = normalizeProxyProvider(config.proxySource);

    this.stopTimerOnly();
    this.proxyManager.cancelCurrentValidation();
    this.proxyManager.resetRotationHistory();
    this.generation += 1;
    this.pendingCycle = false;
    this.recoveringBrowsers.clear();

    this.state = {
      running: true,
      cycleInProgress: true,
      proxySource,
      query,
      keywords,
      currentQuery: keywords[0],
      targetWebsite,
      controlledTestHost: controlledTestHost || undefined,
      intervalSec,
      browserCount,
      maxPages,
      browserIds: [],
      cycleNumber: 0,
      fetchedProxies: 0,
      checkedProxies: 0,
      totalProxies: 0,
      liveProxies: 0,
      assignedBrowsers: 0,
      nextCycleAt: undefined,
      lastError: undefined
    };
    this.emitState();

    let browserIds: number[];
    try {
      browserIds = await this.ensureBrowserCount(browserCount);
      for (const id of browserIds) {
        await this.browserManager.assignProxy(id, null);
      }
    } catch (err) {
      this.state = {
        ...this.state,
        running: false,
        cycleInProgress: false,
        nextCycleAt: undefined,
        lastError: `Browser preparation failed: ${(err as Error).message}`
      };
      this.emitState();
      throw err;
    }

    if (browserIds.length === 0) {
      this.state = {
        ...this.state,
        running: false,
        cycleInProgress: false,
        nextCycleAt: undefined,
        lastError: 'No browser workspaces are available.'
      };
      this.emitState();
      throw new Error('No browser workspaces are available.');
    }

    this.state = {
      ...this.state,
      cycleInProgress: false,
      browserIds
    };
    this.emitState();

    void this.requestCycle();
    return this.getState();
  }

  stop(): SeoAutomationState {
    this.generation += 1;
    this.pendingCycle = false;
    this.proxyManager.cancelCurrentValidation();
    this.stopTimerOnly();
    this.recoveringBrowsers.clear();

    for (const id of this.state.browserIds) {
      try {
        this.browserManager.cancelMeasurementSession(id);
        this.browserManager.setBrowserKeepAlive(id, false, false);
      } catch {
        // Browser may already have been removed.
      }
    }

    this.state = {
      ...this.state,
      running: false,
      cycleInProgress: false,
      nextCycleAt: undefined
    };
    this.emitState();
    return this.getState();
  }

  async runNow(): Promise<SeoAutomationState> {
    if (!this.state.running) throw new Error('Start SEO Tracker first.');
    this.stopTimerOnly();
    if (this.state.cycleInProgress) {
      this.pendingCycle = true;
      this.proxyManager.cancelCurrentValidation();
    } else {
      await this.requestCycle();
    }
    return this.getState();
  }

  private stopTimerOnly(): void {
    if (!this.timer) return;
    clearTimeout(this.timer);
    this.timer = null;
  }

  private scheduleNextCycle(): void {
    this.stopTimerOnly();
    if (!this.state.running) return;
    const delayMs = this.state.intervalSec * 1000;
    this.state = {
      ...this.state,
      nextCycleAt: new Date(Date.now() + delayMs).toISOString()
    };
    this.emitState();
    this.timer = setTimeout(() => {
      this.timer = null;
      void this.requestCycle();
    }, delayMs);
  }

  private emitState(): void {
    this.emit('stateChanged', this.getState());
  }

  private async requestCycle(): Promise<void> {
    if (!this.state.running) return;
    if (this.state.cycleInProgress) {
      this.pendingCycle = true;
      return;
    }
    await this.runCycle();
  }

  private async runCycle(): Promise<void> {
    if (!this.state.running) return;

    const generation = this.generation;
    const cycleNumber = this.state.cycleNumber + 1;
    const browserIds = [...this.state.browserIds];
    const keyword = this.state.keywords[(cycleNumber - 1) % this.state.keywords.length];
    const {
      targetWebsite,
      controlledTestHost,
      maxPages,
      proxySource
    } = this.state;

    this.stopTimerOnly();
    this.state = {
      ...this.state,
      cycleInProgress: true,
      cycleNumber,
      currentQuery: keyword,
      fetchedProxies: 0,
      checkedProxies: 0,
      totalProxies: 0,
      liveProxies: 0,
      assignedBrowsers: 0,
      lastCycleStartedAt: new Date().toISOString(),
      nextCycleAt: undefined,
      lastError: undefined
    };
    this.emitState();

    try {
      for (const id of browserIds) {
        if (!this.isCurrent(generation)) return;
        this.browserManager.cancelMeasurementSession(id);
        this.browserManager.setBrowserKeepAlive(id, false, false);
        await this.browserManager.assignProxy(id, null);
      }

      await this.proxyManager.fetchValidateAssignStreaming(
        proxySource,
        browserIds,
        (assignment) => {
          if (!this.isCurrentCycle(generation, cycleNumber)) return;
          this.handleAssignment(
            generation,
            cycleNumber,
            assignment,
            keyword,
            targetWebsite,
            controlledTestHost,
            maxPages
          );
        },
        (checked, total, working, assigned, fetched) => {
          if (!this.isCurrentCycle(generation, cycleNumber)) return;
          this.state = {
            ...this.state,
            fetchedProxies: fetched,
            checkedProxies: checked,
            totalProxies: total,
            liveProxies: working,
            assignedBrowsers: assigned
          };
          this.emitState();
        }
      );

      if (!this.isCurrentCycle(generation, cycleNumber)) return;
      this.refreshPoolCounters();
      this.state = {
        ...this.state,
        cycleInProgress: false,
        lastCycleCompletedAt: new Date().toISOString()
      };
      this.emitState();

      logger.info(
        'application',
        `SEO cycle ${cycleNumber} (${keyword}) complete: ${this.state.liveProxies} live, ` +
          `${this.state.assignedBrowsers}/${browserIds.length} browser(s) leased.`
      );
    } catch (err) {
      if (!this.isCurrentCycle(generation, cycleNumber)) return;
      this.state = {
        ...this.state,
        cycleInProgress: false,
        lastCycleCompletedAt: new Date().toISOString(),
        lastError: (err as Error).message
      };
      this.emitState();
      logger.warn('application', `SEO cycle ${cycleNumber} failed: ${(err as Error).message}`);
    } finally {
      if (!this.isCurrent(generation)) return;
      if (this.pendingCycle) {
        this.pendingCycle = false;
        void this.requestCycle();
      } else {
        this.scheduleNextCycle();
      }
    }
  }

  private handleAssignment(
    generation: number,
    cycleNumber: number,
    assignment: ProxyAssignment,
    query: string,
    targetWebsite: string,
    controlledTestHost: string | undefined,
    maxPages: number
  ): void {
    if (!assignment.proxy || !this.isCurrentCycle(generation, cycleNumber)) return;
    this.queueBrowserConnection(
      generation,
      cycleNumber,
      assignment.browserId,
      assignment.proxy,
      query,
      targetWebsite,
      controlledTestHost,
      maxPages
    );
  }

  private queueBrowserConnection(
    generation: number,
    cycleNumber: number,
    browserId: number,
    initialProxy: ProxyRecord | null,
    query: string,
    targetWebsite: string,
    controlledTestHost: string | undefined,
    maxPages: number,
    failureReason?: string
  ): void {
    if (!this.isCurrentCycle(generation, cycleNumber)) return;
    if (this.recoveringBrowsers.has(browserId)) return;
    this.recoveringBrowsers.add(browserId);

    void (async () => {
      if (failureReason) {
        this.browserManager.cancelMeasurementSession(browserId);
        this.browserManager.setBrowserKeepAlive(browserId, false, false);
        const current = this.proxyManager.getAssignment(browserId);
        if (current) {
          this.proxyManager.rejectAssignment(browserId, current.id, failureReason);
        }
        await this.browserManager.assignProxy(browserId, null);
        this.refreshPoolCounters();
      }

      await this.connectBrowserLoop(
        generation,
        cycleNumber,
        browserId,
        initialProxy && !failureReason ? initialProxy : null,
        query,
        targetWebsite,
        controlledTestHost,
        maxPages
      );
    })()
      .catch((err) => {
        logger.warn(
          'application',
          `Browser ${browserId} proxy recovery loop failed: ${(err as Error).message}`
        );
      })
      .finally(() => {
        this.recoveringBrowsers.delete(browserId);
      });
  }

  private async connectBrowserLoop(
    generation: number,
    cycleNumber: number,
    browserId: number,
    initialProxy: ProxyRecord | null,
    query: string,
    targetWebsite: string,
    controlledTestHost: string | undefined,
    maxPages: number
  ): Promise<void> {
    let candidate = initialProxy;
    const failedIds = new Set<string>();

    while (this.isCurrentCycle(generation, cycleNumber)) {
      if (!candidate) {
        candidate = this.proxyManager.leaseNextWorking(browserId, failedIds);
        if (!candidate) {
          await sleep(600);
          continue;
        }
      }

      try {
        await this.browserManager.assignProxy(browserId, candidate);
        if (!this.isCurrentCycle(generation, cycleNumber)) return;

        const verification = await this.browserManager.verifyAssignedProxy(browserId, 9000);
        if (!verification.ok) {
          throw new Error(verification.error || 'Browser session could not use the proxy.');
        }

        if (!this.isCurrentCycle(generation, cycleNumber)) return;
        this.refreshPoolCounters();
        this.browserManager.setBrowserKeepAlive(browserId, false, false);
        const measurementToken = this.browserManager.startMeasurementSession(browserId);

        void this.monitorBrowserSession(
          generation,
          cycleNumber,
          browserId,
          measurementToken,
          query,
          targetWebsite,
          controlledTestHost,
          maxPages
        );
        return;
      } catch (err) {
        const reason = (err as Error).message;
        failedIds.add(candidate.id);
        this.proxyManager.rejectAssignment(browserId, candidate.id, reason);
        this.browserManager.cancelMeasurementSession(browserId);
        this.browserManager.setBrowserKeepAlive(browserId, false, false);
        await this.browserManager.assignProxy(browserId, null);
        this.refreshPoolCounters();

        this.emit('seoResult', {
          cycleNumber,
          result: {
            browserId,
            status: 'error',
            error: `Proxy failed (${candidate.host}:${candidate.port}); trying another unassigned live proxy. ${reason}`,
            monitoring: true,
            ranAt: new Date().toISOString()
          }
        });

        candidate = null;
        await sleep(250);
      }
    }
  }

  private refreshPoolCounters(): void {
    this.state = {
      ...this.state,
      liveProxies: this.proxyManager.getWorkingCount(),
      assignedBrowsers: this.proxyManager.getAssignedCount()
    };
    this.emitState();
  }

  private async monitorBrowserSession(
    generation: number,
    cycleNumber: number,
    browserId: number,
    measurementToken: number,
    query: string,
    targetWebsite: string,
    controlledTestHost: string | undefined,
    maxPages: number
  ): Promise<void> {
    const observationIntervalMs = 30_000;
    const interactionHost = controlledTestHost || normalizeTargetHost(targetWebsite);
    if (!interactionHost) return;

    while (
      this.isCurrentCycle(generation, cycleNumber) &&
      this.browserManager.isMeasurementSessionCurrent(browserId, measurementToken)
    ) {
      let result;
      try {
        result = await this.browserManager.broadcastSearch(
          browserId,
          query,
          targetWebsite,
          maxPages,
          measurementToken
        );
      } catch (err) {
        if (
          !this.isCurrentCycle(generation, cycleNumber) ||
          !this.browserManager.isMeasurementSessionCurrent(browserId, measurementToken)
        ) {
          return;
        }

        this.emit('seoResult', {
          cycleNumber,
          result: {
            browserId,
            status: 'error',
            error: (err as Error).message,
            monitoring: true,
            ranAt: new Date().toISOString()
          }
        });
        await sleep(5_000);
        continue;
      }

      if (
        !this.isCurrentCycle(generation, cycleNumber) ||
        !this.browserManager.isMeasurementSessionCurrent(browserId, measurementToken)
      ) {
        return;
      }

      if (
        result.status === 'matched' &&
        result.interactionStatus === 'opened' &&
        result.matchedUrl
      ) {
        this.browserManager.startControlledKeepAlive(browserId, interactionHost);
        this.emit('seoResult', {
          cycleNumber,
          result: {
            ...result,
            keepAliveStarted: true
          }
        });
        return;
      }

      if (
        result.status === 'matched' &&
        result.interactionStatus === 'click-failed'
      ) {
        this.emit('seoResult', { cycleNumber, result });
        await sleep(3_000);
        continue;
      }

      if (result.status === 'matched' && result.matchedUrl) {
        let matchedHost = '';
        try {
          matchedHost = new URL(result.matchedUrl).hostname
            .toLowerCase()
            .replace(/^www\./, '')
            .replace(/\.$/, '');
        } catch {
          matchedHost = '';
        }

        if (matchedHost !== interactionHost) {
          this.emit('seoResult', {
            cycleNumber,
            result: {
              ...result,
              interactionStatus: 'click-failed',
              error: `Matched result host ${matchedHost || 'unknown'} does not equal configured interaction host ${interactionHost}.`
            }
          });
          await sleep(3_000);
          continue;
        }

        this.emit('seoResult', {
          cycleNumber,
          result: {
            ...result,
            interactionStatus: 'opening'
          }
        });

        const clicked = await this.browserManager.clickControlledGoogleResult(
          browserId,
          query,
          interactionHost,
          result.matchedUrl,
          measurementToken
        );

        if (clicked) {
          this.browserManager.startControlledKeepAlive(browserId, interactionHost);
          this.emit('seoResult', {
            cycleNumber,
            result: {
              ...result,
              landedUrl: result.matchedUrl,
              interactionStatus: 'opened',
              keepAliveStarted: true
            }
          });
          return;
        }

        this.emit('seoResult', {
          cycleNumber,
          result: {
            ...result,
            interactionStatus: 'click-failed',
            error: 'Target was detected, but the result could not be opened. ProxyDesk will retry in this session.'
          }
        });
        await sleep(3_000);
        continue;
      }

      this.emit('seoResult', { cycleNumber, result });

      if (result.status === 'paused') {
        const recovered = await this.browserManager.waitForGoogleRecovery(
          browserId,
          observationIntervalMs
        );
        if (!recovered) await sleep(1_000);
        continue;
      }

      await sleep(observationIntervalMs);
    }
  }

  private isCurrent(generation: number): boolean {
    return this.state.running && generation === this.generation;
  }

  private isCurrentCycle(generation: number, cycleNumber: number): boolean {
    return this.isCurrent(generation) && this.state.cycleNumber === cycleNumber;
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
