import { useEffect } from 'react';
import { useAppStore } from './stores/appStore';
import { TopBar } from './components/TopBar';
import { BrowserGrid } from './components/BrowserGrid';
import { SettingsPage } from './components/SettingsPage';

export default function App() {
  const ready = useAppStore((s) => s.ready);
  const error = useAppStore((s) => s.error);
  const page = useAppStore((s) => s.page);
  const settings = useAppStore((s) => s.settings);
  const bootstrap = useAppStore((s) => s.bootstrap);

  useEffect(() => { void bootstrap(); }, [bootstrap]);
  useEffect(() => {
    if (!settings) return;
    const theme = settings.theme === 'system' ? (matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark') : settings.theme;
    document.documentElement.dataset.theme = theme;
  }, [settings]);

  if (!ready) return <div className="splash"><div className="spinner" /><h1>Social SEO</h1><p>Preparing lightweight browser slots and private proxy pool…</p></div>;
  if (error) return <div className="splash error-screen"><h1>Startup error</h1><p>{error}</p></div>;

  return <div className="app-shell"><TopBar />{page === 'workspaces' && <BrowserGrid />}{page === 'settings' && <SettingsPage />}</div>;
}

