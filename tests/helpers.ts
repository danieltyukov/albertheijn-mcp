import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { vi } from 'vitest';
import { loadConfig } from '../src/config.js';
import { createContext, type AppContext } from '../src/context.js';

const FIXTURES = join(dirname(fileURLToPath(import.meta.url)), 'fixtures');

export async function fixture<T = unknown>(name: string): Promise<T> {
  return JSON.parse(await readFile(join(FIXTURES, name), 'utf8')) as T;
}

export function json(body: unknown, init: ResponseInit = {}): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'content-type': 'application/json' },
    ...init,
  });
}

export interface Call {
  method: string;
  path: string;
  query: URLSearchParams;
  headers: Headers;
  body?: unknown;
  /** The first field name of a GraphQL operation, e.g. "basket" or "basketItemsAdd". */
  operation?: string;
}

export type Handler = (call: Call) => unknown | Response | Promise<unknown | Response>;

/** First selected field of a GraphQL document, which is how the routes below are keyed. */
export function operationOf(query: string): string | undefined {
  const body = query.slice(query.indexOf('{') + 1);
  return /^\s*([A-Za-z_]\w*)/.exec(body)?.[1];
}

/**
 * Mock fetch. Routes are keyed by REST path substring, or by "gql:<field>" for GraphQL.
 * Unmatched calls return 404 so a missing route shows up as a failure.
 */
export function mockApi(routes: Record<string, unknown | Handler>): Call[] {
  const calls: Call[] = [];
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
    const url = new URL(String(input));
    const raw = typeof init?.body === 'string' ? init.body : undefined;
    const body = raw ? (JSON.parse(raw) as unknown) : undefined;
    const call: Call = {
      method: init?.method ?? 'GET',
      path: url.pathname,
      query: url.searchParams,
      headers: new Headers(init?.headers),
      body,
    };
    if (url.pathname === '/graphql' && body && typeof (body as { query?: string }).query === 'string') {
      call.operation = operationOf((body as { query: string }).query);
    }
    calls.push(call);
    if (
      url.pathname === '/mobile-auth/v1/auth/token/anonymous' &&
      !routes['/mobile-auth/v1/auth/token/anonymous']
    )
      return json({ access_token: 'anon-token', refresh_token: 'anon-refresh', expires_in: 604798 });
    const keys = call.operation
      ? [`gql:${call.operation}`]
      : Object.keys(routes).filter((k) => !k.startsWith('gql:') && url.pathname.includes(k));
    for (const key of keys) {
      const value = routes[key];
      if (value === undefined) continue;
      const result = typeof value === 'function' ? await (value as Handler)(call) : value;
      if (result instanceof Response) return result;
      return json(call.operation ? { data: result } : result);
    }
    return new Response('{"message":"not mocked"}', { status: 404 });
  });
  return calls;
}

export async function anonymousContext(): Promise<AppContext> {
  const dir = await mkdtemp(join(tmpdir(), 'ah-mcp-'));
  return createContext(loadConfig({ AH_MCP_HOME: dir, AH_MCP_MIN_INTERVAL_MS: '0' }));
}

/** A signed-in context with fake tokens in a temp home. */
export async function signedInContext(memberId = '1001'): Promise<AppContext> {
  const ctx = await anonymousContext();
  await ctx.session.update((data) => {
    data.user = {
      accessToken: 'user-token',
      refreshToken: 'user-refresh',
      expiresAt: Date.now() + 3600_000,
      memberId,
      name: 'Sam',
      savedAt: new Date().toISOString(),
    };
  });
  return ctx;
}
