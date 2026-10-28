import { afterEach, describe, expect, it, vi } from 'vitest';
import { connectFailure } from '../src/ah/client.js';
import { AhError } from '../src/errors.js';
import { anonymousContext, json, mockApi, signedInContext } from './helpers.js';

afterEach(() => vi.restoreAllMocks());

describe('AhClient', () => {
  it('gets an anonymous token once and sends the app headers', async () => {
    const ctx = await anonymousContext();
    const calls = mockApi({ '/mobile-services/product/search/v2': { products: [] } });
    await ctx.ah.request('/mobile-services/product/search/v2', { query: { query: 'melk' } });
    await ctx.ah.request('/mobile-services/product/search/v2', { query: { query: 'kaas' } });
    expect(calls.filter((c) => c.path.endsWith('/anonymous'))).toHaveLength(1);
    const search = calls.find((c) => c.path.includes('search'))!;
    expect(search.headers.get('authorization')).toBe('Bearer anon-token');
    expect(search.headers.get('x-application')).toBe('AHWEBSHOP');
    expect(search.headers.get('user-agent')).toMatch(/^Appie\//);
    const anon = calls.find((c) => c.path.endsWith('/anonymous'))!;
    expect(anon.body).toEqual({ clientId: 'appie-ios' });
  });

  it('refuses user endpoints without a session', async () => {
    const ctx = await anonymousContext();
    mockApi({});
    await expect(ctx.ah.request('/x', { auth: 'user' })).rejects.toMatchObject({ code: 'AUTH_REQUIRED' });
  });

  it('refreshes an expired user token and stores the rotated refresh token', async () => {
    const ctx = await signedInContext();
    await ctx.session.update((d) => {
      d.user!.expiresAt = Date.now() - 1000;
    });
    const calls = mockApi({
      '/mobile-auth/v1/auth/token/refresh': json({
        access_token: 'new-access',
        refresh_token: 'new-refresh',
        expires_in: 3600,
      }),
      '/mobile-services/x': { ok: true },
    });
    await ctx.ah.request('/mobile-services/x', { auth: 'user' });
    const refresh = calls.find((c) => c.path.endsWith('/refresh'))!;
    expect(refresh.body).toEqual({ clientId: 'appie-ios', refreshToken: 'user-refresh' });
    expect(calls.at(-1)!.headers.get('authorization')).toBe('Bearer new-access');
    const saved = await ctx.session.load();
    expect(saved.user?.refreshToken).toBe('new-refresh');
    expect(saved.user?.memberId).toBe('1001');
  });

  it('retries once after a 401 with a forced refresh', async () => {
    const ctx = await signedInContext();
    let n = 0;
    mockApi({
      '/mobile-auth/v1/auth/token/refresh': json({
        access_token: 'second',
        refresh_token: 'r2',
        expires_in: 3600,
      }),
      '/mobile-services/y': () => (++n === 1 ? new Response('', { status: 401 }) : { ok: n }),
    });
    await expect(ctx.ah.request('/mobile-services/y', { auth: 'user' })).resolves.toEqual({ ok: 2 });
  });

  it('turns a refused refresh into AUTH_REQUIRED', async () => {
    const ctx = await signedInContext();
    mockApi({
      '/mobile-auth/v1/auth/token/refresh': new Response('{}', { status: 400 }),
      '/mobile-services/z': new Response('', { status: 401 }),
    });
    await expect(ctx.ah.request('/mobile-services/z', { auth: 'user' })).rejects.toMatchObject({
      code: 'AUTH_REQUIRED',
    });
  });

  it('backs off on 429 and gives up with RATE_LIMITED', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true, advanceTimeDelta: 50 });
    try {
      const ctx = await anonymousContext();
      mockApi({
        '/mobile-services/busy': new Response('', { status: 429, headers: { 'retry-after': '0' } }),
      });
      const pending = ctx.ah.request('/mobile-services/busy');
      const assertion = expect(pending).rejects.toMatchObject({ code: 'RATE_LIMITED' });
      await vi.runAllTimersAsync();
      await assertion;
    } finally {
      vi.useRealTimers();
    }
  });

  it('maps GraphQL errors and never echoes tokens', async () => {
    const ctx = await signedInContext();
    mockApi({ 'gql:member': () => json({ errors: [{ message: 'Bearer user-token is bad' }] }) });
    const error = (await ctx.ah
      .graphql('query { member { id } }', {}, { auth: 'user' })
      .catch((e: unknown) => e)) as AhError;
    expect(error).toBeInstanceOf(AhError);
    expect(error.message).not.toContain('user-token');
  });

  it('recognises connect-phase failures for safe retries', () => {
    const error = new TypeError('fetch failed', { cause: { code: 'ECONNREFUSED' } });
    expect(connectFailure(error)).toBe('ECONNREFUSED');
    expect(connectFailure(new TypeError('fetch failed', { cause: { code: 'ECONNRESET' } }))).toBeUndefined();
  });
});
