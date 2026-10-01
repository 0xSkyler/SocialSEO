import type { ProxyAssignment, ProxyRecord } from '../shared/types/proxy';

export function assignProxies(
  proxies: ProxyRecord[],
  browserCount: number,
  allowReuse: boolean,
  includePreviouslyDead = false
): ProxyAssignment[] {
  const eligible = proxies.filter((proxy) => includePreviouslyDead || proxy.status !== 'dead');
  const uniqueEndpoint = new Map<string, ProxyRecord>();
  for (const proxy of eligible) {
    const key = `${proxy.protocol}|${proxy.host.toLowerCase()}|${proxy.port}`;
    if (!uniqueEndpoint.has(key)) uniqueEndpoint.set(key, proxy);
  }
  const pool = [...uniqueEndpoint.values()];
  return Array.from({ length: browserCount }, (_, index) => {
    // Reuse is temporal, not simultaneous. Initial assignment never gives the
    // same proxy to two browsers; ProxyManager handles later full-pool cycles.
    void allowReuse;
    const proxy = pool[index];
    return { workspaceId: index + 1, proxyId: proxy?.id };
  });
}
