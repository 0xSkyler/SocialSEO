import fs from 'node:fs';
import type { EngineInfo } from '../../shared/types/browser';
import { getPlaywright } from './PlaywrightRuntime';

export class EngineResolver {
  detect(): EngineInfo[] {
    let executablePath: string | undefined;
    try { executablePath = getPlaywright().chromium.executablePath(); } catch { /* reported below */ }
    const available = Boolean(executablePath && fs.existsSync(executablePath));
    return [{
      engine: 'chromium',
      label: 'Chromium',
      available,
      executablePath,
      bundled: true,
      detail: available ? 'Bundled Playwright Chromium' : 'Chromium binary is not installed. Run npm run browsers:install.'
    }];
  }

  get(): EngineInfo {
    return this.detect()[0]!;
  }
}
