import https from 'node:https';
import type { ProxyProtocol } from '../shared/types/proxy';
import {
  PROXY_PROVIDER_LABELS,
  type ProxyProviderId
} from '../shared/types/automation';
import { fetchProxyScrapeFreeList } from './ProxyScrapeProvider';

export interface ProxyProviderFetchOptions {
  limit?: number;
  timeoutFilterMs?: number;
  requestTimeoutMs?: number;
  signal?: AbortSignal;
}

export interface ProxyProviderFetchResult {
  provider: ProxyProviderId;
  label: string;
  raw: string;
  fetchedLines: number;
}

interface TextFeed {
  url: string;
  protocol: ProxyProtocol;
}

const FEEDS: Record<Exclude<ProxyProviderId, 'proxyscrape'>, TextFeed[]> = {
  proxifly: [
    {
      url: 'https://cdn.jsdelivr.net/gh/proxifly/free-proxy-list@main/proxies/protocols/http/data.txt',
      protocol: 'http'
    },
    {
      url: 'https://cdn.jsdelivr.net/gh/proxifly/free-proxy-list@main/proxies/protocols/https/data.txt',
      protocol: 'https'
    },
    {
      url: 'https://cdn.jsdelivr.net/gh/proxifly/free-proxy-list@main/proxies/protocols/socks4/data.txt',
      protocol: 'socks4'
    },
    {
      url: 'https://cdn.jsdelivr.net/gh/proxifly/free-proxy-list@main/proxies/protocols/socks5/data.txt',
      protocol: 'socks5'
    }
  ],
  hproxy: [
    { url: 'https://raw.githubusercontent.com/hproxy-com/free-proxy-list/main/http.txt', protocol: 'http' },
    { url: 'https://raw.githubusercontent.com/hproxy-com/free-proxy-list/main/https.txt', protocol: 'https' },
    { url: 'https://raw.githubusercontent.com/hproxy-com/free-proxy-list/main/socks4.txt', protocol: 'socks4' },
    { url: 'https://raw.githubusercontent.com/hproxy-com/free-proxy-list/main/socks5.txt', protocol: 'socks5' }
  ],
  proxmint: [
    { url: 'https://raw.githubusercontent.com/proxmint/free-proxy-list/main/proxies/http.txt', protocol: 'http' },
    { url: 'https://raw.githubusercontent.com/proxmint/free-proxy-list/main/proxies/https.txt', protocol: 'https' },
    { url: 'https://raw.githubusercontent.com/proxmint/free-proxy-list/main/proxies/socks4.txt', protocol: 'socks4' },
    { url: 'https://raw.githubusercontent.com/proxmint/free-proxy-list/main/proxies/socks5.txt', protocol: 'socks5' }
  ],
  thespeedx: [
    { url: 'https://raw.githubusercontent.com/TheSpeedX/SOCKS-List/master/http.txt', protocol: 'http' },
    { url: 'https://raw.githubusercontent.com/TheSpeedX/SOCKS-List/master/socks4.txt', protocol: 'socks4' },
    { url: 'https://raw.githubusercontent.com/TheSpeedX/SOCKS-List/master/socks5.txt', protocol: 'socks5' }
  ],
  monosans: [
    { url: 'https://raw.githubusercontent.com/monosans/proxy-list/main/proxies/http.txt', protocol: 'http' },
    { url: 'https://raw.githubusercontent.com/monosans/proxy-list/main/proxies/socks4.txt', protocol: 'socks4' },
    { url: 'https://raw.githubusercontent.com/monosans/proxy-list/main/proxies/socks5.txt', protocol: 'socks5' }
  ]
};

const MAX_PROVIDER_RESPONSE_BYTES = 6_000_000;
const MAX_LINES_PER_PROTOCOL = 2_000;

