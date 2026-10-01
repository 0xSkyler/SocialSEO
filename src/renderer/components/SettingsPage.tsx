import { useEffect, useMemo, useState } from 'react';
import type { AppSettings } from '../../shared/types/settings';
import { useAppStore } from '../stores/appStore';

export function SettingsPage() {
  const settings = useAppStore((s) => s.settings);
  const diagnostics = useAppStore((s) => s.diagnostics);
  const engines = useAppStore((s) => s.engines);
  const update = useAppStore((s) => s.updateSettings);
  const refreshEngines = useAppStore((s) => s.refreshEngines);
  const [draft, setDraft] = useState<AppSettings | undefined>(settings ? structuredClone(settings) : undefined);
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState('');

  useEffect(() => {
    if (settings) setDraft(structuredClone(settings));
  }, [settings]);

  const dirty = useMemo(() => Boolean(settings && draft && JSON.stringify(settings) !== JSON.stringify(draft)), [settings, draft]);
  if (!settings || !draft) return null;

  const patchDraft = (patch: Partial<AppSettings>) => setDraft((current) => current ? { ...current, ...patch } : current);
  const patchKeepAlive = (patch: Partial<AppSettings['keepAlive']>) => setDraft((current) => current ? { ...current, keepAlive: { ...current.keepAlive, ...patch } } : current);

  const saveAll = async () => {
    setSaving(true);
    setMessage('');
    try {
      await update(draft);
      setMessage(`Settings saved. The ${draft.defaultRotationSeconds}s Keep Alive / rotation timer is now applied to every logical slot.${draft.defaultRotationSeconds > 0 ? ' Any running slots were restarted so the new timer and Keep Alive rules take effect immediately.' : ''}`);
    } catch (error) {
      setMessage(error instanceof Error ? error.message : String(error));
    } finally {
      setSaving(false);
    }
  };

  return <main className="content settings-page">
    <section className="page-intro"><div><span className="eyebrow">CONFIGURATION</span><h1>Settings</h1><p>Edit the settings below, then click <strong>Save settings</strong> once. Changes are staged until you save them.</p></div><div className="settings-save-actions"><button disabled={!dirty || saving} onClick={() => setDraft(structuredClone(settings))}>Discard changes</button><button className="primary" disabled={!dirty || saving} onClick={() => void saveAll()}>{saving ? 'Saving…' : 'Save settings'}</button></div></section>
    {message && <div className="inline-message settings-message">{message}</div>}
    <div className="settings-grid">
      <section className="panel setting-section"><h2>Logical browser slots</h2>
        <label>Active logical slots<input type="number" min={1} max={100} step={1} value={draft.browserCount} onChange={(e) => patchDraft({ browserCount: Math.min(100, Math.max(1, Math.floor(Number(e.target.value) || 1))) })} /></label>
        <small>Range: 1–100. Starting many slots at once launches the same number of Chromium sessions and can use substantial RAM.</small>
      </section>

      <section className="panel setting-section"><h2>Central Keep Alive / rotation</h2>
        <label>Keep Alive / rotation timer (seconds)<input type="number" min={0} step={1} value={draft.defaultRotationSeconds} onChange={(e) => patchDraft({ defaultRotationSeconds: Math.max(0, Math.floor(Number(e.target.value) || 0)) })} /><small>This is the single global timer for every slot. A positive value keeps each started slot in Keep Alive until the deadline, then rotates its proxy and starts a fresh session. 0 performs one landing visit only.</small></label>
        <div className="info-box"><strong>One timer for all slots</strong><p>The Control Center no longer has per-row timer inputs. Saving this value updates every logical slot. Running slots are restarted so the new timer takes effect immediately.</p></div>
      </section>

      <section className="panel setting-section"><h2>Proxy source</h2>
        <div className="info-box"><strong>Private API only</strong><p>Proxies are fetched from http://169.58.35.69/data/elite.txt and assigned directly. There is no proxy validation, latency testing, provider selection, or manual proxy file workflow.</p></div>
        <small>Each normal rotation cycle refreshes the API pool. Failed proxies are excluded from the current cycle, and Chromium never falls back to the direct VPS network.</small>
      </section>

      <section className="panel setting-section"><div className="section-head-row"><h2>Browser engine</h2><button onClick={() => void refreshEngines()}>Re-detect</button></div>
        <div className="engine-list">{engines.map((engine) => <div className="engine-row" key={engine.engine}><span className={`engine-light ${engine.available ? 'ok' : 'bad'}`} /><div><strong>{engine.label}</strong><small>{engine.detail}</small></div><span className="engine-kind">{engine.bundled ? 'Bundled' : 'System'}</span></div>)}</div>
        <div className="info-box"><strong>Chromium on demand</strong><p>No browser is resident while a slot is stopped. Every started slot launches its own Chromium session immediately. All started slots run concurrently.</p></div>
      </section>

      <section className="panel setting-section"><h2>Automatic Keep Alive</h2>
        <p>These rules are saved together with the central timer. If a Keep Alive rule changes while slots are running, saving settings restarts the active sessions so the new rules apply immediately.</p>
        <label>Minimum pause between navigation rounds (seconds)<input type="number" min={3} max={300} value={draft.keepAlive.minActionSeconds} onChange={(e) => patchKeepAlive({ minActionSeconds: Number(e.target.value) })} /></label>
        <label>Maximum pause between navigation rounds (seconds)<input type="number" min={3} max={600} value={draft.keepAlive.maxActionSeconds} onChange={(e) => patchKeepAlive({ maxActionSeconds: Number(e.target.value) })} /></label>
        <label>Maximum internal article hops per rotation<input type="number" min={0} max={1000} value={draft.keepAlive.maxArticleHops} onChange={(e) => patchKeepAlive({ maxArticleHops: Math.min(1000, Math.max(0, Math.floor(Number(e.target.value) || 0))) })} /><small>Range: 0–1000. 0 keeps scroll activity but disables internal article-link clicks.</small></label>
        <div className="info-box"><strong>Same-site navigation only</strong><p>Keep Alive follows internal HTTP/HTTPS links from the current site's article/main content. Login, account, checkout, download, subscription, privacy and terms links are excluded.</p></div>
      </section>

      <section className="panel setting-section"><h2>Application</h2>
        <label>Theme<select value={draft.theme} onChange={(e) => patchDraft({ theme: e.target.value as 'dark' | 'light' | 'system' })}><option value="dark">Dark</option><option value="light">Light</option><option value="system">System</option></select></label>
        {diagnostics && <div className="diagnostics"><div><span>App</span><b>{diagnostics.appVersion}</b></div><div><span>Electron control UI</span><b>{diagnostics.electronVersion}</b></div><div><span>Playwright</span><b>{diagnostics.playwrightVersion ?? 'Unavailable'}</b></div><div><span>Node</span><b>{diagnostics.nodeVersion}</b></div><div><span>Platform</span><b>{diagnostics.platform} / {diagnostics.arch}</b></div></div>}
      </section>
    </div>
    <div className="settings-bottom-save"><button className="primary" disabled={!dirty || saving} onClick={() => void saveAll()}>{saving ? 'Saving…' : 'Save settings'}</button></div>
  </main>;
}


