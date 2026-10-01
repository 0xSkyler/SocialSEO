import { describe, expect, it } from 'vitest';
import { SeoAutomationManager } from '../src/main/SeoAutomationManager';
import type { ProxyManager } from '../src/main/ProxyManager';
import type { BrowserManager } from '../src/main/BrowserManager';
import type { BroadcastSearchResult } from '../src/shared/types/browser';
import type { ProxyRecord, ReloadProxiesSummary } from '../src/shared/types/proxy';

function makeProxy(id: string): ProxyRecord {
  return {
    id,
    host: id + '.example.test',
    port: 8080,
    protocol: 'http',
    countryVerified: false,
    sources: ['All Working API'],
    status: 'unknown',
    score: 0,
    successCount: 0,
    failureCount: 0,
    googleStatus: 'unknown'
  };
}

async function waitForCount(values: string[], count: number): Promise<void> {
  const deadline = Date.now() + 1500;
  while (values.length < count) {
    if (Date.now() > deadline) throw new Error('Timed out waiting for search cycle.');
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

describe('multi-keyword cycle rotation', () => {
  it('uses one keyword for every browser in a cycle and advances next cycle', async () => {
    const searches: string[] = [];
    const tokens = new Map<number, number>();
    let fetchNumber = 0;

    const proxyManager = {
      cancelCurrentFetch() {},
      async fetchAssignDirect(
        browserIds: number[],
        onAssignment: (assignment: { browserId: number; proxy: ProxyRecord }) => void,
        onProgress?: (checked: number, total: number, working: number, assigned: number, fetched: number) => void
      ): Promise<ReloadProxiesSummary> {
        fetchNumber += 1;
        const assignments = browserIds.map((browserId) => ({
          browserId,
          proxy: makeProxy('cycle-' + fetchNumber + '-b' + browserId)
        }));
        onProgress?.(assignments.length, assignments.length, assignments.length, assignments.length, assignments.length);
        assignments.forEach(onAssignment);
        return {
          found: assignments.length,
          countryMatched: assignments.length,
          working: assignments.length,
          assignments
        };
      }
    } as unknown as ProxyManager;

    const browserManager = {
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
      async broadcastSearch(id: number, query: string): Promise<BroadcastSearchResult> {
        searches.push(id + ':' + query);
        return {
          browserId: id,
          status: 'matched',
          landedUrl: 'https://www.google.com/search',
          matchedUrl: 'https://example.com/article',
          matchedTitle: 'Article',
          monitoring: true,
          interactionStatus: 'opened',
          ranAt: new Date().toISOString()
        };
      },
      startControlledKeepAlive() {},
      async clickControlledGoogleResult() {
        return true;
      },
      async waitForGoogleRecovery() {
        return true;
      }
    } as unknown as BrowserManager;

    const manager = new SeoAutomationManager(proxyManager, browserManager, async () => [1, 2]);

    await manager.start({
      query: 'alpha, beta, gamma',
      targetWebsite: 'example.com',
      intervalSec: 600,
      browserCount: 2,
      maxPages: 20
    });

    await waitForCount(searches, 2);
    expect(searches.slice(0, 2)).toEqual(['1:alpha', '2:alpha']);

    await manager.runNow();
    await waitForCount(searches, 4);
    expect(searches.slice(2, 4)).toEqual(['1:beta', '2:beta']);

    await manager.runNow();
    await waitForCount(searches, 6);
    expect(searches.slice(4, 6)).toEqual(['1:gamma', '2:gamma']);

    await manager.runNow();
    await waitForCount(searches, 8);
    expect(searches.slice(6, 8)).toEqual(['1:alpha', '2:alpha']);

    expect(fetchNumber).toBe(4);
    manager.stop();
  });
});
