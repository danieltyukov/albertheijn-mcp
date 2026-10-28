import { rm } from 'node:fs/promises';
import type { AppContext } from '../context.js';
import { toSafeError } from '../errors.js';
import { VERSION } from '../version.js';
import { findBrowser } from './browser.js';

export interface AuthStatus {
  version: string;
  signedIn: boolean;
  name?: string;
  tokenValidUntil?: string;
  canRefresh?: boolean;
  browser?: string;
  live?: { anonymousApi: 'ok' | string; account?: 'ok' | string };
  dataDir: string;
}

/** Sign-in state without secrets; with live=true it also calls the API once or twice. */
export async function authStatus(ctx: AppContext, live: boolean): Promise<AuthStatus> {
  const data = await ctx.session.load();
  const status: AuthStatus = { version: VERSION, signedIn: Boolean(data.user), dataDir: ctx.config.home };
  if (data.user) {
    if (data.user.name) status.name = data.user.name;
    status.tokenValidUntil = new Date(data.user.expiresAt).toISOString();
    status.canRefresh = Boolean(data.user.refreshToken);
  }
  const browser = findBrowser(ctx.config);
  if (browser) status.browser = `${browser.name} (${browser.executablePath})`;
  if (live) {
    status.live = { anonymousApi: 'ok' };
    try {
      const { searchProducts } = await import('../ah/products.js');
      await searchProducts(ctx, { query: 'melk', size: 1 });
    } catch (error) {
      status.live.anonymousApi = toSafeError(error).message;
    }
    if (data.user) {
      try {
        const { memberProfile } = await import('../ah/member.js');
        const profile = await memberProfile(ctx);
        status.live.account = 'ok';
        if (profile.firstName) status.name = profile.firstName;
      } catch (error) {
        status.live.account = toSafeError(error).message;
      }
    }
  }
  return status;
}

export async function logout(ctx: AppContext): Promise<{ signedOut: true; removed: string[] }> {
  await ctx.session.clear();
  ctx.previews.clear();
  ctx.cache.clear();
  await rm(ctx.config.profileDir, { recursive: true, force: true });
  return { signedOut: true, removed: [ctx.config.sessionFile, ctx.config.profileDir] };
}
