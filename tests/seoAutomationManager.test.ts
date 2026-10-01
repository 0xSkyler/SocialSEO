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

function loadResult(browserIds: number[], proxies: ProxyRecord[]): CycleProxyLoadResult {
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

describe('SeoAutomationManager direct High API workflow', () => {
  it('assigns a fetched proxy before starting Google work', async () => {
    const events: string[] = [];
    const p = proxy('p1');
    const proxyManager = {
      cancelCurrentFetch() {},
      clearAssignments() {},
      async loadCycleProxies(browserIds: number[]) {
        events.push('fetch');
        return loadResult(browserIds, [p]);
      }
    } as unknown as ProxyManager;

    let token = 0;
    const browserManager = {
      cancelMeasurementSession() {},
      setBrowserKeepAlive() {},
      async assignProxy() {
        events.push('assign');
      },
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
        events.push('search');
        return {
          browserId: id,
          status: 'matched',
          landedUrl: 'https://www.google.com/search?q=test',
          matchedUrl: 'https://' + target + '/article',
          matchedTitle: 'Article',
          monitoring: true,
          ranAt: new Date().toISOString()
        };
      },
      async waitForGoogleRecovery() {
        return true;
      },
      async clickControlledGoogleResult() {
        return false;
      },
      startControlledKeepAlive() {}
    } as unknown as BrowserManager;

    const manager = new SeoAutomationManager(proxyManager, browserManager, async () => [1]);
    await manager.start({
      query: 'A',
      targetWebsite: 'example.com',
      intervalSec: 600,
      browserCount: 1,
      maxPages: 20
    });

    await waitFor(() => events.includes('search'));
    expect(events.indexOf('fetch')).toBeLessThan(events.indexOf('assign'));
    expect(events.indexOf('assign')).toBeLessThan(events.indexOf('search'));
    manager.stop();
  });

  it('keeps public production results read-only', async () => {
    const p = proxy('public');
    const proxyManager = {
      cancelCurrentFetch() {},
      clearAssignments() {},
      async loadCycleProxies(browserIds: number[]) {
        return loadResult(browserIds, [p]);
      }
    } as unknown as ProxyManager;

    let token = 0;
    let clickCalls = 0;
    let keepAliveCalls = 0;
    const browserManager = {
      cancelMeasurementSession() {},
      setBrowserKeepAlive() {},
      async assignProxy() {},
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
        _target: string,
        _maxPages: number,
        _token: number,
        allowInteraction: boolean
      ): Promise<BroadcastSearchResult> {
        expect(allowInteraction).toBe(false);
        return {
          browserId: id,
          status: 'matched',
          landedUrl: 'https://www.google.com/search?q=test',
          matchedUrl: 'https://example.com/article',
          matchedTitle: 'Article',
          monitoring: true,
          interactionStatus: 'detected',
          ranAt: new Date().toISOString()
        };
      },
      async clickControlledGoogleResult() {
        clickCalls += 1;
        return true;
      },
      startControlledKeepAlive() {
        keepAliveCalls += 1;
      },
      async waitForGoogleRecovery() {
        return true;
      }
    } as unknown as BrowserManager;

    const manager = new SeoAutomationManager(proxyManager, browserManager, async () => [1]);
    const resultPromise = new Promise<BroadcastSearchResult>((resolve) => {
      manager.on('seoResult', ({ result }) => resolve(result));
    });

    await manager.start({
      query: 'A',
      targetWebsite: 'example.com',
      intervalSec: 600,
      browserCount: 1,
      maxPages: 20
    });

    const result = await resultPromise;
    expect(result.interactionStatus).toBe('detected');
    expect(clickCalls).toBe(0);
    expect(keepAliveCalls).toBe(0);
    manager.stop();
  });

  it('allows controlled click and Keep Alive only on an explicit test host', async () => {
    const host = 'staging.example.com';
    const p = proxy('controlled');
    const proxyManager = {
      cancelCurrentFetch() {},
      clearAssignments() {},
      async loadCycleProxies(browserIds: number[]) {
        return loadResult(browserIds, [p]);
      }
    } as unknown as ProxyManager;

    let token = 0;
    const events: string[] = [];
    const browserManager = {
      cancelMeasurementSession() {},
      setBrowserKeepAlive() {},
      async assignProxy() {},
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
        _target: string,
        _maxPages: number,
        _token: number,
        allowInteraction: boolean
      ): Promise<BroadcastSearchResult> {
        expect(allowInteraction).toBe(true);
        return {
          browserId: id,
          status: 'matched',
          landedUrl: 'https://www.google.com/search?q=test',
          matchedUrl: 'https://' + host + '/article',
          matchedTitle: 'Article',
          monitoring: true,
          ranAt: new Date().toISOString()
        };
      },
      async clickControlledGoogleResult(
        _id: number,
        _query: string,
        controlledHost: string
      ) {
        events.push('click:' + controlledHost);
        return true;
      },
      startControlledKeepAlive(_id: number, controlledHost: string) {
        events.push('keepalive:' + controlledHost);
      },
      async waitForGoogleRecovery() {
        return true;
      }
    } as unknown as BrowserManager;

    const manager = new SeoAutomationManager(proxyManager, browserManager, async () => [1]);
    const opened = new Promise<BroadcastSearchResult>((resolve) => {
      manager.on('seoResult', ({ result }) => {
        if (result.keepAliveStarted) resolve(result);
      });
    });

    await manager.start({
      query: 'A',
      targetWebsite: host,
      controlledTestHost: host,
      intervalSec: 600,
      browserCount: 1,
      maxPages: 20
    });

    const result = await opened;
    expect(events).toContain('click:' + host);
    expect(events).toContain('keepalive:' + host);
    expect(result.interactionStatus).toBe('opened');
    manager.stop();
  });


  it('does not enable interaction unless the user explicitly enables test interaction', async () => {
    const host = 'staging.example.com';
    const p = proxy('not-confirmed');
    const proxyManager = {
      cancelCurrentFetch() {},
      clearAssignments() {},
      async loadCycleProxies(browserIds: number[]) {
        return loadResult(browserIds, [p]);
      }
    } as unknown as ProxyManager;

    let token = 0;
    let allowInteractionSeen = true;
    let clickCalls = 0;
    let keepAliveCalls = 0;

    const browserManager = {
      cancelMeasurementSession() {},
      setBrowserKeepAlive() {},
      async assignProxy() {},
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
        _target: string,
        _maxPages: number,
        _token: number,
        allowInteraction: boolean
      ): Promise<BroadcastSearchResult> {
        allowInteractionSeen = allowInteraction;
        return {
          browserId: id,
          status: 'matched',
          landedUrl: 'https://www.google.com/search?q=test',
          matchedUrl: 'https://' + host + '/article',
          matchedTitle: 'Article',
          monitoring: true,
          interactionStatus: 'detected',
          ranAt: new Date().toISOString()
        };
      },
      async clickControlledGoogleResult() {
        clickCalls += 1;
        return true;
      },
      startControlledKeepAlive() {
        keepAliveCalls += 1;
      },
      async waitForGoogleRecovery() {
        return true;
      }
    } as unknown as BrowserManager;

    const manager = new SeoAutomationManager(proxyManager, browserManager, async () => [1]);
    const observed = new Promise<BroadcastSearchResult>((resolve) => {
      manager.on('seoResult', ({ result }) => resolve(result));
    });

    await manager.start({
      query: 'A',
      targetWebsite: host,
      intervalSec: 600,
      browserCount: 1,
      maxPages: 20
    });

    const result = await observed;
    expect(allowInteractionSeen).toBe(false);
    expect(clickCalls).toBe(0);
    expect(keepAliveCalls).toBe(0);
    expect(result.interactionStatus).toBe('detected');
    manager.stop();
  });

  it('allows explicit staged interaction without requiring a special hostname pattern', async () => {
    const host = 'preview.example.com';
    const p = proxy('explicit-preview');
    const proxyManager = {
      cancelCurrentFetch() {},
      clearAssignments() {},
      async loadCycleProxies(browserIds: number[]) {
        return loadResult(browserIds, [p]);
      }
    } as unknown as ProxyManager;

    let token = 0;
    let allowInteractionSeen = false;
    let clickCalls = 0;
    let keepAliveCalls = 0;

    const browserManager = {
      cancelMeasurementSession() {},
      setBrowserKeepAlive() {},
      async assignProxy() {},
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
        _target: string,
        _maxPages: number,
        _token: number,
        allowInteraction: boolean
      ): Promise<BroadcastSearchResult> {
        allowInteractionSeen = allowInteraction;
        return {
          browserId: id,
          status: 'matched',
          landedUrl: 'https://www.google.com/search?q=test',
          matchedUrl: 'https://' + host + '/article',
          matchedTitle: 'Article',
          monitoring: true,
          ranAt: new Date().toISOString()
        };
      },
      async clickControlledGoogleResult() {
        clickCalls += 1;
        return true;
      },
      startControlledKeepAlive() {
        keepAliveCalls += 1;
      },
      async waitForGoogleRecovery() {
        return true;
      }
    } as unknown as BrowserManager;

    const manager = new SeoAutomationManager(proxyManager, browserManager, async () => [1]);
    const opened = new Promise<BroadcastSearchResult>((resolve) => {
      manager.on('seoResult', ({ result }) => {
        if (result.keepAliveStarted) resolve(result);
      });
    });

    await manager.start({
      query: 'A',
      targetWebsite: host,
      controlledTestHost: host,
      intervalSec: 600,
      browserCount: 1,
      maxPages: 20
    });

    const result = await opened;
    expect(allowInteractionSeen).toBe(true);
    expect(clickCalls).toBe(1);
    expect(keepAliveCalls).toBe(1);
    expect(result.interactionStatus).toBe('opened');
    expect(result.keepAliveStarted).toBe(true);
    manager.stop();
  });

  it('rejects an interaction target that differs from the target website', async () => {
    const manager = new SeoAutomationManager(
      { cancelCurrentFetch() {}, clearAssignments() {} } as unknown as ProxyManager,
      {} as BrowserManager,
      async () => [1]
    );

    await expect(
      manager.start({
        query: 'A',
        targetWebsite: 'preview.example.com',
        controlledTestHost: 'different.example.com',
        intervalSec: 600,
        browserCount: 1,
        maxPages: 20
      })
    ).rejects.toThrow(/exactly match/i);
  });

});
