export type ProxyProvider = 'private-api';

export interface ProxyProviderFeed {
  url: string;
  protocol?: 'http' | 'https' | 'socks4' | 'socks5';
}

export interface ProxyProviderDefinition {
  id: ProxyProvider;
  label: string;
  feeds: ProxyProviderFeed[];
}

export const CUSTOM_PROXY_API_URL = 'http://169.58.35.69/data/elite.txt';

export const PROXY_PROVIDERS: ProxyProviderDefinition[] = [{
  id: 'private-api',
  label: 'Private proxy API',
  feeds: [{ url: CUSTOM_PROXY_API_URL }]
}];

export const DEFAULT_PROXY_PROVIDER: ProxyProvider = 'private-api';

export function getProxyProvider(provider?: ProxyProvider): ProxyProviderDefinition {
  void provider;
  return PROXY_PROVIDERS[0]!;
}

export const PROXYSCRAPE_API_URL = CUSTOM_PROXY_API_URL;
export const PROXYSCRAPE_SOURCE_LABEL = 'Private proxy API';
