import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  ALL_WORKING_PROXY_URL,
  fetchAllWorkingProxyText
} from '../src/proxy/AllWorkingProxyProvider';

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('AllWorkingProxyProvider', () => {
  it('uses the configured all-working.txt source', () => {
    expect(ALL_WORKING_PROXY_URL).toBe('http://169.58.35.69/data/all-working.txt');
  });

  it('fetches the source directly without any validation request', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response('1.2.3.4:8080\n5.6.7.8:3128\n', { status: 200 })
    );
    vi.stubGlobal('fetch', fetchMock);

    const text = await fetchAllWorkingProxyText();

    expect(text).toContain('1.2.3.4:8080');
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0][0]).toBe(ALL_WORKING_PROXY_URL);
    expect(fetchMock.mock.calls[0][1]).toMatchObject({ method: 'GET' });
  });
});
