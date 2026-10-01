export const MOBILE_CHROME_USER_AGENT =
  'Mozilla/5.0 (Linux; Android 14; Pixel 8 Build/UQ1A.240205.004) ' +
  'AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Mobile Safari/537.36';

/**
 * Keep each embedded Chromium surface phone-sized even though the surrounding
 * control card can be wider. This is what makes responsive sites and Google
 * use their mobile layouts while preserving the existing BrowserView,
 * proxy, click, and Keep Alive implementation.
 */
export const MOBILE_BROWSER_VIEWPORT_WIDTH = 390;

export interface MobileViewportInput {
  x: number;
  y: number;
  width: number;
  height: number;
}

export function fitMobileViewport(bounds: MobileViewportInput): MobileViewportInput {
  const width = Math.max(1, Math.min(MOBILE_BROWSER_VIEWPORT_WIDTH, Math.round(bounds.width)));
  const containerWidth = Math.max(1, Math.round(bounds.width));
  const x = Math.round(bounds.x + Math.max(0, (containerWidth - width) / 2));

  return {
    x,
    y: Math.round(bounds.y),
    width,
    height: Math.max(1, Math.round(bounds.height))
  };
}
