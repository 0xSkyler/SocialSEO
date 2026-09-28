import { afterEach, describe, expect, it, vi } from 'vitest';
import { SeoAutomationManager } from '../src/main/SeoAutomationManager';
import type { BroadcastSearchResult } from '../src/shared/types/browser';
import type { ProxyRecord, ReloadProxiesSummary } from '../src/shared/types/proxy';
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

function browserHarness(searches: string[]): BrowserManager {
  const tokens = new Map<number, number>();

  return {
    async assignProxy() {},
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
      searches.push(query);
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

async function waitFor(
  predicate: () => boolean,
  timeoutMs = 1000
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error('Timed out waiting for condition.');
    await Promise.resolve();
    await new Promise((resolve) => setTimeout(resolve, 1));
  }
}

afterEach(() => {
  vi.useRealTimers();
});

describe('v0.5.4 cycle enhancements', () => {
  it('uses A, B, C then wraps to A, with every browser using the same cycle keyword', async () => {
    const searches: string[] = [];
    const liveProxy = proxy('cycle');
    let fetchCalls = 0;
    let preparedActivationCalls = 0;

    const proxyManager = {
      cancelCurrentValidation() {},
      cancelPreparedValidation() {},
      resetRotationHistory() {},
      activatePreparedAssignments(
        browserIds: number[],
        onAssignment: (assignment: { browserId: number; proxy: ProxyRecord }) => void,
        onProgress?: (checked: number, total: number, working: number, assigned: number, fetched: number) => void
      ): ReloadProxiesSummary | null {
        preparedActivationCalls += 1;
        if (preparedActivationCalls === 1) return null;

        onProgress?.(1, 1, 1, 1, 1);
        for (const browserId of browserIds) {
          onAssignment({ browserId, proxy: liveProxy });
        }
        return {
          found: 1,
          countryMatched: 1,
          working: 1,
          assignments: browserIds.map((browserId) => ({ browserId, proxy: liveProxy }))
        };
      },
      async fetchValidateAssignStreaming(
        browserIds: number[],
        onAssignment: (assignment: { browserId: number; proxy: ProxyRecord }) => void,
        onProgress?: (checked: number, total: number, working: number, assigned: number, fetched: number) => void
      ): Promise<ReloadProxiesSummary> {
        fetchCalls += 1;
        onProgress?.(1, 1, 1, browserIds.length, 1);
        for (const browserId of browserIds) {
          onAssignment({ browserId, proxy: liveProxy });
        }
        return {
          found: 1,
          countryMatched: 1,
          working: 1,
          assignments: browserIds.map((browserId) => ({ browserId, proxy: liveProxy }))
        };
      }
    } as unknown as ProxyManager;

    const manager = new SeoAutomationManager(
      proxyManager,
      browserHarness(searches),
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
    expect(searches.slice(0, 2)).toEqual(['A', 'A']);
    expect(manager.getState().currentQuery).toBe('A');

    await manager.runNow();
    await waitFor(() => searches.length >= 4);
    expect(searches.slice(2, 4)).toEqual(['B', 'B']);
    expect(manager.getState().currentQuery).toBe('B');

    await manager.runNow();
    await waitFor(() => searches.length >= 6);
    expect(searches.slice(4, 6)).toEqual(['C', 'C']);

    await manager.runNow();
    await waitFor(() => searches.length >= 8);
    expect(searches.slice(6, 8)).toEqual(['A', 'A']);

    // Only cycle 1 needed the original on-demand validator; prepared pools
    // supplied the later cycles.
    expect(fetchCalls).toBe(1);

    manager.stop();
  });

  it('starts next-session proxy validation 60 seconds before a scheduled cycle', async () => {
    vi.useFakeTimers();

    const searches: string[] = [];
    const liveProxy = proxy('prefetch');
    const prepareNextCycle = vi.fn(async (_browserIds: number[]) => undefined);

    const proxyManager = {
      cancelCurrentValidation() {},
      cancelPreparedValidation() {},
      resetRotationHistory() {},
      prepareNextCycle,
      activatePreparedAssignments() {
        return null;
      },
      async fetchValidateAssignStreaming(
        browserIds: number[],
        onAssignment: (assignment: { browserId: number; proxy: ProxyRecord }) => void
      ): Promise<ReloadProxiesSummary> {
        for (const browserId of browserIds) {
          onAssignment({ browserId, proxy: liveProxy });
        }
        return {
          found: 1,
          countryMatched: 1,
          working: 1,
          assignments: browserIds.map((browserId) => ({ browserId, proxy: liveProxy }))
        };
      }
    } as unknown as ProxyManager;

    const manager = new SeoAutomationManager(
      proxyManager,
      browserHarness(searches),
      async () => [1]
    );

    await manager.start({
      query: 'A, B',
      targetWebsite: 'example.com',
      intervalSec: 120,
      browserCount: 1,
      maxPages: 20
    });

    await vi.advanceTimersByTimeAsync(59_999);
    expect(prepareNextCycle).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(1);
    expect(prepareNextCycle).toHaveBeenCalledTimes(1);
    expect(prepareNextCycle).toHaveBeenCalledWith([1]);

    manager.stop();
  });
});
