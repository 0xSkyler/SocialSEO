$ErrorActionPreference = "Stop"
$root = "buildsrc\Social-SEO"

function Read-Text([string]$rel) { Get-Content (Join-Path $root $rel) -Raw }
function Write-Text([string]$rel, [string]$value) { Set-Content -Path (Join-Path $root $rel) -Value $value -Encoding utf8 }
function Replace-Once([string]$text, [string]$pattern, [string]$replacement, [string]$label) {
  $rx = [regex]::new($pattern, [System.Text.RegularExpressions.RegexOptions]::Singleline)
  if (-not $rx.IsMatch($text)) { throw "Patch point not found: $label" }
  $rx.Replace($text, $replacement, 1)
}

$proxySource = @'
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

export const CUSTOM_PROXY_API_URL = 'http://169.58.35.69/data/high.txt';

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
'@
Write-Text "src\shared\proxySource.ts" $proxySource

$sm = Read-Text "src\main\SettingsManager.ts"
$sm = $sm.Replace("allowProxyReuse: true,", "allowProxyReuse: false,")
$sm = $sm.Replace("validateBeforeAssign: true,", "validateBeforeAssign: false,")
$sm = $sm.Replace("autoStartOnImport: true,", "autoStartOnImport: false,")
$validationBlock = @'
      // 4.5.0 trusts the private proxy API. No validation is performed.
      validateBeforeAssign: false,
      autoStartOnImport: false,
      assignWorkingImmediately: true,
      timeoutSeconds: 3,
      attempts: 1,
      concurrency: 1,
      maxLatencyMs: 0
'@
$sm = Replace-Once $sm '// 4\.4\.1 Fast validation is intentionally simple and fixed\.[\s\S]*?maxLatencyMs: 0' $validationBlock "Settings validation block"
Write-Text "src\main\SettingsManager.ts" $sm

$pm = Read-Text "src\main\ProxyManager.ts"

$oldState = @'
  private lastPurgedBrowserCycle = 0;
'@
$newState = @'
  private lastPurgedBrowserCycle = 0;
  private currentPoolIds = new Set<string>();
  private lastFetchedBrowserCycle = 0;
  private refreshPromise?: Promise<void>;
'@
if (-not $pm.Contains($oldState.Trim())) { throw "Patch point not found: proxy pool state" }
$pm = $pm.Replace($oldState.Trim(), $newState.Trim())

$oldEligible = @'
  private eligiblePool(): ProxyRecord[] {
    return [...this.validatedStore.values()].filter((proxy) => proxy.status === 'working');
  }
'@
$newEligible = @'
  private eligiblePool(): ProxyRecord[] {
    return [...this.validatedStore.values()].filter((proxy) =>
      proxy.status === 'working'
      && (this.currentPoolIds.size === 0 || this.currentPoolIds.has(proxy.id))
    );
  }
'@
$pm = Replace-Once $pm '  private eligiblePool\(\): ProxyRecord\[\] \{[\s\S]*?\r?\n  \}' $newEligible "eligiblePool"

