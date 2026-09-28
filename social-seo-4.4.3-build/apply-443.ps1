$ErrorActionPreference = "Stop"

$root = "buildsrc\Social-SEO"
$wmPath = Join-Path $root "src\main\WorkspaceManager.ts"
$pmPath = Join-Path $root "src\main\ProxyManager.ts"

$wm = Get-Content $wmPath -Raw

$oldConstants = @'
const PROXY_RETRY_COOLDOWN_MS = 15_000;

function isProxyTransportFailure(error: unknown): boolean {
'@

$newConstants = @'
const PROXY_RETRY_COOLDOWN_MS = 15_000;
const INITIAL_PAGE_LOAD_TIMEOUT_MS = 10_000;

function isInitialPageLoadTimeout(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return message.includes('page.goto') && message.includes(\`Timeout \${INITIAL_PAGE_LOAD_TIMEOUT_MS}ms exceeded\`);
}

function isProxyTransportFailure(error: unknown): boolean {
'@

if (-not $wm.Contains($oldConstants.Trim())) {
  throw "Workspace constants patch point not found."
}
$wm = $wm.Replace($oldConstants.Trim(), $newConstants.Trim())

$oldGoto = "await page.goto(initialUrl, { waitUntil: 'domcontentloaded', timeout: 45_000 });"
$newGoto = "await page.goto(initialUrl, { waitUntil: 'domcontentloaded', timeout: INITIAL_PAGE_LOAD_TIMEOUT_MS });"
if (-not $wm.Contains($oldGoto)) {
  throw "Initial page.goto patch point not found."
}
$wm = $wm.Replace($oldGoto, $newGoto)

$oldFailurePoint = @'
      if (isProxyTransportFailure(error)) {
'@

$newFailurePoint = @'
      if (isInitialPageLoadTimeout(error)) {
        const replacement = this.proxies.replaceTimedOutProxyWithUnusedLive(id, message);
        if (replacement) {
          runtime.consecutiveProxyFailures = 0;
          this.patch(id, {
            status: 'rotating',
            proxy: publicProxy(replacement),
            keepAlive: false,
            nextRotationAt: undefined,
            error: 'Page did not load within 10 seconds. Rotating immediately to a different unused LIVE proxy.'
          });
          this.startVisit(id);
          return;
        }
      }

      if (isProxyTransportFailure(error)) {
'@

if (-not $wm.Contains($oldFailurePoint.Trim())) {
  throw "Timeout recovery patch point not found."
}
$wm = $wm.Replace($oldFailurePoint.Trim(), $newFailurePoint.Trim())
Set-Content -Path $wmPath -Value $wm -Encoding utf8

$pm = Get-Content $pmPath -Raw

$oldChoose = @'
  chooseReplacement(workspaceId: number): ProxyRecord | undefined {
'@

$newChoose = @'
  replaceTimedOutProxyWithUnusedLive(workspaceId: number, reason: string): ProxyRecord | undefined {
    const currentId = this.assignments.find((item) => item.workspaceId === workspaceId)?.proxyId;
    const leasedElsewhere = this.assignedProxyIds(workspaceId);
    const candidate = this.eligiblePool().find((proxy) =>
      proxy.id !== currentId
      && !leasedElsewhere.has(proxy.id)
      && !this.usedThisCycle.has(proxy.id)
    );

    if (!candidate) return undefined;

    this.markAssignedProxyDead(workspaceId, reason);
    this.setAssignment(workspaceId, candidate.id);
    return { ...candidate };
  }

  chooseReplacement(workspaceId: number): ProxyRecord | undefined {
'@

if (-not $pm.Contains($oldChoose.Trim())) {
  throw "ProxyManager patch point not found."
}
$pm = $pm.Replace($oldChoose.Trim(), $newChoose.Trim())
Set-Content -Path $pmPath -Value $pm -Encoding utf8

$packagePath = Join-Path $root "package.json"
$packageText = Get-Content $packagePath -Raw
$packageText = $packageText.Replace('"version": "4.4.2"', '"version": "4.4.3"')
Set-Content -Path $packagePath -Value $packageText -Encoding utf8

$test = @'
import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const root = path.resolve(__dirname, '..');
const read = (relative: string) => fs.readFileSync(path.join(root, relative), 'utf8');

describe('10-second initial page timeout rotation', () => {
  it('rotates only when another unused validated proxy is available', () => {
    const manager = read('src/main/WorkspaceManager.ts');
    const proxies = read('src/main/ProxyManager.ts');
    expect(manager).toContain('INITIAL_PAGE_LOAD_TIMEOUT_MS = 10_000');
    expect(manager).toContain("timeout: INITIAL_PAGE_LOAD_TIMEOUT_MS");
    expect(manager).toContain('isInitialPageLoadTimeout');
    expect(manager).toContain('replaceTimedOutProxyWithUnusedLive(id, message)');
    expect(manager).toContain('Page did not load within 10 seconds. Rotating immediately');
    expect(proxies).toContain('replaceTimedOutProxyWithUnusedLive(workspaceId: number, reason: string)');
    expect(proxies).toContain('!this.usedThisCycle.has(proxy.id)');
    expect(proxies).toContain('!leasedElsewhere.has(proxy.id)');
  });
});
'@

Set-Content -Path (Join-Path $root "tests\timeoutRotation.test.ts") -Value $test -Encoding utf8

$version = (Get-Content $packagePath -Raw | ConvertFrom-Json).version
if ($version -ne "4.4.3") {
  throw "Expected version 4.4.3, got $version"
}

Write-Host "Social SEO 4.4.3 minimal timeout patch applied."
