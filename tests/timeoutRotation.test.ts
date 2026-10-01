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
