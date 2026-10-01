import { FormEvent, useEffect, useMemo, useState } from 'react';
import type { WorkspaceState } from '../../shared/types/workspace';
import { parseBrowserSelection } from '../../shared/browserSelection';
import { distributeSavedUrls, parseSavedUrlPool } from '../../shared/urlPool';
import { useAppStore } from '../stores/appStore';
import { CUSTOM_PROXY_API_URL, type ProxyProvider } from '../../shared/proxySource';

type RouteRow = { key: number; browsers: string; url: string };

export function CentralControlPanel() {
  const workspaces = useAppStore((s) => s.workspaces);
  const proxies = useAppStore((s) => s.proxies);
  const settings = useAppStore((s) => s.settings);
  const updateSettings = useAppStore((s) => s.updateSettings);
  const fetchRemote = useAppStore((s) => s.fetchRemote);
  const savedUrlPool = settings?.savedUrlPool;
  const [targets, setTargets] = useState<Record<number, string>>({});
  const [bulkUrl, setBulkUrl] = useState('');
  const [urlPoolText, setUrlPoolText] = useState('');
  const [selected, setSelected] = useState<Set<number>>(new Set());
  const [routes, setRoutes] = useState<RouteRow[]>([
    { key: 1, browsers: '1', url: '' },
    { key: 2, browsers: '2', url: '' }
  ]);
  const [routeKey, setRouteKey] = useState(3);
  const [busy, setBusy] = useState('');
  const [message, setMessage] = useState('');
  const provider: ProxyProvider = 'private-api';

  useEffect(() => {
    const currentWorkspaces = useAppStore.getState().workspaces;
    setTargets(Object.fromEntries(currentWorkspaces.map((w) => [w.id, w.targetUrl])));
  }, [workspaces.length]);

  useEffect(() => {
    const currentWorkspaces = useAppStore.getState().workspaces;
    setSelected(new Set(currentWorkspaces.map((w) => w.id)));
  }, [workspaces.length]);

  useEffect(() => {
    if (savedUrlPool) setUrlPoolText(savedUrlPool.join('\n'));
  }, [savedUrlPool]);

  const validIds = useMemo(() => workspaces.map((workspace) => workspace.id), [workspaces]);
  const urlPoolStats = useMemo(() => {
    const lines = urlPoolText.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
    const seen = new Set<string>();
    let valid = 0;
    let invalid = 0;
    let duplicates = 0;

    for (const line of lines) {
      try {
        const [normalized] = parseSavedUrlPool(line);
        if (!normalized) continue;
        if (seen.has(normalized)) duplicates += 1;
        else {
          seen.add(normalized);
          valid += 1;
        }
      } catch {
        invalid += 1;
      }
    }

    return { lines: lines.length, valid, invalid, duplicates };
  }, [urlPoolText]);
  const urlPoolRows = Math.min(6, Math.max(2, urlPoolStats.lines || 2));

  const toggleSelected = (id: number, checked: boolean) => {
    setSelected((previous) => {
      const next = new Set(previous);
      if (checked) next.add(id); else next.delete(id);
      return next;
    });
  };

  const selectAll = () => setSelected(new Set(validIds));
  const selectNone = () => setSelected(new Set());


  const startProxyProcess = async () => {
    setBusy('proxy-process');
    setMessage('');
    try {
      const result = await fetchRemote(provider);
      setMessage('Private API: loaded ' + result.valid + ' proxy endpoints and assigned them directly. No validation was performed.');
    } catch (error) {
      setMessage(error instanceof Error ? error.message : String(error));
    } finally {
      setBusy('');
    }
  };

  const applyAll = async () => {
    setBusy('apply');
    setMessage('');
    try {
      await window.proxydesk.central.applyTargets(workspaces.map((w) => ({ id: w.id, url: targets[w.id] ?? w.targetUrl })));
      setMessage(`Applied ${workspaces.length} slot target${workspaces.length === 1 ? '' : 's'}.`);
    } catch (error) {
      setMessage(error instanceof Error ? error.message : String(error));
    } finally { setBusy(''); }
  };

  const openBulkUrl = async (event: FormEvent) => {
    event.preventDefault();
    if (!bulkUrl.trim() || selected.size === 0) return;
    setBusy('bulk');
    setMessage('');
    const ids = [...selected].sort((a, b) => a - b);
    try {
      await window.proxydesk.central.applyTargets(ids.map((id) => ({ id, url: bulkUrl.trim() })));
      setTargets((current) => {
        const next = { ...current };
        for (const id of ids) next[id] = bulkUrl.trim();
        return next;
      });
      setMessage(`Assigned the URL to ${ids.length} selected slot${ids.length === 1 ? '' : 's'}.`);
    } catch (error) {
      setMessage(error instanceof Error ? error.message : String(error));
    } finally { setBusy(''); }
  };



  const saveUrlPool = async (): Promise<string[]> => {
    const urls = parseSavedUrlPool(urlPoolText);
    if (!urls.length) throw new Error('Paste at least one website link before saving.');
    await updateSettings({ savedUrlPool: urls });
    setUrlPoolText(urls.join('\n'));
    return urls;
  };

  const clearUrlPool = async () => {
    setBusy('pool-clear');
    setMessage('');
    try {
      await updateSettings({ savedUrlPool: [] });
      setUrlPoolText('');
      setMessage('Saved website link pool cleared.');
    } catch (error) {
      setMessage(error instanceof Error ? error.message : String(error));
    } finally { setBusy(''); }
  };

  const randomizeUrlPool = async () => {
    if (selected.size === 0) return;
    setBusy('pool-random');
    setMessage('');
    try {
      const urls = await saveUrlPool();
      const assignments = distributeSavedUrls([...selected], urls);
      await window.proxydesk.central.applyTargets(assignments);
      setTargets((current) => {
        const next = { ...current };
        for (const assignment of assignments) next[assignment.id] = assignment.url;
        return next;
      });
      const perUrl = new Map<string, number>();
      for (const assignment of assignments) perUrl.set(assignment.url, (perUrl.get(assignment.url) ?? 0) + 1);
      const summary = [...perUrl.values()].sort((a, b) => b - a).join('/');
      setMessage(`Randomly distributed ${urls.length} saved link${urls.length === 1 ? '' : 's'} across ${assignments.length} slot${assignments.length === 1 ? '' : 's'}${summary ? ` (${summary} slot assignments per link)` : ''}.`);
    } catch (error) {
      setMessage(error instanceof Error ? error.message : String(error));
    } finally { setBusy(''); }
  };

  const persistUrlPoolOnly = async () => {
    setBusy('pool-save');
    setMessage('');
    try {
      const urls = await saveUrlPool();
      setMessage(`Saved ${urls.length} website link${urls.length === 1 ? '' : 's'} for random distribution.`);
    } catch (error) {
      setMessage(error instanceof Error ? error.message : String(error));
    } finally { setBusy(''); }
  };

  const addRoute = () => {
    setRoutes((current) => [...current, { key: routeKey, browsers: '', url: '' }]);
    setRouteKey((current) => current + 1);
  };

  const updateRoute = (key: number, patch: Partial<RouteRow>) => {
    setRoutes((current) => current.map((route) => route.key === key ? { ...route, ...patch } : route));
  };

  const removeRoute = (key: number) => setRoutes((current) => current.filter((route) => route.key !== key));

  const startSelected = async () => {
    if (selected.size === 0) return;
    setBusy('start-selected');
    setMessage('');
    const ids = [...selected].sort((a, b) => a - b);
    try {
      await window.proxydesk.central.applyTargets(ids.map((id) => ({ id, url: targets[id] ?? workspaces.find((workspace) => workspace.id === id)?.targetUrl ?? '' })));
      await Promise.all(ids.map((id) => window.proxydesk.workspace.launch(id)));
      setMessage(`Started ${ids.length} selected slot${ids.length === 1 ? '' : 's'}. A positive rotation interval runs automatic Keep Alive independently in every selected slot until rotation, then closes that slot, changes its proxy and immediately starts its next session. Rotation 0 performs one landing visit.`);
    } catch (error) {
      setMessage(error instanceof Error ? error.message : String(error));
    } finally { setBusy(''); }
  };

  const stopSelected = async () => {
    if (selected.size === 0) return;
    setBusy('stop-selected');
    setMessage('');
    const ids = [...selected].sort((a, b) => a - b);
    try {
      await Promise.all(ids.map((id) => window.proxydesk.workspace.stop(id)));
      setMessage(`Stopped ${ids.length} selected slot${ids.length === 1 ? '' : 's'}. Any active temporary Chromium session was closed.`);
    } catch (error) {
      setMessage(error instanceof Error ? error.message : String(error));
    } finally { setBusy(''); }
  };

  const dispatchRoutes = async () => {
    setBusy('routes');
    setMessage('');
    try {
      const entries: Array<{ id: number; url: string }> = [];
      const claimed = new Map<number, number>();
      for (const route of routes) {
        if (!route.url.trim() || !route.browsers.trim()) continue;
        const ids = parseBrowserSelection(route.browsers, validIds);
        if (!ids.length) throw new Error(`Route ${route.key} does not contain any active browser IDs.`);
        for (const id of ids) {
          const previous = claimed.get(id);
          if (previous !== undefined) throw new Error(`Browser ${id} is assigned to both Route ${previous} and Route ${route.key}. Each slot can receive only one URL in the same dispatch.`);
          claimed.set(id, route.key);
          entries.push({ id, url: route.url.trim() });
        }
      }
      if (!entries.length) throw new Error('Add at least one route with a URL and browser selection.');
      await window.proxydesk.central.applyTargets(entries);
      setTargets((current) => {
        const next = { ...current };
        for (const entry of entries) next[entry.id] = entry.url;
        return next;
      });
      const activeRouteCount = routes.filter((route) => route.url.trim() && route.browsers.trim()).length;
      setMessage(`Dispatched ${new Set(entries.map((entry) => entry.id)).size} slots across ${activeRouteCount} URL route${activeRouteCount === 1 ? '' : 's'}.`);
    } catch (error) {
      setMessage(error instanceof Error ? error.message : String(error));
    } finally { setBusy(''); }
  };

  return <>
    <section className="panel control-hero central-dispatcher">
      <div className="control-hero-copy">
        <span className="eyebrow">CENTRAL URL CONTROL</span>
        <h1>{workspaces.length} lightweight slots. One control center.</h1>
        <p>Assign URLs to selected logical slots without launching Chromium. Slots consume little RAM while stopped. When Start is pressed, every selected slot launches Chromium immediately and runs independently.</p>
      </div>
      <div className="central-tools">
        <form className="central-tool" onSubmit={openBulkUrl}>
          <label>Assign one URL to selected slots</label>
          <div className="search-row"><input value={bulkUrl} onChange={(e) => setBulkUrl(e.target.value)} placeholder="https://example.com/article" /><button className="primary" disabled={Boolean(busy) || selected.size === 0 || !bulkUrl.trim()}>{busy === 'bulk' ? 'Assigning…' : `Assign to ${selected.size}`}</button></div>
        </form>
      </div>
      <div className="central-selector-block">
        <div className="selector-head"><strong>Selected slots</strong><div className="action-row"><button type="button" onClick={selectAll}>All</button><button type="button" onClick={selectNone}>None</button></div></div>
        <div className="browser-selector central-browser-selector">{workspaces.map((w) => <label key={w.id}><input type="checkbox" checked={selected.has(w.id)} onChange={(e) => toggleSelected(w.id, e.target.checked)} />{w.id}</label>)}</div>
      </div>
      {message && <div className="central-message">{message}</div>}
    </section>


    <section className="panel proxy-provider-panel">
      <div className="control-table-head">
        <div>
          <span className="eyebrow">PROXY SOURCE</span>
          <h2>Private API · direct assignment</h2>
          <p>The app fetches the proxy pool directly from <span className="mono">{CUSTOM_PROXY_API_URL}</span>, deduplicates it, and assigns proxies without validation. No browser is allowed to start without a proxy.</p>
        </div>
        <div className="action-row">
          <button className="primary" disabled={Boolean(busy)} onClick={() => void startProxyProcess()}>{busy === 'proxy-process' ? 'Refreshing…' : 'Refresh proxy pool'}</button>
        </div>
      </div>
      <div className="provider-status-grid">
        <div><strong>{proxies.filter((proxy) => proxy.status === 'working').length}</strong><small>available</small></div>
        <div><strong>{workspaces.filter((workspace) => Boolean(workspace.proxy)).length}</strong><small>assigned</small></div>
      </div>
      <small>The pool refreshes again for each new rotation cycle. Failed proxies are excluded from the current cycle and replaced immediately when another unused proxy is available.</small>
    </section>

    <section className="panel url-pool-panel">
      <div className="control-table-head">
        <div><h2>Saved random website pool</h2><p>Paste one website link per line and save it. Random distribution uses the slot selection above. Distribution is memory-only and does not launch Chromium. If slots outnumber links, Social SEO repeats the saved links only after every link has been used once in that cycle.</p></div>
        <div className="action-row"><button disabled={Boolean(busy)} onClick={() => void persistUrlPoolOnly()}>{busy === 'pool-save' ? 'Saving…' : 'Save links'}</button><button className="primary" disabled={Boolean(busy) || selected.size === 0 || !urlPoolText.trim()} onClick={() => void randomizeUrlPool()}>{busy === 'pool-random' ? 'Distributing…' : `Random distribute to ${selected.size}`}</button><button className="danger-ghost" disabled={Boolean(busy) || (!urlPoolText.trim() && !(settings?.savedUrlPool.length))} onClick={() => void clearUrlPool()}>Clear saved</button></div>
      </div>
      <div className="url-pool-grid">
        <label className="url-pool-input">
          <span>Website URL Pool</span>
          <small>One complete URL per row. The field stays compact; long URLs remain on one line and scroll horizontally.</small>
          <textarea
            className="url-pool-textarea"
            rows={urlPoolRows}
            wrap="off"
            spellCheck={false}
            value={urlPoolText}
            onChange={(e) => setUrlPoolText(e.target.value)}
            placeholder={'https://example.com/article-a\nhttps://example.com/article-b'}
          />
          <div className="url-pool-entry-meta">
            <span>{urlPoolStats.lines} entered line{urlPoolStats.lines === 1 ? '' : 's'}</span>
            <span className="ok-text">{urlPoolStats.valid} valid unique URL{urlPoolStats.valid === 1 ? '' : 's'}</span>
            {urlPoolStats.duplicates > 0 && <span>{urlPoolStats.duplicates} duplicate{urlPoolStats.duplicates === 1 ? '' : 's'}</span>}
            {urlPoolStats.invalid > 0 && <span className="error-text">{urlPoolStats.invalid} invalid line{urlPoolStats.invalid === 1 ? '' : 's'}</span>}
          </div>
        </label>
        <div className="url-pool-info">
          <strong>{settings?.savedUrlPool.length ?? 0} saved link{(settings?.savedUrlPool.length ?? 0) === 1 ? '' : 's'}</strong>
          <p>Example: 5 selected slots + 2 saved links → all 5 slots receive a URL; the two links are shuffled and repeated across the remaining slots.</p>
          <small>The saved URL pool is application configuration and persists across app restarts. It does not save browser cookies, cache or proxy data.</small>
        </div>
      </div>
    </section>

    <section className="panel route-planner-panel">
      <div className="control-table-head">
        <div><h2>Multi-URL router</h2><p>Assign a different URL to each slot group. Slot syntax accepts ranges such as <span className="mono">1-5,8,10</span>.</p></div>
        <div className="action-row"><button onClick={addRoute}>+ Add route</button><button className="primary" disabled={Boolean(busy)} onClick={() => void dispatchRoutes()}>{busy === 'routes' ? 'Dispatching…' : 'Run all routes'}</button></div>
      </div>
      <div className="route-list">
        {routes.map((route, index) => {
          const parsed = parseBrowserSelection(route.browsers, validIds);
          return <div className="route-row" key={route.key}>
            <div className="route-number">{index + 1}</div>
            <label><span>Slots</span><input value={route.browsers} onChange={(e) => updateRoute(route.key, { browsers: e.target.value })} placeholder="1-5,8,10" /><small>{parsed.length ? `${parsed.length} selected` : 'No active slots selected'}</small></label>
            <label className="route-url"><span>URL</span><input value={route.url} onChange={(e) => updateRoute(route.key, { url: e.target.value })} placeholder="https://example.com/page" /></label>
            <button className="danger-ghost route-remove" disabled={routes.length === 1} onClick={() => removeRoute(route.key)}>Remove</button>
          </div>;
        })}
      </div>
    </section>

    <section className="panel control-table-panel">
      <div className="control-table-head"><div><h2>Logical slot targets</h2><p>The central timer from Settings applies to every slot. With a positive interval, Start opens the target and automatically enters Keep Alive: 2 down/up scroll cycles, an internal same-origin article click, then 2–3 scroll cycles and another article click, repeating until the proxy-rotation deadline. Chromium closes at rotation, the proxy changes, and that slot immediately starts a fresh session. All started slots run concurrently with no queue. Rotation 0 performs one landing visit only. Change the timer in Settings and click Save settings to update every slot.</p></div><div className="action-row"><button disabled={Boolean(busy)} onClick={() => void applyAll()}>{busy === 'apply' ? 'Applying…' : 'Apply all row URLs'}</button><button className="primary" disabled={Boolean(busy) || selected.size === 0} onClick={() => void startSelected()}>{busy === 'start-selected' ? 'Starting…' : `Start selected (${selected.size})`}</button><button className="danger-ghost" disabled={Boolean(busy) || selected.size === 0} onClick={() => void stopSelected()}>{busy === 'stop-selected' ? 'Stopping…' : `Stop selected (${selected.size})`}</button></div></div>
      <div className="control-table-wrap"><table className="control-table">
        <thead><tr><th>#</th><th>Worker</th><th>Website target</th><th>Proxy</th><th>Global Keep Alive / rotate</th><th>Status</th><th>Runs / hops</th><th>Actions</th></tr></thead>
        <tbody>{workspaces.map((w) => <ControlRow key={w.id} workspace={w} proxies={proxies} target={targets[w.id] ?? w.targetUrl} globalRotationSeconds={settings?.defaultRotationSeconds ?? w.rotationSeconds} onTarget={(value) => setTargets((current) => ({ ...current, [w.id]: value }))} />)}</tbody>
      </table></div>
    </section>
  </>;
}

