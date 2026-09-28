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

describe('v0.5.4 per-rotation proxy buffer', () => {
  it('starts next-cycle validation immediately after current proxies are assigned, before Google work starts', async () => {
    const events: string[] = [];
    const live = proxy('cycle-1');
    let readyCount = 1;
    let token = 0;

    const proxyManager = {
      cancelCurrentValidation() {},
      stopValidatedProxyStore() {},
      resetRotationHistory() {},
      startValidatedProxyStore() {
        readyCount = 1;
      },
      getValidatedStoreSize: () => readyCount,
      pauseValidatedProxyStore() {},
      dropCurrentAssignments() {},
      takeValidatedProxy() {
        readyCount = 0;
        return live;
      },
      resetValidatedStoreForNextRotation() {
        events.push('prepare-next');
        readyCount = 1;
      }
    } as unknown as ProxyManager;

    const browserManager = {
      async assignProxy() {
        events.push('assigned');
      },
      setBrowserKeepAlive() {},
      cancelMeasurementSession() {},
      startMeasurementSession() {
        token += 1;
        return token;
      },
      isMeasurementSessionCurrent(_id: number, current: number) {
        return current === token;
      },
      async broadcastSearch(
        id: number,
        _query: string,
        target: string
      ): Promise<BroadcastSearchResult> {
        events.push('google-work');
        return {
          browserId: id,
          status: 'matched',
          landedUrl: `https://${target}/article`,
          matchedUrl: `https://${target}/article`,
          matchedTitle: 'A',
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

    const manager = new SeoAutomationManager(proxyManager, browserManager, async () => [1]);

    await manager.start({
      query: 'A',
      targetWebsite: 'example.com',
      intervalSec: 600,
      browserCount: 1,
      maxPages: 20
    });

    await waitFor(() => events.includes('google-work'));

    expect(events.indexOf('assigned')).toBeGreaterThanOrEqual(0);
    expect(events.indexOf('prepare-next')).toBeGreaterThan(events.indexOf('assigned'));
    expect(events.indexOf('google-work')).toBeGreaterThan(events.indexOf('prepare-next'));

    manager.stop();
  });

  it('waits for a full prepared zone before starting any browser work', async () => {
    const searches: string[] = [];
    const assignments: string[] = [];
    const zone = [proxy('next-1'), proxy('next-2')];
    let readyCount = 0;

    const startStore = vi.fn(() => {
      setTimeout(() => {
        readyCount = 2;
      }, 20);
    });
    const pauseStore = vi.fn();
    const dropAssignments = vi.fn();
    const resetForNext = vi.fn(() => {
      readyCount = 0;
    });

    const proxyManager = {
      cancelCurrentValidation() {},
      stopValidatedProxyStore() {},
      resetRotationHistory() {},
      startValidatedProxyStore: startStore,
      getValidatedStoreSize: () => readyCount,
      pauseValidatedProxyStore: pauseStore,
      dropCurrentAssignments: dropAssignments,
      takeValidatedProxy() {
        const next = zone.shift() ?? null;
        if (next) readyCount -= 1;
        return next;
      },
      resetValidatedStoreForNextRotation: resetForNext
    } as unknown as ProxyManager;

    const manager = new SeoAutomationManager(
      proxyManager,
      browserHarness(searches, assignments),
      async () => [1, 2]
    );

    await manager.start({
      query: 'A',
      targetWebsite: 'example.com',
      intervalSec: 600,
      browserCount: 2,
      maxPages: 20
    });

    expect(searches).toEqual([]);
    expect(assignments).toEqual([]);

    await waitFor(() => searches.length === 2);

    expect(startStore).toHaveBeenCalledWith(2);
    expect(pauseStore).toHaveBeenCalledTimes(1);
    expect(dropAssignments).toHaveBeenCalledTimes(1);
    expect(assignments).toEqual(['1:next-1', '2:next-2']);
    expect(resetForNext).toHaveBeenCalledWith(2);

    manager.stop();
  });

  it('erases the temporary zone and starts fresh preparation after every rotation', async () => {
    const searches: string[] = [];
    const assignments: string[] = [];
    let serial = 0;
    let readyCount = 1;

    const resetForNext = vi.fn(() => {
      readyCount = 1;
    });

    const proxyManager = {
      cancelCurrentValidation() {},
      stopValidatedProxyStore() {},
      resetRotationHistory() {},
      startValidatedProxyStore() {
        readyCount = 1;
      },
      getValidatedStoreSize: () => readyCount,
      pauseValidatedProxyStore() {},
      dropCurrentAssignments() {},
      takeValidatedProxy() {
        readyCount = 0;
        serial += 1;
        return proxy(`rotation-${serial}`);
      },
      resetValidatedStoreForNextRotation: resetForNext
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
    await waitFor(() => resetForNext.mock.calls.length >= 1);
    expect(resetForNext).toHaveBeenCalledTimes(1);

    await manager.runNow();
    await waitFor(() => searches.length >= 2);
    await waitFor(() => resetForNext.mock.calls.length >= 2);
    expect(resetForNext).toHaveBeenCalledTimes(2);

    await manager.runNow();
    await waitFor(() => searches.length >= 3);
    await waitFor(() => resetForNext.mock.calls.length >= 3);
    expect(resetForNext).toHaveBeenCalledTimes(3);

    expect(assignments).toEqual([
      '1:rotation-1',
      '1:rotation-2',
      '1:rotation-3'
    ]);

    manager.stop();
  });

  it('keeps the existing A B C keyword rotation unchanged', async () => {
    const searches: string[] = [];
    const assignments: string[] = [];
    let serial = 0;
    let readyCount = 2;

    const proxyManager = {
      cancelCurrentValidation() {},
      stopValidatedProxyStore() {},
      resetRotationHistory() {},
      startValidatedProxyStore() {
        readyCount = 2;
      },
      getValidatedStoreSize: () => readyCount,
      pauseValidatedProxyStore() {},
      dropCurrentAssignments() {},
      takeValidatedProxy(browserId: number) {
        readyCount -= 1;
        serial += 1;
        return proxy(`p-${browserId}-${serial}`);
      },
      resetValidatedStoreForNextRotation() {
        readyCount = 2;
      }
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
});
