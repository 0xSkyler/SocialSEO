import { EventEmitter } from 'node:events';
import { describe, expect, it, vi } from 'vitest';
import { SeoAutomationManager } from '../src/main/SeoAutomationManager';
import type { ProxyRecord, ReloadProxiesSummary } from '../src/shared/types/proxy';
import type { BroadcastSearchResult } from '../src/shared/types/browser';
import type { BrowserManager } from '../src/main/BrowserManager';
import type { ProxyManager } from '../src/main/ProxyManager';

function makeProxy(id: string): ProxyRecord {
  return {
    id,
    host: `${id}.example.test`,
    port: 8080,
    protocol: 'http',
    countryVerified: false,
    sources: ['test'],
    status: 'working',
    score: 100,
    successCount: 1,
    failureCount: 0,
    googleStatus: 'unknown'
  };
}

function makeBrowserHarness(
  resultFactory: (id: number, query: string, target: string, maxPages: number) => BroadcastSearchResult
): {
  browserManager: BrowserManager;
  searches: string[];
  assigned: Array<string | null>;
  verify: ReturnType<typeof vi.fn>;
} {
  const emitter = new EventEmitter();
  const tokens = new Map<number, number>();
  const searches: string[] = [];
  const assigned: Array<string | null> = [];
  let currentProxy: ProxyRecord | null = null;

  const verify = vi.fn(async () => ({ ok: true, detectedIp: '203.0.113.10' }));

  const browserManager = Object.assign(emitter, {
    async assignProxy(_id: number, proxy: ProxyRecord | null) {
      currentProxy = proxy;
      assigned.push(proxy?.id ?? null);
    },
    async verifyAssignedProxy(id: number) {
      return verify(id, currentProxy);
    },
    setBrowserKeepAlive() {},
    cancelMeasurementSession(id: number) {
      tokens.set(id, (tokens.get(id) ?? 0) + 1);
    },
    startMeasurementSession(id: number) {
      const token = (tokens.get(id) ?? 0) + 1;
      tokens.set(id, token);
      return token;
    },
    isMeasurementSessionCurrent(id: number, token: number) {
      return tokens.get(id) === token;
    },
    async broadcastSearch(
      id: number,
      query: string,
      target: string,
      maxPages: number
    ): Promise<BroadcastSearchResult> {
      searches.push(query);
      return resultFactory(id, query, target, maxPages);
    },
    async waitForGoogleRecovery() {
      return true;
    }
  }) as unknown as BrowserManager;

  return { browserManager, searches, assigned, verify };
}

function waitForResult(
  manager: SeoAutomationManager,
  cycleNumber: number,
  predicate: (result: BroadcastSearchResult) => boolean = () => true
): Promise<BroadcastSearchResult> {
  return new Promise((resolve) => {
    const listener = (payload: { cycleNumber: number; result: BroadcastSearchResult }) => {
      if (payload.cycleNumber !== cycleNumber || !predicate(payload.result)) return;
      manager.off('seoResult', listener);
      resolve(payload.result);
    };
    manager.on('seoResult', listener);
  });
}