function ControlRow({ workspace, proxies, target, globalRotationSeconds, onTarget }: {
  workspace: WorkspaceState;
  proxies: Array<{ id: string; host: string; port: number; protocol: string; status: string }>;
  target: string;
  globalRotationSeconds: number;
  onTarget(value: string): void;
}) {
  const [actionBusy, setActionBusy] = useState<'start' | 'stop' | ''>('');
  const active = ['waiting_proxy', 'launching', 'loading', 'running', 'rotating'].includes(workspace.status);
  const saveTarget = async () => window.proxydesk.workspace.setTarget(workspace.id, target);
  const start = async () => {
    setActionBusy('start');
    try {
      await saveTarget();
      await window.proxydesk.workspace.launch(workspace.id);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (!message.includes('stopped by user')) console.error(message);
    } finally { setActionBusy(''); }
  };
  const stop = async () => {
    setActionBusy('stop');
    try { await window.proxydesk.workspace.stop(workspace.id); }
    finally { setActionBusy(''); }
  };
  return <tr>
    <td><strong>{workspace.id}</strong></td>
    <td><strong>Chromium on demand</strong></td>
    <td><div className="target-cell"><input value={target} onChange={(e) => onTarget(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter') void saveTarget(); }} /><button onClick={() => void saveTarget()}>Save URL</button></div></td>
    <td><select className="proxy-select" value={workspace.proxy?.id ?? ''} onChange={(e) => void window.proxydesk.proxy.assignOne(workspace.id, e.target.value || undefined)}><option value="">No live proxy assigned</option>{proxies.filter((proxy) => proxy.status === 'working').map((proxy) => <option key={proxy.id} value={proxy.id}>{proxy.protocol.toUpperCase()} · {proxy.host}:{proxy.port} · live</option>)}</select></td>
    <td><div className="global-rotation-cell"><strong>{globalRotationSeconds}s</strong><small>Settings</small></div></td>
    <td><span className={`pill ${workspace.status}`}>{workspace.keepAlive ? 'keep alive' : workspace.status}</span>{workspace.error && <small className="slot-error" title={workspace.error}>{workspace.error}</small>}</td>
    <td><div className="run-meta"><strong>{workspace.runCount ?? 0}</strong><small>{workspace.visitedLinks} hop{workspace.visitedLinks === 1 ? '' : 's'}</small>{workspace.lastRunAt && <small title={workspace.lastRunAt}>{new Date(workspace.lastRunAt).toLocaleTimeString()}</small>}</div></td>
    <td><div className="mini-actions"><button className="primary" disabled={active || Boolean(actionBusy)} onClick={() => void start()}>{actionBusy === 'start' ? 'Starting…' : 'Start'}</button><button className="danger-ghost" disabled={!active || Boolean(actionBusy)} onClick={() => void stop()}>{actionBusy === 'stop' ? 'Stopping…' : 'Stop'}</button><button onClick={() => void window.proxydesk.workspace.rotateProxy(workspace.id)}>Rotate proxy</button><button className="danger-ghost" onClick={() => void window.proxydesk.workspace.clearData([workspace.id])}>Reset slot</button></div></td>
  </tr>;
}

