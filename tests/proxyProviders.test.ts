import { describe, expect, it } from 'vitest';
import { CUSTOM_PROXY_API_URL, DEFAULT_PROXY_PROVIDER, PROXY_PROVIDERS } from '../src/shared/proxySource';

describe('private proxy API', () => {
  it('uses exactly one fixed proxy source', () => {
    expect(DEFAULT_PROXY_PROVIDER).toBe('private-api');
    expect(PROXY_PROVIDERS).toHaveLength(1);
    expect(CUSTOM_PROXY_API_URL).toBe('http://169.58.35.69/data/elite.txt');
  });
});
