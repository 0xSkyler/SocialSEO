import { describe, expect, it, vi } from 'vitest';
import { SeoAutomationManager } from '../src/main/SeoAutomationManager';
import type { BroadcastSearchResult } from '../src/shared/types/browser';
import type { ProxyRecord } from '../src/shared/types/proxy';
import type { BrowserManager } from '../src/main/BrowserManager';
import type { ProxyManager } from '../src/main/ProxyManager';

function proxy(id: string): ProxyRecord {
  return {
    id,
    host: `${id}.example.test`,
    port: 8080,
    protocol: 'http',
    countryVerified: false,
    sources: ['ProxyScrape Free API'],
    status: 'working',
    score: 100,
    successCount: 1,
    failureCount: 0,
    googleStatus: 'unknown'
  };
}

function browserHarness(searches: string[], assignments: string[]): BrowserManager {
  const tokens = new Map<number, number>();

  return {
    async assignProxy(id: number, assignedProxy: ProxyRecord | null) {
      assignments.push(`${id}:${assignedProxy?.id ?? 'none'}`);
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
      target: string
    ): Promise<BroadcastSearchResult> {
      searches.push(`${id}:${query}`);
      return {
        browserId: id,
        status: 'matched',
        landedUrl: `https://${target}/article`,
        matchedUrl: `https://${target}/article`,
        matchedTitle: query,
        interactionStatus: 'opened',
        monitoring: true,
        ranAt: new Date().toISOString()
      };
    },
    async clickControlledGoogleResult() {
      return true;
    },
    startControlledKeepAlive() {},
    async waitForGoogleRecovery() {
      return true;
    }
  } as unknown as BrowserManager;
}

async function waitFor(predicate: () => boolean, timeoutMs = 1500): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error('Timed out waiting for condition.');
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

describe('v0.5.4 proxy-store cycle enhancements', () => {
  it('does not start browser work until a validated stored proxy is available', async () => {
    const searches: string[] = [];
    const assignments: string[] = [];
    const live = proxy('stored');
    let takeCalls = 0;

    const startStore = vi.fn();
    const cycleValidation = vi.fn(() => {
      throw new Error('cycle-start validation must not run');
    });

    const proxyManager = {
      cancelCurrentValidation() {},
      stopValidatedProxyStore() {},
      resetRotationHistory() {},
      startValidatedProxyStore: startStore,
      getValidatedStoreSize: () => (takeCalls >= 3 ? 1 : 0),
      takeValidatedProxy() {
        takeCalls += 1;
        return takeCalls >= 3 ? live : null;
      },
      resetValidatedStoreForNextCohort() {},
      fetchValidateAssignStreaming: cycleValidation
    } as unknown as ProxyManager;

    const manager = new SeoAutomationManager(
      proxyManager,
      browserHarness(searches, assignments),
      async () => [1]
    );

    await manager.start({
      query: 'A, B',
      targetWebsite: 'example.com',
      intervalSec: 600,
      browserCount: 1,
      maxPages: 20
    });

    expect(startStore).toHaveBeenCalledWith(1);
    expect(searches).toEqual([]);

    await waitFor(() => searches.length === 1);

    expect(assignments).toEqual(['1:stored']);
    expect(searches).toEqual(['1:A']);
    expect(cycleValidation).not.toHaveBeenCalled();

    manager.stop();
  });

  it('uses the same keyword for every browser in a cycle and wraps A B C back to A', async () => {
    const searches: string[] = [];
    const assignments: string[] = [];
    let serial = 0;

    const proxyManager = {
      cancelCurrentValidation() {},
      stopValidatedProxyStore() {},
      resetRotationHistory() {},
      startValidatedProxyStore() {},
      getValidatedStoreSize: () => 10,
      takeValidatedProxy(browserId: number) {
        serial += 1;
        return proxy(`p-${browserId}-${serial}`);
      },
      resetValidatedStoreForNextCohort() {}
    } as unknown as ProxyManager;

    const manager = new SeoAutomationManager(
      proxyManager,
      browserHarness(searches, assignments),
      async () => [1, 2]
    );

    await manager.start({
      query: 'A, B, C',
      targetWebsite: 'example.com',
      intervalSec: 600,
      browserCount: 2,
      maxPages: 20
    });

    await waitFor(() => searches.length >= 2);
    expect(searches.slice(0, 2)).toEqual(['1:A', '2:A']);

    await manager.runNow();
    await waitFor(() => searches.length >= 4);
    expect(searches.slice(2, 4)).toEqual(['1:B', '2:B']);

    await manager.runNow();
    await waitFor(() => searches.length >= 6);
    expect(searches.slice(4, 6)).toEqual(['1:C', '2:C']);

    await manager.runNow();
    await waitFor(() => searches.length >= 8);
    expect(searches.slice(6, 8)).toEqual(['1:A', '2:A']);

    manager.stop();
  });

  it('clears the stored pool after every five completed cycle assignments', async () => {
    const searches: string[] = [];
    const assignments: string[] = [];
    let serial = 0;
    const resetStore = vi.fn();

    const proxyManager = {
      cancelCurrentValidation() {},
      stopValidatedProxyStore() {},
      resetRotationHistory() {},
      startValidatedProxyStore() {},
      getValidatedStoreSize: () => 20,
      takeValidatedProxy(browserId: number) {
        serial += 1;
        return proxy(`cycle-${serial}-browser-${browserId}`);
      },
      resetValidatedStoreForNextCohort: resetStore
    } as unknown as ProxyManager;

    const manager = new SeoAutomationManager(
      proxyManager,
      browserHarness(searches, assignments),
      async () => [1]
    );

    await manager.start({
      query: 'A',
      targetWebsite: 'example.com',
      intervalSec: 600,
      browserCount: 1,
      maxPages: 20
    });

    await waitFor(() => searches.length >= 1);

    for (let cycle = 2; cycle <= 5; cycle += 1) {
      await manager.runNow();
      await waitFor(() => searches.length >= cycle);
    }

    expect(manager.getState().cycleNumber).toBe(5);
    expect(resetStore).toHaveBeenCalledTimes(1);

    await manager.runNow();
    await waitFor(() => searches.length >= 6);
    expect(resetStore).toHaveBeenCalledTimes(1);

    for (let cycle = 7; cycle <= 10; cycle += 1) {
      await manager.runNow();
      await waitFor(() => searches.length >= cycle);
    }

    expect(manager.getState().cycleNumber).toBe(10);
    expect(resetStore).toHaveBeenCalledTimes(2);

    manager.stop();
  });
});
