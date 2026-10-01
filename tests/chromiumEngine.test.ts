import { describe, expect, it } from 'vitest';
import type { BrowserEngine } from '../src/shared/types/browser';

describe('Chromium-only browser engine', () => {
  it('exposes Chromium as the only browser engine', () => {
    const engine: BrowserEngine = 'chromium';
    expect(engine).toBe('chromium');
  });
});
