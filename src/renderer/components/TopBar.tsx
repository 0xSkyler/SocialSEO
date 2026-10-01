import { useAppStore, type AppPage } from '../stores/appStore';

const pages: Array<{ id: AppPage; label: string }> = [
  { id: 'workspaces', label: 'Control Center' },
  { id: 'settings', label: 'Settings' }
];

export function TopBar() {
  const page = useAppStore((s) => s.page);
  const workspaces = useAppStore((s) => s.workspaces);
  const setPage = useAppStore((s) => s.setPage);
  const proxies = useAppStore((s) => s.proxies);
  const validation = useAppStore((s) => s.validationProgress);
  const working = proxies.filter((proxy) => proxy.status === 'working').length;

  return <header className="topbar">
    <div className="brand"><div className="brand-mark">SS</div><div><strong>Social SEO</strong><small>{workspaces.length} browser slots · proxy-only Chromium</small></div></div>
    <nav className="tabs">{pages.map((item) => <button key={item.id} className={page === item.id ? 'tab active' : 'tab'} onClick={() => setPage(item.id)}>{item.label}</button>)}</nav>
    <div className="top-actions"><span className="memory-pill">{proxies.length ? `${working} live / ${proxies.length} loaded${validation.active ? ' · validating' : ''}` : 'Proxy process not started'}</span></div>
  </header>;
}
