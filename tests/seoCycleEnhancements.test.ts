import { describe, expect, it } from 'vitest';
import { SeoAutomationManager } from '../src/main/SeoAutomationManager';
import type { CycleProxyLoadResult, ProxyManager } from '../src/main/ProxyManager';
import type { BrowserManager } from '../src/main/BrowserManager';
import type { BroadcastSearchResult } from '../src/shared/types/browser';
import type { ProxyRecord } from '../src/shared/types/proxy';

function proxy(id: string): ProxyRecord {
  return {
    id,
    host: id + '.example.test',
    port: 8080,
    protocol: 'http',
    countryVerified: false,
    sources: ['High API'],
    status: 'unknown',
    score: 0,
    successCount: 0,
    failureCount: 0,
    googleStatus: 'unknown'
  };
}

function result(browserIds: number[], proxies: ProxyRecord[]): CycleProxyLoadResult {
  return {
    found: proxies.length,
    countryMatched: proxies.length,
    working: proxies.length,
    rawEntries: proxies.length,
    parsedEntries: proxies.length,
    invalidEntries: 0,
    assignments: browserIds.map((browserId, index) => ({
      browserId,
      proxy: proxies[index] ?? null
    }))
  };
}

async function waitFor(predicate: () => boolean, timeoutMs = 1500): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error('Timed out waiting for condition.');
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

function browserHarness(searches: string[], assignments: string[]): BrowserManager {
  const tokens = new Map<number, number>();
  return {
    cancelMeasurementSession(id: number) {
      tokens.set(id, (tokens.get(id) ?? 0) + 1);
    },
    setBrowserKeepAlive() {},
    async assignProxy(id: number, p: ProxyRecord | null) {
      assignments.push(String(id) + ':' + (p?.id ?? 'none'));
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
      searches.push(String(id) + ':' + query);
      return {
        browserId: id,
        status: 'matched',
        landedUrl: 'https://www.google.com/search',
        matchedUrl: 'https://' + target + '/article',
        matchedTitle: query,
        monitoring: true,
        ranAt: new Date().toISOString()
      };
    },
    async clickControlledGoogleResult() {
      return false;
    },
    startControlledKeepAlive() {},
    async waitForGoogleRecovery() {
      return true;
    }
  } as unknown as BrowserManager;
}

describe('fresh High API fetch per cycle', () => {
  it('fetches again every cycle and keeps A B C keyword rotation unchanged', async () => {
    const searches: string[] = [];
    const assignments: string[] = [];
    let fetchCount = 0;

    const proxyManager = {
      cancelCurrentFetch() {},
      clearAssignments() {},
      async loadCycleProxies(browserIds: number[]) {
        fetchCount += 1;
        return result(browserIds, browserIds.map((id) => proxy('cycle-' + fetchCount + '-b' + id)));
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
    expect(fetchCount).toBe(1);
    expect(searches.slice(0, 2)).toEqual(['1:A', '2:A']);

    await manager.runNow();
    await waitFor(() => searches.length >= 4);
    expect(fetchCount).toBe(2);
    expect(searches.slice(2, 4)).toEqual(['1:B', '2:B']);

    await manager.runNow();
    await waitFor(() => searches.length >= 6);
    expect(fetchCount).toBe(3);
    expect(searches.slice(4, 6)).toEqual(['1:C', '2:C']);

    await manager.runNow();
    await waitFor(() => searches.length >= 8);
    expect(fetchCount).toBe(4);
    expect(searches.slice(6, 8)).toEqual(['1:A', '2:A']);

    expect(assignments[0]).toContain('cycle-1');
    expect(assignments[2]).toContain('cycle-2');
    expect(assignments[4]).toContain('cycle-3');
    expect(assignments[6]).toContain('cycle-4');

    manager.stop();
  });

  it('starts only browsers that received proxies when the API returns too few', async () => {
    const searches: string[] = [];
    const assignments: string[] = [];
    const proxyManager = {
      cancelCurrentFetch() {},
      clearAssignments() {},
      async loadCycleProxies(browserIds: number[]) {
        return result(browserIds, [proxy('only-one')]);
      }
    } as unknown as ProxyManager;

    const manager = new SeoAutomationManager(
      proxyManager,
      browserHarness(searches, assignments),
      async () => [1, 2, 3]
    );

    await manager.start({
      query: 'A',
      targetWebsite: 'example.com',
      intervalSec: 600,
      browserCount: 3,
      maxPages: 20
    });

    await waitFor(() => searches.length >= 1);
    await new Promise((resolve) => setTimeout(resolve, 20));

    expect(assignments).toEqual(['1:only-one']);
    expect(searches).toEqual(['1:A']);
    expect(manager.getState().assignedBrowsers).toBe(1);
    manager.stop();
  });
});