export async function fetchProxyProviderList(
  provider: ProxyProviderId,
  options: ProxyProviderFetchOptions = {}
): Promise<ProxyProviderFetchResult> {
  const label = PROXY_PROVIDER_LABELS[provider];

  if (provider === 'proxyscrape') {
    const raw = await fetchProxyScrapeFreeList({
      limit: Math.max(1, Math.min(2000, Math.floor(options.limit ?? 2000))),
      timeoutFilterMs: options.timeoutFilterMs,
      requestTimeoutMs: options.requestTimeoutMs,
      signal: options.signal
    });
    return {
      provider,
      label,
      raw,
      fetchedLines: countUsableLines(raw)
    };
  }

  const requestTimeoutMs = Math.max(
    3000,
    Math.min(30_000, Math.floor(options.requestTimeoutMs ?? 15_000))
  );

  const results = await Promise.allSettled(
    FEEDS[provider].map(async (feed) => {
      const body = await fetchText(feed.url, requestTimeoutMs, options.signal);
      return normalizeFeed(body, feed.protocol);
    })
  );

  const successful = results
    .filter((result): result is PromiseFulfilledResult<string[]> => result.status === 'fulfilled')
    .flatMap((result) => result.value);

  if (successful.length === 0) {
    const reasons = results
      .filter((result): result is PromiseRejectedResult => result.status === 'rejected')
      .map((result) => (result.reason instanceof Error ? result.reason.message : String(result.reason)))
      .slice(0, 3)
      .join('; ');
    throw new Error(`${label} returned no usable proxy feeds${reasons ? `: ${reasons}` : '.'}`);
  }

  return {
    provider,
    label,
    raw: successful.join('\n'),
    fetchedLines: successful.length
  };
}

function normalizeFeed(body: string, protocol: ProxyProtocol): string[] {
  const output: string[] = [];
  for (const rawLine of body.split(/\r?\n/)) {
    if (output.length >= MAX_LINES_PER_PROTOCOL) break;
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;

    if (/^(?:https?|socks4|socks5):\/\//i.test(line)) {
      output.push(line);
    } else if (/^[^\s:]+:\d+(?::[^\s:]+:[^\s]+)?$/.test(line) || /^[^\s@]+@[^\s:]+:\d+$/.test(line)) {
      output.push(`${protocol}://${line}`);
    }
  }
  return output;
}

function countUsableLines(body: string): number {
  return body
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean).length;
}

async function fetchText(
  url: string,
  timeoutMs: number,
  signal?: AbortSignal,
  redirectsLeft = 3
): Promise<string> {
  return new Promise<string>((resolve, reject) => {
    if (signal?.aborted) {
      reject(new Error('Proxy provider request aborted.'));
      return;
    }

    const request = https.get(
      url,
      {
        headers: {
          accept: 'text/plain,*/*;q=0.8',
          'user-agent': 'ProxyDesk/0.6 (+public-proxy-provider)'
        }
      },
      (response) => {
        const statusCode = response.statusCode ?? 0;
        if (
          statusCode >= 300 &&
          statusCode < 400 &&
          response.headers.location &&
          redirectsLeft > 0
        ) {
          response.resume();
          const redirected = new URL(response.headers.location, url).toString();
          void fetchText(redirected, timeoutMs, signal, redirectsLeft - 1).then(resolve, reject);
          return;
        }

        if (statusCode < 200 || statusCode >= 300) {
          response.resume();
          reject(new Error(`HTTP ${statusCode} from proxy provider.`));
          return;
        }

        response.setEncoding('utf8');
        let body = '';
        response.on('data', (chunk: string) => {
          body += chunk;
          if (body.length > MAX_PROVIDER_RESPONSE_BYTES) {
            request.destroy(new Error('Proxy provider response exceeded the safety limit.'));
          }
        });
        response.on('end', () => resolve(body));
      }
    );

    request.setTimeout(timeoutMs, () => {
      request.destroy(new Error(`Proxy provider request timed out after ${timeoutMs} ms.`));
    });

    const onAbort = () => request.destroy(new Error('Proxy provider request aborted.'));
    signal?.addEventListener('abort', onAbort, { once: true });

    request.on('close', () => signal?.removeEventListener('abort', onAbort));
    request.on('error', reject);
  });
}
