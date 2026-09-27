import { useEffect, useMemo, useState } from 'react';
import {
  PROXY_PROVIDER_IDS,
  PROXY_PROVIDER_LABELS,
  type ProxyProviderId
} from '../../shared/types/automation';
import { useAppStore } from '../stores/appStore';

export function SeoTrackerPanel(): JSX.Element {
  const automation = useAppStore((state) => state.automation);
  const browsers = useAppStore((state) => state.browsers);
  const results = useAppStore((state) => state.results);
  const clearResults = useAppStore((state) => state.clearResults);
  const pushToast = useAppStore((state) => state.pushToast);

  const [query, setQuery] = useState('');
  const [proxySource, setProxySource] = useState<ProxyProviderId>('proxyscrape');
  const [targetWebsite, setTargetWebsite] = useState('');
  const [controlledTestHost, setControlledTestHost] = useState('');
  const [intervalSec, setIntervalSec] = useState(600);
  const [browserCount, setBrowserCount] = useState(10);
  const [maxPages, setMaxPages] = useState(20);
  const [starting, setStarting] = useState(false);

  useEffect(() => {
    if (!automation) return;
    if (automation.query) setQuery(automation.query);
    setProxySource(automation.proxySource);
    if (automation.targetWebsite) setTargetWebsite(automation.targetWebsite);
    setControlledTestHost(automation.controlledTestHost ?? '');
    setIntervalSec(automation.intervalSec);
    setBrowserCount(automation.browserCount);
    setMaxPages(automation.maxPages);
  }, [automation]);

  const running = automation?.running ?? false;
  const nextCycle = automation?.nextCycleAt
    ? new Date(automation.nextCycleAt).toLocaleTimeString()
    : '—';

  const resultRows = useMemo(
    () =>
      Object.values(results)
        .sort((a, b) => a.browserId - b.browserId),
    [results]
  );

  async function start(): Promise<void> {
    if (!query.trim() || !targetWebsite.trim()) {
      pushToast('Enter both a keyword and target website.', 'error');
      return;
    }

    clearResults();
    setStarting(true);
    try {
      await window.app.automation.start({
        query: query.trim(),
        proxySource,
        targetWebsite: targetWebsite.trim(),
        controlledTestHost: controlledTestHost.trim() || undefined,
        intervalSec,
        browserCount,
        maxPages
      });
      pushToast('SEO Tracker started.', 'success');
    } catch (err) {
      pushToast(`Could not start SEO Tracker: ${(err as Error).message}`, 'error');
    } finally {
      setStarting(false);
    }
  }

  async function stop(): Promise<void> {
    await window.app.automation.stop();
    pushToast('SEO Tracker stopped.', 'info');
  }

  async function runNow(): Promise<void> {
    try {
      await window.app.automation.runNow();
      pushToast('Rotation cycle requested.', 'info');
    } catch (err) {
      pushToast((err as Error).message, 'error');
    }
  }

  return (
    <section className="seo-tracker">
      <div className="seo-tracker__title">
        <div>
          <h1>ProxyDesk SEO Tracker</h1>
          <p>
            Fail-closed browser sessions → selected proxy provider → validation → Google target
            detection → click + landing verification → Keep Alive → scheduled rotation.
          </p>
        </div>
        <span className={running || starting ? 'tracker-pill tracker-pill--on' : 'tracker-pill'}>
          {starting
            ? 'STARTING'
            : running
              ? (automation?.cycleInProgress ? 'RUNNING' : 'WAITING')
              : 'STOPPED'}
        </span>
      </div>

      <div className="tracker-controls">
        <label>
          Proxy provider
          <select
            value={proxySource}
            disabled={running}
            onChange={(event) => setProxySource(event.target.value as ProxyProviderId)}
          >
            {PROXY_PROVIDER_IDS.map((provider) => (
              <option key={provider} value={provider}>
                {PROXY_PROVIDER_LABELS[provider]}
              </option>
            ))}
          </select>
        </label>

        <label>
          Keywords (comma separated)
          <input
            value={query}
            disabled={running}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="keyword A, keyword B, keyword C"
          />
        </label>

        <label>
          Target website
          <input
            value={targetWebsite}
            disabled={running}
            onChange={(event) => setTargetWebsite(event.target.value)}
            placeholder="seo-test.appareldiary.com"
          />
        </label>

        <label>
          Interaction host (optional)
          <input
            value={controlledTestHost}
            disabled={running}
            onChange={(event) => setControlledTestHost(event.target.value)}
            placeholder="Leave blank to use Target website"
          />
        </label>

        <label>
          Browsers
          <input
            type="number"
            min={1}
            max={100}
            value={browserCount}
            disabled={running}
            onChange={(event) => setBrowserCount(Number(event.target.value))}
          />
        </label>

        <label>
          Max Google pages
          <input
            type="number"
            min={1}
            max={100}
            value={maxPages}
            disabled={running}
            onChange={(event) => setMaxPages(Number(event.target.value))}
          />
        </label>

        <label>
          Rotation interval (sec)
          <input
            type="number"
            min={30}
            max={86400}
            value={intervalSec}
            disabled={running}
            onChange={(event) => setIntervalSec(Number(event.target.value))}
          />
        </label>
      </div>

      <div className="tracker-actions">
        <button className="btn-primary" disabled={running || starting} onClick={() => void start()}>
          {starting ? 'Starting…' : 'Start SEO Tracker'}
        </button>
        <button disabled={!running || automation?.cycleInProgress} onClick={() => void runNow()}>
          Rotate / Run Now
        </button>
        <button disabled={!running} onClick={() => void stop()}>
          Stop SEO Tracker
        </button>
        <button onClick={() => void window.app.browser.setKeepAliveAll(true)}>
          Keep Alive All
        </button>
        <button onClick={() => void window.app.browser.setKeepAliveAll(false)}>
          Stop Keep Alive
        </button>
      </div>

      <div className="tracker-status">
        <span>
          Source <strong>{PROXY_PROVIDER_LABELS[automation?.proxySource ?? proxySource]}</strong>
        </span>
        <span>Cycle <strong>{automation?.cycleNumber ?? 0}</strong></span>
        <span>Keyword <strong>{automation?.currentQuery || '—'}</strong></span>
        <span>Fetched <strong>{automation?.fetchedProxies ?? 0}</strong></span>
        <span>
          Validated <strong>{automation?.checkedProxies ?? 0}/{automation?.totalProxies ?? 0}</strong>
        </span>
        <span>Live <strong>{automation?.liveProxies ?? 0}</strong></span>
        <span>
          Assigned <strong>{automation?.assignedBrowsers ?? 0}/{automation?.browserIds.length ?? 0}</strong>
        </span>
        <span>Next rotation <strong>{nextCycle}</strong></span>
      </div>

      {automation?.lastError && (
        <div className="tracker-error">{automation.lastError}</div>
      )}

      <div className="tracker-note">
        Browsers are fail-closed: without a validated proxy they remain on about:blank behind
        an unreachable local route, never the direct network. If a proxy fails inside Chromium,
        it is quarantined and replaced with another unassigned live proxy. Comma-separated
        keywords advance one per cycle and wrap after the last keyword. When the saved target is
        detected in Google, ProxyDesk clicks that detected result, verifies the target host opened,
        then runs the existing Keep Alive scroll and same-site article-hop loop until rotation.
      </div>

      <div className="tracker-results">
        <h2>SEO results</h2>
        <table>
          <thead>
            <tr>
              <th>Browser</th>
              <th>Proxy</th>
              <th>Status</th>
              <th>Google page</th>
              <th>Article</th>
              <th>Action</th>
              <th>Keep Alive</th>
            </tr>
          </thead>
          <tbody>
            {resultRows.map((result) => {
              const browser = browsers[result.browserId];
              const proxy = browser?.proxy;
              return (
                <tr key={result.browserId}>
                  <td>Browser {result.browserId}</td>
                  <td>{proxy ? `${proxy.host}:${proxy.port}` : '—'}</td>
                  <td className={result.status === 'matched' ? 'status-ok' : result.status === 'error' ? 'status-bad' : ''}>
                    {result.status}
                    {result.error ? ` — ${result.error}` : ''}
                  </td>
                  <td>{result.resultPage ?? '—'}</td>
                  <td title={result.matchedUrl ?? result.landedUrl}>
                    {result.matchedTitle ?? result.matchedUrl ?? result.landedUrl ?? '—'}
                  </td>
                  <td className={result.interactionStatus === 'click-failed' ? 'status-bad' : result.interactionStatus === 'opened' ? 'status-ok' : ''}>
                    {result.interactionStatus ?? (result.status === 'matched' ? 'detected' : '—')}
                  </td>
                  <td>{browser?.keepAliveEnabled || result.keepAliveStarted ? 'Active' : 'Idle'}</td>
                </tr>
              );
            })}
            {resultRows.length === 0 && (
              <tr>
                <td colSpan={7} className="muted">No completed browser searches yet.</td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </section>
  );
}
