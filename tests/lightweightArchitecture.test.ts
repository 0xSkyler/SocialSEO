import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const root = path.resolve(__dirname, '..');
const read = (relative: string) => fs.readFileSync(path.join(root, relative), 'utf8');

describe('Social SEO 4.5.1 lightweight architecture', () => {
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
