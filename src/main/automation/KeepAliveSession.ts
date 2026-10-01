import type { KeepAliveRules } from '../../shared/types/settings';
import type { PwPage } from '../browser/PlaywrightRuntime';

const BLOCKED_PATH_WORDS = [
  'login', 'signin', 'signup', 'register', 'account', 'checkout', 'cart',
  'logout', 'download', 'subscribe', 'privacy', 'terms'
];

function randomInt(min: number, max: number): number {
  return Math.floor(min + Math.random() * (Math.max(min, max) - min + 1));
}

async function sleep(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitForUrlChange(page: PwPage, previousUrl: string, timeoutMs: number): Promise<boolean> {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    if (page.isClosed()) return false;
    if (page.url() !== previousUrl) return true;
    await sleep(250);
  }
  return page.url() !== previousUrl;
}

async function performScrollCycles(page: PwPage, cycles: number, shouldStop: () => boolean): Promise<void> {
  for (let cycle = 0; cycle < cycles; cycle += 1) {
    if (shouldStop() || page.isClosed()) return;
    await page.mouse.wheel(0, randomInt(520, 980));
    await sleep(randomInt(650, 1100));
    if (shouldStop() || page.isClosed()) return;
    await page.mouse.wheel(0, -randomInt(260, 620));
    await sleep(randomInt(550, 950));
  }
}

async function collectInternalArticleLinks(page: PwPage, sameOriginOnly: boolean): Promise<string[]> {
  return page.evaluate((sameOrigin) => {
    const current = new URL(location.href);
    const blocked = ['login', 'signin', 'signup', 'register', 'account', 'checkout', 'cart', 'logout', 'download', 'subscribe', 'privacy', 'terms'];
    const anchors = Array.from(document.querySelectorAll<HTMLAnchorElement>('article a[href], main a[href], [role="main"] a[href], a[href*="/article/"]'));
    const scored = anchors.map((anchor) => {
      try {
        const url = new URL(anchor.href, location.href);
        const text = (anchor.innerText || anchor.textContent || '').trim();
        const rect = anchor.getBoundingClientRect();
        const path = `${url.pathname}${url.search}`.toLowerCase();
        const rel = (anchor.rel || '').toLowerCase();
        if (!['http:', 'https:'].includes(url.protocol)) return undefined;
        if (sameOrigin && url.origin !== current.origin) return undefined;
        if (url.href === location.href || url.hash && url.pathname === current.pathname && url.search === current.search) return undefined;
        if (anchor.target === '_blank' || anchor.hasAttribute('download')) return undefined;
        if (rect.width < 4 || rect.height < 4) return undefined;
        if (text.length < 5) return undefined;
        if (rel.includes('sponsored')) return undefined;
        if (blocked.some((word) => path.includes(word))) return undefined;
        const score = (path.includes('/article/') ? 100 : 0) + (anchor.closest('article') ? 40 : 0) + Math.min(text.length, 60);
        return { href: url.href, score };
      } catch {
        return undefined;
      }
    }).filter((value): value is { href: string; score: number } => Boolean(value));

    scored.sort((a, b) => b.score - a.score);
    return [...new Set(scored.map((item) => item.href))];
  }, sameOriginOnly);
}

async function clickLink(page: PwPage, href: string): Promise<void> {
  const previousUrl = page.url();
  const clicked = await page.evaluate((targetHref) => {
    const anchors = Array.from(document.querySelectorAll<HTMLAnchorElement>('a[href]'));
    const anchor = anchors.find((candidate) => {
      try { return new URL(candidate.href, location.href).href === targetHref; }
      catch { return false; }
    });
    if (!anchor) return false;
    anchor.scrollIntoView({ block: 'center', inline: 'nearest' });
    anchor.click();
    return true;
  }, href);

  if (clicked && await waitForUrlChange(page, previousUrl, 8000)) return;
  await page.goto(href, { waitUntil: 'domcontentloaded', timeout: 30_000 });
}

export interface KeepAliveSessionOptions {
  deadlineMs: number;
  rules: KeepAliveRules;
  shouldStop(): boolean;
  onHop(url: string): Promise<void> | void;
  onActivity(url: string): Promise<void> | void;
}

/**
 * Runs an in-page keep-alive cycle until the current proxy rotation deadline.
 * The first round performs two down/up scroll cycles; later rounds perform two
 * or three cycles. After each round it follows one unseen same-origin article
 * link when maxArticleHops permits it. The caller owns the Chromium lifetime.
 */
export async function runKeepAliveSession(page: PwPage, options: KeepAliveSessionOptions): Promise<void> {
  const visited = new Set<string>([page.url()]);
  let hops = 0;
  let firstRound = true;

  while (!options.shouldStop() && !page.isClosed() && Date.now() < options.deadlineMs) {
    const cycles = firstRound ? 2 : randomInt(2, 3);
    firstRound = false;
    await performScrollCycles(page, cycles, options.shouldStop);
    if (options.shouldStop() || page.isClosed() || Date.now() >= options.deadlineMs) break;

    if (hops < options.rules.maxArticleHops) {
      const candidates = await collectInternalArticleLinks(page, options.rules.sameOriginOnly);
      const unseen = candidates.filter((url) => !visited.has(url) && !BLOCKED_PATH_WORDS.some((word) => url.toLowerCase().includes(word)));
      const next = unseen.length ? unseen[randomInt(0, Math.min(unseen.length - 1, 7))] : undefined;
      if (next) {
        visited.add(next);
        await clickLink(page, next);
        hops += 1;
        await options.onHop(page.url());
      }
    }

    await options.onActivity(page.url());
    const remaining = options.deadlineMs - Date.now();
    if (remaining <= 0) break;
    const pauseSeconds = randomInt(options.rules.minActionSeconds, options.rules.maxActionSeconds);
    await sleep(Math.min(remaining, pauseSeconds * 1000));
  }
}
