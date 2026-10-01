import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const root = path.resolve(process.cwd());

describe('fast proxy validation', () => {
  it('uses a request-only HTTPS probe and never launches Chromium for validation', () => {
    const source = fs.readFileSync(path.join(root, 'src/main/ProxyValidator.ts'), 'utf8');
    expect(source).toContain('request.newContext');
    expect(source).not.toContain('chromium.launch');
    expect(source).toContain('Fast proxy HTTPS probe');
  });

  it('uses fixed fast defaults so old slow settings do not survive upgrades', () => {
    const source = fs.readFileSync(path.join(root, 'src/main/SettingsManager.ts'), 'utf8');
    expect(source).toContain('timeoutSeconds: 3');
    expect(source).toContain('attempts: 1');
    expect(source).toContain('concurrency: 20');
    expect(source).toContain('assignWorkingImmediately: true');
  });
});
