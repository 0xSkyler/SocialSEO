import { describe, expect, it } from 'vitest';
import { CUSTOM_PROXY_API_URL, PROXYSCRAPE_API_URL } from '../src/shared/proxySource';

describe('Private proxy API source', () => {
  it('uses only the configured high.txt endpoint', () => {
    expect(CUSTOM_PROXY_API_URL).toBe('http://169.58.35.69/data/elite.txt');
    expect(PROXYSCRAPE_API_URL).toBe(CUSTOM_PROXY_API_URL);
  });
});
