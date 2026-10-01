import { describe, expect, it } from 'vitest';
import {
  MOBILE_BROWSER_VIEWPORT_WIDTH,
  MOBILE_CHROME_USER_AGENT,
  fitMobileViewport
} from '../src/shared/mobileProfile';
import {
  APP_ID,
  APP_NAME,
  EPHEMERAL_PARTITION_PREFIX,
  PARTITION_PREFIX
} from '../src/shared/constants';

describe('PocketSEO Mobile browser profile', () => {
  it('uses a distinct application and session identity', () => {
    expect(APP_NAME).toBe('PocketSEO Mobile');
    expect(APP_ID).toBe('com.pocketseo.mobile');
    expect(PARTITION_PREFIX).toContain('pocketseo-mobile');
    expect(EPHEMERAL_PARTITION_PREFIX).toContain('pocketseo-mobile');
  });

  it('uses an Android Mobile Chrome user agent', () => {
    expect(MOBILE_CHROME_USER_AGENT).toContain('Android 14');
    expect(MOBILE_CHROME_USER_AGENT).toContain('Chrome/126');
    expect(MOBILE_CHROME_USER_AGENT).toContain('Mobile Safari');
  });

  it('centers a phone-width BrowserView without changing its height', () => {
    expect(MOBILE_BROWSER_VIEWPORT_WIDTH).toBe(390);
    expect(
      fitMobileViewport({ x: 20, y: 100, width: 760, height: 360 })
    ).toEqual({ x: 205, y: 100, width: 390, height: 360 });

    expect(
      fitMobileViewport({ x: 10, y: 20, width: 320, height: 300 })
    ).toEqual({ x: 10, y: 20, width: 320, height: 300 });
  });
});
