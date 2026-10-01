import type { ProxyRecord } from '../shared/types/proxy';
import { getPlaywright, type PwApiRequestContext } from './browser/PlaywrightRuntime';

function proxyOptions(proxy: ProxyRecord): Record<string, unknown> {
  return {
    server: `${proxy.protocol}://${proxy.host}:${proxy.port}`,
    username: proxy.username,
    password: proxy.password
  };
}

async function bounded<T>(promise: Promise<T>, timeoutMs: number, label: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<T>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error(`${label} timed out after ${timeoutMs}ms`)), timeoutMs);
        timer.unref?.();
      })
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/**
 * Fast proxy validation.
 *
 * Validation intentionally does NOT launch Chromium. Each candidate performs
 * one lightweight HTTPS request through the exact proxy. A successful HTTP
 * response marks it LIVE immediately so waiting browser slots can use it.
 * Chromium remains the final real-world check: if a LIVE proxy later fails
 * while loading the assigned site, the normal failover path marks it dead and
 * rotates to a different LIVE proxy.
 */
export class ProxyValidator {
  async validate(proxy: ProxyRecord, checkUrl: string, timeoutMs: number): Promise<ProxyRecord> {
    const started = Date.now();
    let context: PwApiRequestContext | undefined;

    try {
      context = await bounded(
        getPlaywright().request.newContext({
          proxy: proxyOptions(proxy),
          ignoreHTTPSErrors: false,
          timeout: timeoutMs,
          extraHTTPHeaders: {
            'Cache-Control': 'no-cache, no-store, max-age=0',
            Pragma: 'no-cache',
            Accept: '*/*'
          }
        }),
        Math.max(1500, timeoutMs),
        'Fast proxy request context creation'
      );

      const response = await bounded(
        context.get(checkUrl, {
          timeout: timeoutMs,
          failOnStatusCode: false
        }),
        timeoutMs + 500,
        'Fast proxy HTTPS probe'
      );

      if (!response.ok()) throw new Error(`HTTP ${response.status()}`);

      return {
        ...proxy,
        status: 'working',
        latencyMs: Date.now() - started,
        lastCheckedAt: new Date().toISOString(),
        lastError: undefined
      };
    } catch (error) {
      return {
        ...proxy,
        status: 'dead',
        latencyMs: undefined,
        lastCheckedAt: new Date().toISOString(),
        lastError: error instanceof Error ? error.message : 'Fast HTTPS validation failed'
      };
    } finally {
      if (context) {
        try { await bounded(context.dispose(), 1000, 'Fast proxy request context close'); } catch { /* cleanup only */ }
      }
    }
  }
}