async function waitForCycleIdle(manager: SeoAutomationManager, cycleNumber: number): Promise<void> {
  const deadline = Date.now() + 1000;
  while (Date.now() < deadline) {
    const state = manager.getState();
    if (state.cycleNumber >= cycleNumber && !state.cycleInProgress) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error(`Cycle ${cycleNumber} did not become idle.`);
}

describe('SeoAutomationManager v0.6', () => {
  it('uses the selected provider and rotates comma-separated keywords by cycle', async () => {
    const proxy = makeProxy('p1');
    const providers: string[] = [];

    const proxyManager = {
      cancelCurrentValidation() {},
      resetRotationHistory() {},
      getWorkingCount: () => 1,
      getAssignedCount: () => 1,
      async fetchValidateAssignStreaming(
        provider: string,
        browserIds: number[],
        onAssignment: (assignment: { browserId: number; proxy: ProxyRecord }) => void,
        onProgress?: (checked: number, total: number, working: number, assigned: number, fetched: number) => void
      ): Promise<ReloadProxiesSummary> {
        providers.push(provider);
        onProgress?.(0, 1, 0, 0, 1);
        onAssignment({ browserId: browserIds[0], proxy });
        onProgress?.(1, 1, 1, 1, 1);
        return {
          found: 1,
          countryMatched: 1,
          working: 1,
          assignments: [{ browserId: browserIds[0], proxy }]
        };
      },
      leaseNextWorking: () => proxy,
      rejectAssignment() {}
    } as unknown as ProxyManager;

    const harness = makeBrowserHarness((id, query) => ({
      browserId: id,
      status: 'no-match',
      landedUrl: `https://www.google.com/search?q=${encodeURIComponent(query)}`,
      resultsScanned: 10,
      monitoring: true,
      ranAt: new Date().toISOString()
    }));

    const manager = new SeoAutomationManager(proxyManager, harness.browserManager, async () => [1]);

    const first = waitForResult(manager, 1);
    await manager.start({
      query: 'A, B, C',
      targetWebsite: 'example.com',
      proxySource: 'proxifly',
      intervalSec: 600,
      browserCount: 1,
      maxPages: 20
    });
    await first;
    await waitForCycleIdle(manager, 1);

    expect(providers[0]).toBe('proxifly');
    expect(harness.searches[0]).toBe('A');
    expect(manager.getState().currentQuery).toBe('A');

    const second = waitForResult(manager, 2);
    await manager.runNow();
    await second;
    await waitForCycleIdle(manager, 2);

    expect(harness.searches[1]).toBe('B');
    expect(manager.getState().currentQuery).toBe('B');

    const third = waitForResult(manager, 3);
    await manager.runNow();
    await third;
    await waitForCycleIdle(manager, 3);
    expect(harness.searches[2]).toBe('C');

    const fourth = waitForResult(manager, 4);
    await manager.runNow();
    await fourth;
    expect(harness.searches[3]).toBe('A');

    manager.stop();
  });

  it('quarantines a browser-level failed proxy and retries another unassigned live proxy', async () => {
    const firstProxy = makeProxy('bad');
    const replacement = makeProxy('good');
    const rejected: string[] = [];

    let leaseCount = 0;
    const proxyManager = {
      cancelCurrentValidation() {},
      resetRotationHistory() {},
      getWorkingCount: () => 1,
      getAssignedCount: () => 1,
      async fetchValidateAssignStreaming(
        _provider: string,
        browserIds: number[],
        onAssignment: (assignment: { browserId: number; proxy: ProxyRecord }) => void
      ): Promise<ReloadProxiesSummary> {
        onAssignment({ browserId: browserIds[0], proxy: firstProxy });
        return {
          found: 2,
          countryMatched: 2,
          working: 2,
          assignments: [{ browserId: browserIds[0], proxy: firstProxy }]
        };
      },
      rejectAssignment(_browserId: number, proxyId: string) {
        rejected.push(proxyId);
      },
      leaseNextWorking() {
        leaseCount += 1;
        return leaseCount === 1 ? replacement : null;
      }
    } as unknown as ProxyManager;

    const harness = makeBrowserHarness((id) => ({
      browserId: id,
      status: 'no-match',
      landedUrl: 'https://www.google.com/search?q=test',
      monitoring: true,
      ranAt: new Date().toISOString()
    }));

    harness.verify.mockImplementation(async (_id: number, proxy: ProxyRecord | null) => {
      if (proxy?.id === 'bad') return { ok: false, error: 'session connection failed' };
      return { ok: true, detectedIp: '203.0.113.11' };
    });

    const manager = new SeoAutomationManager(proxyManager, harness.browserManager, async () => [1]);
    const result = waitForResult(manager, 1, (observed) => observed.status === 'no-match');

    await manager.start({
      query: 'test',
      targetWebsite: 'example.com',
      proxySource: 'hproxy',
      intervalSec: 600,
      browserCount: 1,
      maxPages: 10
    });

    await result;

    expect(rejected).toContain('bad');
    expect(harness.assigned).toContain('bad');
    expect(harness.assigned).toContain(null);
    expect(harness.assigned).toContain('good');
    expect(harness.searches).toEqual(['test']);

    manager.stop();
  });

  it('records a matched result without invoking click or Keep Alive interaction', async () => {
    const proxy = makeProxy('read-only');
    const proxyManager = {
      cancelCurrentValidation() {},
      resetRotationHistory() {},
      getWorkingCount: () => 1,
      getAssignedCount: () => 1,
      async fetchValidateAssignStreaming(
        _provider: string,
        browserIds: number[],
        onAssignment: (assignment: { browserId: number; proxy: ProxyRecord }) => void
      ): Promise<ReloadProxiesSummary> {
        onAssignment({ browserId: browserIds[0], proxy });
        return {
          found: 1,
          countryMatched: 1,
          working: 1,
          assignments: [{ browserId: browserIds[0], proxy }]
        };
      },
      leaseNextWorking: () => null,
      rejectAssignment() {}
    } as unknown as ProxyManager;

    const harness = makeBrowserHarness((id) => ({
      browserId: id,
      status: 'matched',
      landedUrl: 'https://www.google.com/search?q=rmg+cutting',
      matchedUrl: 'https://example.com/article/rmg-cutting',
      matchedTitle: 'RMG Cutting Process',
      position: 3,
      resultPage: 1,
      interactionStatus: 'detected',
      monitoring: true,
      ranAt: new Date().toISOString()
    }));

    const unsafeClick = vi.fn(() => {
      throw new Error('click should not be called');
    });
    const unsafeKeepAlive = vi.fn(() => {
      throw new Error('keep alive should not be called');
    });
    Object.assign(harness.browserManager as unknown as object, {
      clickControlledGoogleResult: unsafeClick,
      startControlledKeepAlive: unsafeKeepAlive
    });

    const manager = new SeoAutomationManager(proxyManager, harness.browserManager, async () => [1]);
    const observed = waitForResult(manager, 1);

    await manager.start({
      query: 'rmg cutting',
      targetWebsite: 'example.com',
      proxySource: 'proxmint',
      intervalSec: 600,
      browserCount: 1,
      maxPages: 20
    });

    const result = await observed;
    expect(result.status).toBe('matched');
    expect(result.position).toBe(3);
    expect(result.interactionStatus).toBe('detected');
    expect(unsafeClick).not.toHaveBeenCalled();
    expect(unsafeKeepAlive).not.toHaveBeenCalled();

    manager.stop();
  });

  it('rejects an interaction-host override that differs from the target host', async () => {
    const emitter = new EventEmitter();
    const manager = new SeoAutomationManager(
      { cancelCurrentValidation() {}, resetRotationHistory() {} } as unknown as ProxyManager,
      emitter as unknown as BrowserManager,
      async () => [1]
    );

    await expect(
      manager.start({
        query: 'rmg cutting',
        targetWebsite: 'example.com',
        controlledTestHost: 'other.example.com',
        intervalSec: 600,
        browserCount: 1,
        maxPages: 20
      })
    ).rejects.toThrow(/exactly match/i);
  });
});
