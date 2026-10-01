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
    expect(manager).toContain('this.proxies.markAssignedProxyDead(id, message)');
    expect(manager).toContain('await this.proxies.ensureWorkingProxy(id)');
  });
});
