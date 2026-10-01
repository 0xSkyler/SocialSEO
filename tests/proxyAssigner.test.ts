import { describe, expect, it } from 'vitest';
import { assignProxies } from '../src/proxy/ProxyAssigner';
import type { ProxyRecord } from '../src/shared/types/proxy';

const proxies = (count: number): ProxyRecord[] => Array.from({ length: count }, (_, i) => ({
  id: `p${i + 1}`, host: `10.0.0.${i + 1}`, port: 8000 + i, protocol: 'http', source: 'test', status: 'unverified'
}));

describe('ProxyAssigner', () => {
  it('assigns 10 unique proxies to 10 browsers', () => {
    const result = assignProxies(proxies(10), 10, false);
    expect(result.filter((x) => x.proxyId)).toHaveLength(10);
    expect(new Set(result.map((x) => x.proxyId))).toHaveLength(10);
  });

  it('leaves 4 browsers direct when only 6 proxies exist and reuse is off', () => {
    const result = assignProxies(proxies(6), 10, false);
    expect(result.filter((x) => x.proxyId)).toHaveLength(6);
    expect(result.filter((x) => !x.proxyId)).toHaveLength(4);
  });

  it('leaves all browsers direct with zero proxies', () => {
    expect(assignProxies([], 10, false).every((x) => !x.proxyId)).toBe(true);
  });

  it('never shares one proxy across browsers even when temporal reuse is enabled', () => {
    const result = assignProxies(proxies(2), 10, true);
    expect(result.filter((x) => x.proxyId)).toHaveLength(2);
    expect(new Set(result.map((x) => x.proxyId).filter(Boolean))).toHaveLength(2);
    expect(result.filter((x) => !x.proxyId)).toHaveLength(8);
  });

  it('excludes dead proxies when validation is being respected', () => {
    const pool = proxies(2);
    pool[0]!.status = 'dead';
    expect(assignProxies(pool, 10, false).filter((x) => x.proxyId)).toHaveLength(1);
  });

  it('can assign previously-dead endpoints when no-validation mode is explicit', () => {
    const pool = proxies(2);
    pool[0]!.status = 'dead';
    expect(assignProxies(pool, 10, false, true).filter((x) => x.proxyId)).toHaveLength(2);
  });
  it('supports a 100-browser fleet', () => {
    const result = assignProxies(proxies(100), 100, false);
    expect(result).toHaveLength(100);
    expect(result.filter((x) => x.proxyId)).toHaveLength(100);
    expect(new Set(result.map((x) => x.proxyId))).toHaveLength(100);
  });

});
