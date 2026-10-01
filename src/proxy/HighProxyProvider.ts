import type { ProxyRecord } from '../shared/types/proxy';
import { ProxyParser, toProxyRecord } from './ProxyParser';

export const HIGH_PROXY_URL = 'http://169.58.35.69/data/all-working.txt';
const SOURCE_NAME = 'All Working API';
const REQUEST_TIMEOUT_MS = 15_000;

export interface HighProxyBatch {
  proxies: ProxyRecord[];
  rawEntries: number;
  parsedEntries: number;
  invalidEntries: number;
}

/**
 * Parse one all-working.txt response without performing any connectivity validation.
 * Endpoint uniqueness is host+port, intentionally ignoring protocol so the
 * same network endpoint cannot be assigned twice in one cycle.
 */
export function parseHighProxyText(text: string): HighProxyBatch {
  const proxies: ProxyRecord[] = [];
  const endpoints = new Set<string>();
  let rawEntries = 0;
  let parsedEntries = 0;
  let invalidEntries = 0;

  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;

    rawEntries += 1;
    const parsed = ProxyParser.tryParseLine(line);
    if (!parsed) {
      invalidEntries += 1;
      continue;
    }

    parsedEntries += 1;
    const endpoint = `${parsed.host.toLowerCase()}:${parsed.port}`;
    if (endpoints.has(endpoint)) continue;

    endpoints.add(endpoint);
    proxies.push(toProxyRecord(parsed, SOURCE_NAME));
  }

  return { proxies, rawEntries, parsedEntries, invalidEntries };
}

/**
 * Download the current cycle's proxy list. This function only fetches and
 * parses; it never validates, scores, pings, geolocates, or tests a proxy.
 */
export async function fetchHighProxyBatch(
  signal?: AbortSignal,
  timeoutMs = REQUEST_TIMEOUT_MS
): Promise<HighProxyBatch> {
  const controller = new AbortController();
  const onAbort = () => controller.abort();
  signal?.addEventListener('abort', onAbort, { once: true });

  const timer = setTimeout(() => controller.abort(), Math.max(1_000, timeoutMs));

  try {
    const response = await fetch(HIGH_PROXY_URL, {
      method: 'GET',
      headers: {
        Accept: 'text/plain',
        'Cache-Control': 'no-cache',
        Pragma: 'no-cache'
      },
      signal: controller.signal
    });

    if (!response.ok) {
      throw new Error(`High proxy API returned HTTP ${response.status}.`);
    }

    const text = await response.text();
    const batch = parseHighProxyText(text);
    if (batch.proxies.length === 0) {
      throw new Error('High proxy API returned no parsable proxy endpoints.');
    }

    return batch;
  } catch (err) {
    if (signal?.aborted) throw new Error('Proxy API request cancelled.');
    if (controller.signal.aborted) throw new Error(`Proxy API request timed out after ${timeoutMs} ms.`);
    throw err;
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener('abort', onAbort);
  }
}

export async function fetchHighProxies(signal?: AbortSignal): Promise<ProxyRecord[]> {
  return (await fetchHighProxyBatch(signal)).proxies;
}
