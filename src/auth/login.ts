import { createInterface } from 'node:readline/promises';
import { chromium, type BrowserContext, type Page } from 'playwright-core';
import { CLIENT_ID } from '../ah/client.js';
import type { AppContext, Logger } from '../context.js';
import { AhError } from '../errors.js';
import { findBrowser } from './browser.js';
import type { UserSession } from './session.js';

export const REDIRECT_URI = 'appie://login-exit';

export function authorizeUrl(loginOrigin: string): string {
  const url = new URL('/login', loginOrigin);
  url.searchParams.set('client_id', CLIENT_ID);
  url.searchParams.set('redirect_uri', REDIRECT_URI);
  url.searchParams.set('response_type', 'code');
  return url.toString();
}

/**
 * Pull the authorisation code out of whatever the user pastes: the full
 * appie://login-exit?code=... URL, a URL-encoded copy of it, or the bare code.
 */
export function extractCode(input: string): string | undefined {
  const text = input.trim();
  if (!text) return undefined;
  const decoded = (() => {
    try {
      return decodeURIComponent(text);
    } catch {
      return text;
    }
  })();
  const match = /[?&]code=([^&#\s"']+)/.exec(decoded);
  if (match?.[1]) return match[1];
  if (/^[A-Za-z0-9._~-]{8,}$/.test(text)) return text;
  return undefined;
}

export interface LoginReport {
  signedIn: boolean;
  name?: string;
  memberId?: string;
  method: 'browser' | 'manual';
}

/** Save tokens from a code and read the profile so the session carries a name and member id. */
export async function completeLogin(
  ctx: AppContext,
  code: string,
  method: LoginReport['method'],
): Promise<LoginReport> {
  const set = await ctx.ah.exchangeCode(code);
  const user: UserSession = { ...set, savedAt: new Date().toISOString() };
  await ctx.session.update((data) => {
    data.user = user;
  });
  ctx.previews.clear();
  const report: LoginReport = { signedIn: true, method };
  try {
    const { memberProfile } = await import('../ah/member.js');
    const profile = await memberProfile(ctx);
    await ctx.session.update((data) => {
      if (!data.user) return;
      if (profile.id) data.user.memberId = profile.id;
      if (profile.firstName) data.user.name = profile.firstName;
    });
    if (profile.firstName) report.name = profile.firstName;
    if (profile.id) report.memberId = profile.id;
  } catch {
    /* the tokens work even when the profile call does not */
  }
  return report;
}

function watchForCode(context: BrowserContext, page: Page): { code: Promise<string>; stop: () => void } {
  let resolveCode: (code: string) => void = () => undefined;
  const code = new Promise<string>((resolve) => (resolveCode = resolve));
  const check = (url: string | undefined): void => {
    if (!url || !url.startsWith(REDIRECT_URI)) return;
    const found = extractCode(url);
    if (found) resolveCode(found);
  };
  const onRequest = (request: { url(): string }) => check(request.url());
  const onResponse = (response: { headers(): Record<string, string> }) => check(response.headers().location);
  const onFrame = (frame: { url(): string }) => check(frame.url());
  context.on('request', onRequest);
  context.on('requestfailed', onRequest);
  context.on('response', onResponse);
  page.on('framenavigated', onFrame);
  // Some builds swallow the custom-scheme navigation without an event; poll the page as a backstop.
  const timer = setInterval(() => {
    for (const p of context.pages()) check(p.url());
  }, 500);
  return {
    code,
    stop: () => {
      clearInterval(timer);
      context.off('request', onRequest);
      context.off('requestfailed', onRequest);
      context.off('response', onResponse);
      page.off('framenavigated', onFrame);
    },
  };
}

let running = false;

/** Open the user's browser on the Albert Heijn login page and wait for the redirect with the code. */
export async function browserLogin(ctx: AppContext, log: Logger): Promise<LoginReport> {
  if (running) throw new AhError('LOGIN_IN_PROGRESS', 'A sign-in window is already open. Finish it there.');
  const browser = findBrowser(ctx.config);
  if (!browser) {
    throw new AhError(
      'BROWSER_NOT_FOUND',
      'No Chrome, Edge, Chromium or Brave was found. Run "albertheijn-mcp login --manual", or "albertheijn-mcp browser install".',
    );
  }
  running = true;
  let context: BrowserContext | undefined;
  try {
    log(
      `Opening ${browser.name} on the Albert Heijn login page. Sign in there; the window closes by itself.`,
    );
    context = await chromium.launchPersistentContext(ctx.config.profileDir, {
      executablePath: browser.executablePath,
      headless: false,
      viewport: null,
      locale: 'nl-NL',
      timezoneId: 'Europe/Amsterdam',
      ignoreDefaultArgs: ['--enable-automation'],
      args: ['--no-first-run', '--no-default-browser-check', '--disable-sync', '--password-store=basic'],
      acceptDownloads: false,
    });
    const page = context.pages()[0] ?? (await context.newPage());
    const watcher = watchForCode(context, page);
    const closed = new Promise<never>((_, reject) =>
      context!.on('close', () =>
        reject(new AhError('LOGIN_CANCELLED', 'The sign-in window was closed before signing in.')),
      ),
    );
    const timeout = new Promise<never>((_, reject) =>
      setTimeout(
        () => reject(new AhError('LOGIN_TIMEOUT', 'Sign-in took too long. Run login again.')),
        ctx.config.loginTimeoutMs,
      ).unref(),
    );
    await page
      .goto(authorizeUrl(ctx.config.loginUrl), { waitUntil: 'domcontentloaded' })
      .catch(() => undefined);
    try {
      const code = await Promise.race([watcher.code, closed, timeout]);
      return await completeLogin(ctx, code, 'browser');
    } finally {
      watcher.stop();
    }
  } finally {
    running = false;
    await context?.close().catch(() => undefined);
  }
}

/** Terminal flow without browser automation: print the URL, read the redirect URL back. */
export async function manualLogin(ctx: AppContext, log: Logger, input?: string): Promise<LoginReport> {
  let pasted = input;
  if (!pasted) {
    log('1. Open this address in any browser and sign in to Albert Heijn:');
    log(`   ${authorizeUrl(ctx.config.loginUrl)}`);
    log(
      '2. After signing in the browser tries to open "appie://login-exit?code=..." and shows an error or nothing.',
    );
    log(
      '   Copy that address. In Chrome, open the developer tools (F12) on the Network tab before signing in,',
    );
    log('   then copy the request URL that starts with appie://login-exit.');
    const rl = createInterface({ input: process.stdin, output: process.stderr });
    try {
      pasted = await rl.question('3. Paste the address or the code here: ');
    } finally {
      rl.close();
    }
  }
  const code = extractCode(pasted ?? '');
  if (!code) throw new AhError('INVALID_ARGUMENT', 'No login code was found in that text.');
  return completeLogin(ctx, code, 'manual');
}