$oldImported = @'
    this.lastImportedIds = [...new Set(touchedIds)];
    return {
'@
$newImported = @'
    this.lastImportedIds = [...new Set(touchedIds)];
    for (const id of this.lastImportedIds) {
      const index = this.proxies.findIndex((proxy) => proxy.id === id);
      if (index < 0) continue;
      const trusted = {
        ...this.proxies[index]!,
        status: 'working' as const,
        latencyMs: undefined,
        lastCheckedAt: undefined,
        lastError: undefined
      };
      this.proxies[index] = trusted;
      this.validatedStore.set(id, { ...trusted });
    }
    return {
'@
$pm = Replace-Once $pm '    this\.lastImportedIds = \[\.\.\.new Set\(touchedIds\)\];\r?\n    return \{' $newImported "trusted import"

$oldImportResult = @'
    const result = this.mergeProxyText(text, source, true);
    this.validationProgress = this.emptyProgress();
'@
$newImportResult = @'
    const result = this.mergeProxyText(text, source, true);
    this.currentPoolIds = new Set(this.lastImportedIds);
    this.validationProgress = this.emptyProgress();
    this.validationProgress.total = this.currentPoolIds.size;
    this.validationProgress.completed = this.currentPoolIds.size;
    this.validationProgress.working = this.currentPoolIds.size;
'@
$pm = Replace-Once $pm '    const result = this\.mergeProxyText\(text, source, true\);\r?\n    this\.validationProgress = this\.emptyProgress\(\);' $newImportResult "import pool state"

$fetchProviderText = @'
  private async fetchProviderText(_provider: ProxyProvider): Promise<{ text: string; label: string }> {
    const definition = getProxyProvider('private-api');
    const text = await this.fetchText(definition.feeds[0]!.url);
    return { text, label: definition.label };
  }

  async fetchProvider
'@
$pm = Replace-Once $pm '  private async fetchProviderText\(provider: ProxyProvider\): Promise<\{ text: string; label: string \}> \{[\s\S]*?\r?\n  \}\r?\n\r?\n  async fetchProvider' $fetchProviderText "single private API"

$oldFetchResult = @'
    const result = await this.importText(fetched.text, fetched.label);
    this.lastProviderRefreshAt = Date.now();
    return result;
'@
$newFetchResult = @'
    const result = await this.importText(fetched.text, fetched.label);
    this.currentPoolIds = new Set(this.lastImportedIds);
    this.lastProviderRefreshAt = Date.now();
    return result;
'@
$pm = Replace-Once $pm '    const result = await this\.importText\(fetched\.text, fetched\.label\);\r?\n    this\.lastProviderRefreshAt = Date\.now\(\);\r?\n    return result;' $newFetchResult "fetchProvider result"

$cycleBlock = @'
  noteCompletedBrowserCycle(_cycleNumber: number): boolean {
    return false;
  }

  private async refreshCurrentPool(): Promise<void> {
    const fetched = await this.fetchProviderText('private-api');
    const assigned = this.assignedProxyIds();
    this.mergeProxyText(fetched.text, fetched.label, true);
    const freshIds = new Set(this.lastImportedIds);
    this.currentPoolIds = freshIds;

    this.proxies = this.proxies.filter((proxy) => freshIds.has(proxy.id) || assigned.has(proxy.id));
    for (const id of [...this.validatedStore.keys()]) {
      if (!freshIds.has(id) && !assigned.has(id)) this.validatedStore.delete(id);
    }

    this.lastProviderRefreshAt = Date.now();
    this.validationProgress.total = freshIds.size;
    this.validationProgress.completed = freshIds.size;
    this.validationProgress.checking = 0;
    this.validationProgress.working = this.eligiblePool().length;
    this.validationProgress.dead = 0;
    this.validationProgress.assigned = this.assignments.filter((assignment) => Boolean(assignment.proxyId)).length;
    this.emitChanged();
    this.emitValidationProgress();
  }

  async refreshForBrowserCycle(cycleNumber: number): Promise<void> {
    const cycle = Math.max(1, Math.floor(Number(cycleNumber) || 1));
    if (cycle <= this.lastFetchedBrowserCycle) return;
    if (this.refreshPromise) {
      await this.refreshPromise;
      if (cycle <= this.lastFetchedBrowserCycle) return;
    }
    this.refreshPromise = (async () => {
      await this.refreshCurrentPool();
      this.lastFetchedBrowserCycle = Math.max(this.lastFetchedBrowserCycle, cycle);
    })();
    try {
      await this.refreshPromise;
    } finally {
      this.refreshPromise = undefined;
    }
  }

  startContinuousValidation
'@
$pm = Replace-Once $pm '  noteCompletedBrowserCycle\(cycleNumber: number\): boolean \{[\s\S]*?\r?\n  \}\r?\n\r?\n  startContinuousValidation' $cycleBlock "cycle refresh"

$startNoValidation = @'
  startContinuousValidation(
    _provider?: ProxyProvider,
    _onWorking?: (proxy: ProxyRecord) => void | Promise<void>
  ): void {
    this.stopContinuousValidation();
  }

  stopContinuousValidation
'@
$pm = Replace-Once $pm '  startContinuousValidation\([\s\S]*?\r?\n  \}\r?\n\r?\n  stopContinuousValidation' $startNoValidation "disable continuous validation"

$trustValidation = @'
  async validateStreaming(
    proxyIds?: string[],
    onWorking?: (proxy: ProxyRecord) => void | Promise<void>
  ): Promise<ProxyRecord[]> {
    const ids = proxyIds?.length ? new Set(proxyIds) : undefined;
    const targets = this.proxies.filter((proxy) => !ids || ids.has(proxy.id));
    this.validationProgress = {
      runId: randomUUID(),
      active: false,
      cancelled: false,
      total: targets.length,
      completed: targets.length,
      checking: 0,
      working: targets.length,
      dead: 0,
      assigned: this.assignments.filter((assignment) => Boolean(assignment.proxyId)).length,
      startedAt: new Date().toISOString(),
      finishedAt: new Date().toISOString()
    };
    for (const target of targets) {
      target.status = 'working';
      target.latencyMs = undefined;
      target.lastCheckedAt = undefined;
      target.lastError = undefined;
      this.validatedStore.set(target.id, { ...target });
      if (onWorking) await onWorking({ ...target });
    }
    this.emitChanged();
    this.emitValidationProgress();
    return this.getPublicList();
  }

  async validate(proxyIds?: string[]): Promise<ProxyRecord[]> {
'@
$pm = Replace-Once $pm '  async validateStreaming\([\s\S]*?\r?\n  \}\r?\n\r?\n  async validate\(proxyIds\?: string\[\]\): Promise<ProxyRecord\[]> \{' $trustValidation "trusted validation compatibility"

$replacementBlock = @'
  chooseReplacement(workspaceId: number): ProxyRecord | undefined {
    const currentId = this.assignments.find((item) => item.workspaceId === workspaceId)?.proxyId;
    const leasedElsewhere = this.assignedProxyIds(workspaceId);
    const candidate = this.eligiblePool().find((proxy) =>
      proxy.id !== currentId
      && !leasedElsewhere.has(proxy.id)
      && !this.usedThisCycle.has(proxy.id)
    );
    if (candidate) this.setAssignment(workspaceId, candidate.id);
    return candidate ? { ...candidate } : undefined;
  }

  async ensureWorkingProxy
'@
$pm = Replace-Once $pm '  chooseReplacement\(workspaceId: number\): ProxyRecord \| undefined \{[\s\S]*?\r?\n  \}\r?\n\r?\n  async ensureWorkingProxy' $replacementBlock "no reuse replacement"

$ensureBlock = @'
  async ensureWorkingProxy(workspaceId: number): Promise<ProxyRecord | undefined> {
    const current = this.getAssignedProxy(workspaceId);
    if (current?.status === 'working' && this.validatedStore.has(current.id)) return current;
    if (current) this.setAssignment(workspaceId, undefined);

    let replacement = this.chooseReplacement(workspaceId);
    if (replacement) return replacement;

    try {
      await this.refreshCurrentPool();
    } catch {
      return undefined;
    }
    replacement = this.chooseReplacement(workspaceId);
    return replacement;
  }

  syncBrowserCount
'@
$pm = Replace-Once $pm '  async ensureWorkingProxy\(workspaceId: number\): Promise<ProxyRecord \| undefined> \{[\s\S]*?\r?\n  \}\r?\n\r?\n  syncBrowserCount' $ensureBlock "ensure API proxy"

$oldClear = @'
    this.lastProviderRefreshAt = 0;
    this.emitChanged();
'@
$newClear = @'
    this.lastProviderRefreshAt = 0;
    this.currentPoolIds.clear();
    this.lastFetchedBrowserCycle = 0;
    this.refreshPromise = undefined;
    this.emitChanged();
'@
$pm = Replace-Once $pm '    this\.lastProviderRefreshAt = 0;\r?\n    this\.emitChanged\(\);' $newClear "clear state"
$pm = $pm.Replace("return this.fetchProvider('proxyscrape');", "return this.fetchProvider('private-api');")
$resetCycleBlock = @'
    this.refreshPromise = (async () => {
      this.resetProxyCycle();
      await this.refreshCurrentPool();
'@
$pm = Replace-Once $pm '    this\.refreshPromise = \(async \(\) => \{\r?\n      await this\.refreshCurrentPool\(\);' $resetCycleBlock "reset proxy usage per normal cycle"
$pm = $pm.Replace("const STORE_CYCLES_PER_GENERATION = 5;" + [Environment]::NewLine, "")
$pm = $pm.Replace("  private async fetchProviderText(_provider: ProxyProvider): Promise<{ text: string; label: string }> {" + [Environment]::NewLine, "  private async fetchProviderText(provider: ProxyProvider): Promise<{ text: string; label: string }> {" + [Environment]::NewLine + "    void provider;" + [Environment]::NewLine)
$pm = $pm.Replace("  noteCompletedBrowserCycle(_cycleNumber: number): boolean {" + [Environment]::NewLine + "    return false;", "  noteCompletedBrowserCycle(cycleNumber: number): boolean {" + [Environment]::NewLine + "    void cycleNumber;" + [Environment]::NewLine + "    return false;")
$pm = $pm.Replace("    _provider?: ProxyProvider," + [Environment]::NewLine + "    _onWorking?: (proxy: ProxyRecord) => void | Promise<void>" + [Environment]::NewLine + "  ): void {" + [Environment]::NewLine + "    this.stopContinuousValidation();", "    provider?: ProxyProvider," + [Environment]::NewLine + "    onWorking?: (proxy: ProxyRecord) => void | Promise<void>" + [Environment]::NewLine + "  ): void {" + [Environment]::NewLine + "    void provider;" + [Environment]::NewLine + "    void onWorking;" + [Environment]::NewLine + "    this.stopContinuousValidation();")
Write-Text "src\main\ProxyManager.ts" $pm

$pipeline = @'
import type { ProxyImportResult } from '../shared/types/proxy';
import type { ProxyProvider } from '../shared/proxySource';
import { ProxyManager } from './ProxyManager';
import { SettingsManager } from './SettingsManager';
import { WorkspaceManager } from './WorkspaceManager';

async function applyDirectPool(
  result: ProxyImportResult,
  proxies: ProxyManager,
  workspaces: WorkspaceManager
): Promise<ProxyImportResult> {
  const assignments = await proxies.buildAssignments();
  await workspaces.applyAssignments();
  return {
    ...result,
    assigned: assignments.filter((item) => Boolean(item.proxyId)).length
  };
}

export async function loadProxyTextPool(
  text: string,
  _settings: SettingsManager,
  proxies: ProxyManager,
  workspaces: WorkspaceManager,
  source = 'proxy.txt'
): Promise<ProxyImportResult> {
  proxies.clear();
  const result = await proxies.importText(text, source);
  return applyDirectPool(result, proxies, workspaces);
}

export async function loadProxyProviderPool(
  provider: ProxyProvider,
  _settings: SettingsManager,
  proxies: ProxyManager,
  workspaces: WorkspaceManager
): Promise<ProxyImportResult> {
  const result = await proxies.fetchProvider(provider);
  return applyDirectPool(result, proxies, workspaces);
}

export async function loadProxyScrapePool(
  settings: SettingsManager,
  proxies: ProxyManager,
  workspaces: WorkspaceManager
): Promise<ProxyImportResult> {
  return loadProxyProviderPool('private-api', settings, proxies, workspaces);
}
'@
Write-Text "src\main\proxyPipeline.ts" $pipeline

$wm = Read-Text "src\main\WorkspaceManager.ts"
$oldTokens = @'
    'ERR_MANDATORY_PROXY_CONFIGURATION_FAILED',
    'SOCKS connection failed',
    'Proxy connection failed'
'@
$newTokens = @'
    'ERR_MANDATORY_PROXY_CONFIGURATION_FAILED',
    'ERR_CONNECTION_RESET',
    'ERR_CONNECTION_REFUSED',
    'ERR_CONNECTION_CLOSED',
    'ERR_ADDRESS_UNREACHABLE',
    'ERR_NETWORK_CHANGED',
    'ERR_TIMED_OUT',
    'ERR_NAME_NOT_RESOLVED',
    'SOCKS connection failed',
    'Proxy connection failed',
    'tunnel connection failed'
'@
$wm = Replace-Once $wm "    'ERR_MANDATORY_PROXY_CONFIGURATION_FAILED',\r?\n    'SOCKS connection failed',\r?\n    'Proxy connection failed'" $newTokens "proxy error tokens"

$oldCycleCall = @'
      this.proxies.noteCompletedBrowserCycle(runCount);
'@
$newCycleCall = @'
      await this.proxies.refreshForBrowserCycle(runCount).catch((error) => {
        log.warn('[proxy-source] Cycle ' + runCount + ' refresh failed; current sessions continue.', error);
      });
'@
$wm = Replace-Once $wm '      this\.proxies\.noteCompletedBrowserCycle\(runCount\);' $newCycleCall "browser cycle refresh"

$timeoutBranch = @'
      if (isInitialPageLoadTimeout(error)) {
        this.proxies.markAssignedProxyDead(id, message);
        const replacement = await this.proxies.ensureWorkingProxy(id).catch(() => undefined);
        if (replacement) {
          runtime.consecutiveProxyFailures = 0;
          this.patch(id, {
            status: 'rotating',
            proxy: publicProxy(replacement),
            keepAlive: false,
            nextRotationAt: undefined,
            error: 'Page did not load within 10 seconds. Rotating immediately to a different unused proxy.'
          });
          this.startVisit(id);
          return;
        }
        this.scheduleVisitAfter(id, 1000, 'No unused proxy is available. Refreshing the private proxy API; Chromium remains closed.');
        return;
      }

      if (isProxyTransportFailure(error)) {
'@
$wm = Replace-Once $wm '      if \(isInitialPageLoadTimeout\(error\)\) \{[\s\S]*?\r?\n      \}\r?\n\r?\n      if \(isProxyTransportFailure\(error\)\) \{' $timeoutBranch "timeout immediate rotation"

$transportBranch = @'
      if (isProxyTransportFailure(error)) {
        runtime.consecutiveProxyFailures = 0;
        this.proxies.markAssignedProxyDead(id, message);
        this.patch(id, {
          status: 'rotating',
          keepAlive: false,
          nextRotationAt: undefined,
          error: 'Proxy/network error detected. Rotating immediately.'
        });

        const replacement = await this.proxies.ensureWorkingProxy(id).catch(() => undefined);
        if (replacement) {
          this.patch(id, { proxy: publicProxy(replacement), error: undefined });
          this.startVisit(id);
          return;
        }

        this.scheduleVisitAfter(id, 1000, 'No unused proxy is available. Refreshing the private proxy API; Chromium remains closed.');
        return;
      }

      runtime.consecutiveProxyFailures = 0;
'@
$wm = Replace-Once $wm '      if \(isProxyTransportFailure\(error\)\) \{[\s\S]*?\r?\n        return;\r?\n      \}\r?\n\r?\n      runtime\.consecutiveProxyFailures = 0;' $transportBranch "transport immediate rotation"

$wm = $wm.Replace("No validated live proxy is available yet. Retrying the proxy pool automatically; Chromium remains closed.", "No proxy is available from the private API yet. Chromium remains closed.")
$wm = $wm.Replace("Waiting for a validated live proxy. No direct-network browser launch is allowed.", "Waiting for a proxy from the private API. No direct-network browser launch is allowed.")
$wm = $wm.Replace("No unused validated live replacement proxy is available yet.", "No unused proxy from the current API pool is available yet.")
$wm = $wm.Replace("const MAX_IMMEDIATE_PROXY_RETRIES = 5;" + [Environment]::NewLine, "")
$wm = $wm.Replace("const PROXY_RETRY_BASE_DELAY_MS = 750;" + [Environment]::NewLine, "")
Write-Text "src\main\WorkspaceManager.ts" $wm

$cp = Read-Text "src\renderer\components\CentralControlPanel.tsx"
$cp = $cp.Replace("import { PROXY_PROVIDERS, type ProxyProvider } from '../../shared/proxySource';", "import { CUSTOM_PROXY_API_URL, type ProxyProvider } from '../../shared/proxySource';")
$cp = $cp.Replace("  const importFile = useAppStore((s) => s.importFile);" + [Environment]::NewLine, "")
$cp = $cp.Replace("  const validationProgress = useAppStore((s) => s.validationProgress);" + [Environment]::NewLine, "")
$cp = $cp.Replace("  const [provider, setProvider] = useState<ProxyProvider>(settings?.proxyProvider ?? 'proxyscrape');", "  const provider: ProxyProvider = 'private-api';")
$cp = Replace-Once $cp '  useEffect\(\(\) => \{\r?\n    if \(settings\?\.proxyProvider\) setProvider\(settings\.proxyProvider\);\r?\n  \}, \[settings\?\.proxyProvider\]\);\r?\n\r?\n' "" "provider effect"
$cp = Replace-Once $cp '  const importProxyFile = async \(\) => \{[\s\S]*?\r?\n  \};\r?\n\r?\n' "" "manual proxy import handler"
$cp = Replace-Once $cp '      setMessage\(\`\$\{PROXY_PROVIDERS[\s\S]*?validated live proxy\.\`\);' "      setMessage('Private API: loaded ' + result.valid + ' proxy endpoints and assigned them directly. No validation was performed.');" "proxy source message"

$providerPanel = @'
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

'@
$cp = Replace-Once $cp '    <section className="panel proxy-provider-panel">[\s\S]*?    </section>\r?\n\r?\n' $providerPanel "proxy provider panel"
$cp = Replace-Once $cp '  const importFile = useAppStore\(\(s\) => s\.importFile\);\r?\n' "" "unused importFile selector"
$cp = Replace-Once $cp '  const validationProgress = useAppStore\(\(s\) => s\.validationProgress\);\r?\n' "" "unused validationProgress selector"
Write-Text "src\renderer\components\CentralControlPanel.tsx" $cp

$sp = Read-Text "src\renderer\components\SettingsPage.tsx"
$sourcePanel = @'
      <section className="panel setting-section"><h2>Proxy source</h2>
        <div className="info-box"><strong>Private API only</strong><p>Proxies are fetched from http://169.58.35.69/data/high.txt and assigned directly. There is no proxy validation, latency testing, provider selection, or manual proxy file workflow.</p></div>
        <small>Each normal rotation cycle refreshes the API pool. Failed proxies are excluded from the current cycle, and Chromium never falls back to the direct VPS network.</small>
      </section>
'@
$sp = Replace-Once $sp '      <section className="panel setting-section"><h2>Proxy rotation & assignment</h2>[\s\S]*?      </section>\r?\n\r?\n      <section className="panel setting-section"><h2>Fast proxy validation</h2>[\s\S]*?      </section>' $sourcePanel "settings proxy sections"
$sp = Replace-Once $sp '\r?\nfunction Toggle\([\s\S]*$' ([Environment]::NewLine) "unused Toggle"
Write-Text "src\renderer\components\SettingsPage.tsx" $sp

$appFile = Read-Text "src\renderer\App.tsx"
$appFile = $appFile.Replace("Preparing browser slots and proxies…", "Preparing lightweight browser slots and private proxy pool…")
Write-Text "src\renderer\App.tsx" $appFile

$pkg = Read-Text "package.json"
$pkg = $pkg.Replace('"version": "4.4.3"', '"version": "4.5.0"')
Write-Text "package.json" $pkg

$providersTest = @'
import { describe, expect, it } from 'vitest';
import { CUSTOM_PROXY_API_URL, DEFAULT_PROXY_PROVIDER, PROXY_PROVIDERS } from '../src/shared/proxySource';

describe('private proxy API', () => {
  it('uses exactly one fixed proxy source', () => {
    expect(DEFAULT_PROXY_PROVIDER).toBe('private-api');
    expect(PROXY_PROVIDERS).toHaveLength(1);
    expect(CUSTOM_PROXY_API_URL).toBe('http://169.58.35.69/data/high.txt');
  });
});
'@
Write-Text "tests\proxyProviders.test.ts" $providersTest

$timeoutTest = @'
import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const root = path.resolve(__dirname, '..');
const read = (relative: string) => fs.readFileSync(path.join(root, relative), 'utf8');

describe('proxy rotation', () => {
  it('uses a 10-second initial timeout and immediate replacement', () => {
    const manager = read('src/main/WorkspaceManager.ts');
    expect(manager).toContain('INITIAL_PAGE_LOAD_TIMEOUT_MS = 10_000');
    expect(manager).toContain("timeout: INITIAL_PAGE_LOAD_TIMEOUT_MS");
    expect(manager).toContain('Proxy/network error detected. Rotating immediately.');
    expect(manager).toContain('await this.proxies.ensureWorkingProxy(id)');
  });
});
'@
Write-Text "tests\timeoutRotation.test.ts" $timeoutTest

$architectureTest = @'
import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const root = path.resolve(__dirname, '..');
const read = (relative: string) => fs.readFileSync(path.join(root, relative), 'utf8');

describe('Social SEO 4.5.0 lightweight architecture', () => {
  it('trusts the private API without a validator pipeline', () => {
    const pipeline = read('src/main/proxyPipeline.ts');
    expect(pipeline).not.toContain('startContinuousValidation');
  });

  it('blocks direct-network browser starts', () => {
    const manager = read('src/main/WorkspaceManager.ts');
    expect(manager).toContain('No direct-network browser launch is allowed.');
    expect(manager).toContain('ensureWorkingProxy(id)');
  });

  it('refreshes the API for each normal rotation cycle', () => {
    const manager = read('src/main/WorkspaceManager.ts');
    expect(manager).toContain('refreshForBrowserCycle(runCount)');
  });
});
'@
Write-Text "tests\lightweightArchitecture.test.ts" $architectureTest

$smoke = @'
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const root = path.resolve(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(root, p), 'utf8');

const source = read('src/shared/proxySource.ts');
const proxyManager = read('src/main/ProxyManager.ts');
const workspace = read('src/main/WorkspaceManager.ts');
const panel = read('src/renderer/components/CentralControlPanel.tsx');

assert.equal(source.includes('http://169.58.35.69/data/high.txt'), true);
assert.equal(source.includes("id: 'private-api'"), true);
assert.equal(proxyManager.includes('refreshForBrowserCycle'), true);
assert.equal(workspace.includes('INITIAL_PAGE_LOAD_TIMEOUT_MS = 10_000'), true);
assert.equal(workspace.includes('No direct-network browser launch is allowed.'), true);
assert.equal(panel.includes('Private API · direct assignment'), true);
console.log('Social SEO 4.5.0 final smoke checks passed.');
'@
Write-Text "scripts\final-smoke.cjs" $smoke

Write-Host "Applied Social SEO 4.5.0 private-API/no-validation refactor."
