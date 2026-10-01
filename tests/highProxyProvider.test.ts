import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  fetchHighProxyBatch,
  HIGH_PROXY_URL,
  parseHighProxyText
} from '../src/proxy/HighProxyProvider';

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('HighProxyProvider', () => {
  it('parses supported formats, ignores junk, and deduplicates by host+port', () => {
    const batch = parseHighProxyText([
      '# comment',
      '',
      '1.2.3.4:8080',
      'socks5://1.2.3.4:8080',
      'http://user:secret@5.6.7.8:3128',
      '9.9.9.9:1080:name:pass',
      'not a proxy'
    ].join('\n'));

    expect(batch.rawEntries).toBe(5);
    expect(batch.parsedEntries).toBe(4);
    expect(batch.invalidEntries).toBe(1);
    expect(batch.proxies).toHaveLength(3);
    expect(batch.proxies.map((proxy) => proxy.host + ':' + proxy.port)).toEqual([
      '1.2.3.4:8080',
      '5.6.7.8:3128',
      '9.9.9.9:1080'
    ]);
    expect(batch.proxies[1].username).toBe('user');
    expect(batch.proxies[1].password).toBe('secret');
  });

  it('fetches the fixed endpoint with no-cache headers and performs no validation request', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response('1.2.3.4:8080\n5.6.7.8:3128\n', { status: 200 })
    );
    vi.stubGlobal('fetch', fetchMock);

    const batch = await fetchHighProxyBatch();

    expect(batch.proxies).toHaveLength(2);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0][0]).toBe(HIGH_PROXY_URL);
    expect(fetchMock.mock.calls[0][1]).toMatchObject({
      method: 'GET',
      cache: 'no-store'
    });
    expect(fetchMock.mock.calls[0][1].headers).toMatchObject({
      Accept: 'text/plain',
      'Cache-Control': 'no-cache',
      Pragma: 'no-cache'
    });
  });

  it('rejects HTTP errors and empty/unparsable responses', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('bad', { status: 500 })));
    await expect(fetchHighProxyBatch()).rejects.toThrow(/HTTP 500/i);

    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('not a proxy\n', { status: 200 })));
    await expect(fetchHighProxyBatch()).rejects.toThrow(/no parsable proxy/i);
  });
});
