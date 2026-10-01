const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const root = path.resolve(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(root, p), 'utf8');

const source = read('src/shared/proxySource.ts');
const proxyManager = read('src/main/ProxyManager.ts');
const workspace = read('src/main/WorkspaceManager.ts');
const panel = read('src/renderer/components/CentralControlPanel.tsx');

assert.equal(source.includes('http://169.58.35.69/data/elite.txt'), true);
assert.equal(source.includes("id: 'private-api'"), true);
assert.equal(proxyManager.includes('refreshForBrowserCycle'), true);
assert.equal(workspace.includes('INITIAL_PAGE_LOAD_TIMEOUT_MS = 10_000'), true);
assert.equal(workspace.includes('No direct-network browser launch is allowed.'), true);
assert.equal(panel.includes('Private API · direct assignment'), true);
console.log('Social SEO 4.5.1 final smoke checks passed.');
