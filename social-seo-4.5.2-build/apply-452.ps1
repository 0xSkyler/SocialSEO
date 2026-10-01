$ErrorActionPreference = "Stop"
$root = "buildsrc\Social-SEO"

function Read-Text([string]$rel) { Get-Content (Join-Path $root $rel) -Raw }
function Write-Text([string]$rel, [string]$value) { Set-Content -Path (Join-Path $root $rel) -Value $value -Encoding utf8 }

$wmPath = "src\main\WorkspaceManager.ts"
$wm = Read-Text $wmPath

if ($wm -notmatch 'function isInitialPageLoadTimeout\(error: unknown\): boolean') {
  throw "Expected 4.4.3/4.5.1 navigation timeout helper was not found."
}

if ($wm -notmatch 'function isPageGotoFailure\(error: unknown\): boolean') {
  $helper = @'

function isPageGotoFailure(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return message.includes('page.goto');
}
'@
  $wm = [regex]::Replace(
    $wm,
    '(function isInitialPageLoadTimeout\(error: unknown\): boolean \{[\s\S]*?\r?\n\})',
    '$1' + $helper,
    1
  )
}

$oldCondition = 'if (isProxyTransportFailure(error)) {'
$newCondition = 'if (isPageGotoFailure(error) || isProxyTransportFailure(error)) {'
if (-not $wm.Contains($newCondition)) {
  if (-not $wm.Contains($oldCondition)) {
    throw "Immediate proxy/network rotation branch was not found."
  }
  $wm = $wm.Replace($oldCondition, $newCondition)
}

$wm = $wm.Replace(
  "error: 'Proxy/network error detected. Rotating immediately.'",
  "error: 'Navigation/proxy error detected. Rotating immediately.'"
)

Write-Text $wmPath $wm

$packagePath = "package.json"
$pkg = Read-Text $packagePath
$pkg = $pkg.Replace('"version": "4.5.1"', '"version": "4.5.2"')
Write-Text $packagePath $pkg

$test = @'
import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const root = path.resolve(__dirname, '..');
const read = (relative: string) => fs.readFileSync(path.join(root, relative), 'utf8');

describe('navigation error proxy rotation', () => {
  it('immediately rotates on any page.goto error, including certificate failures', () => {
    const manager = read('src/main/WorkspaceManager.ts');
    expect(manager).toContain('function isPageGotoFailure(error: unknown): boolean');
    expect(manager).toContain("return message.includes('page.goto')");
    expect(manager).toContain('if (isPageGotoFailure(error) || isProxyTransportFailure(error))');
    expect(manager).toContain('Navigation/proxy error detected. Rotating immediately.');
    expect(manager).toContain('this.proxies.markAssignedProxyDead(id, message)');
    expect(manager).toContain('await this.proxies.ensureWorkingProxy(id)');
  });
});
'@
Write-Text "tests\navigationErrorRotation.test.ts" $test

$version = (Get-Content (Join-Path $root "package.json") -Raw | ConvertFrom-Json).version
if ($version -ne "4.5.2") {
  throw "Expected version 4.5.2, got $version"
}

Write-Host "Social SEO 4.5.2 navigation-error rotation patch applied."
