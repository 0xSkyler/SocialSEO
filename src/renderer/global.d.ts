import type { ProxyDeskApi } from '../shared/types/ipc';

declare global {
  interface Window {
    proxydesk: ProxyDeskApi;
  }
}
export {};
