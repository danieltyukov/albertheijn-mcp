import type { Config } from '../config.js';
import { debug } from '../util/debug.js';
import { AhError } from '../errors.js';
import type { SessionStore, TokenSet, UserSession } from '../auth/session.js';
import { Single } from '../util/lane.js';
import { sleep } from '../util/sleep.js';

export type AuthMode = 'user' | 'any';

export interface RequestOptions {
  method?: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
  query?: Record<string, string | number | boolean | undefined | (string | number)[]>;
  body?: unknown;
  /** 'user' needs a signed-in session; 'any' uses it when present, else an anonymous token. */
  auth?: AuthMode;
  /** Return undefined instead of throwing on 404. */
  allow404?: boolean;
}

export interface GraphQLError {
  message?: string;
  extensions?: { code?: string; classification?: string };
}

/** Headers the Appie iOS app sends. REST rejects requests without x-application. */
export const APP_VERSION = '9.28';
export const APP_HEADERS: Record<string, string> = {
  'User-Agent': `Appie/${APP_VERSION} (iPhone17,3; iPhone; CPU OS 26_1 like Mac OS X)`,
  'x-client-name': 'appie-ios',
  'x-client-version': APP_VERSION,
  'x-application': 'AHWEBSHOP',
  Accept: 'application/json',
};

export const CLIENT_ID = 'appie-ios';
/** Refresh this long before the access token expires. */
const EXPIRY_MARGIN_MS = 5 * 60_000;

interface TokenResponse {
  access_token?: string;
  refresh_token?: string;
  expires_in?: number;
}

function tokenSet(raw: TokenResponse): TokenSet {
  if (!raw.access_token) throw new AhError('FORMAT_CHANGED', 'The token response had no access token.');
  const set: TokenSet = {
    accessToken: raw.access_token,
    expiresAt: Date.now() + (raw.expires_in ?? 3600) * 1000,
  };
  if (raw.refresh_token) set.refreshToken = raw.refresh_token;
  return set;
}

/** Strip anything that looks like a bearer token or token pair from upstream text. */
export function redact(text: string): string {
  return text
    .replace(/bearer\s+\S+/gi, 'Bearer [redacted]')
    .replace(/\b\d{6,}_[0-9a-f-]{20,}\b/gi, '[redacted]')
    .replace(/\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi, '[redacted]');
}

const CONNECT_ERRORS = new Set([
  'UND_ERR_CONNECT_TIMEOUT',
  'ECONNREFUSED',
  'ENOTFOUND',
  'EAI_AGAIN',
  'ENETUNREACH',
  'EHOSTUNREACH',
]);

/** The error code when a request failed before a connection was made, so it never reached the server. */
export function connectFailure(error: unknown): string | undefined {
  let current: unknown = error;
  for (let depth = 0; current && depth < 4; depth++) {
    const code = (current as { code?: unknown }).code;
    if (typeof code === 'string' && CONNECT_ERRORS.has(code)) return code;
    current = (current as { cause?: unknown }).cause;
  }
  return undefined;
}

function appendQuery(url: URL, query: RequestOptions['query']): void {
  if (!query) return;
  for (const [key, value] of Object.entries(query)) {
    if (value === undefined) continue;
    if (Array.isArray(value)) for (const item of value) url.searchParams.append(key, String(item));
    else url.searchParams.set(key, String(value));
  }
}

/**
 * Talks to api.ah.nl the way the Albert Heijn app does. Handles anonymous and user
 * tokens, refresh, pacing between calls and retries; never returns token material.
 */
export class AhClient {
  private lastCall = 0;
  private refreshing = new Single<UserSession | undefined>();
  private anonymousing = new Single<TokenSet>();

  constructor(
    private readonly config: Config,
    private readonly session: SessionStore,
    private readonly fetchImpl: typeof fetch = (...args) => fetch(...args),
  ) {}

  private async pace(): Promise<void> {
    const wait = this.lastCall + this.config.minIntervalMs - Date.now();
    this.lastCall = Math.max(Date.now(), this.lastCall + this.config.minIntervalMs);
    if (wait > 0) await sleep(wait);
  }

  private async raw(url: URL, init: RequestInit): Promise<Response> {
    const method = init.method ?? 'GET';
    for (let attempt = 0; ; attempt++) {
      await this.pace();
      const started = Date.now();
      try {
        const response = await this.fetchImpl(url, {
          ...init,
          signal: AbortSignal.timeout(this.config.timeoutMs),
        });
        debug(`${method} ${url.pathname} ${response.status} ${Date.now() - started} ms`);
        return response;
      } catch (error) {
        const timeout = error instanceof Error && error.name === 'TimeoutError';
        debug(
          `${method} ${url.pathname} failed after ${Date.now() - started} ms: ${connectFailure(error) ?? (timeout ? 'timeout' : 'network error')}`,
        );
        // Reads can always be repeated; writes only when the connection never opened.
        if (attempt < 2 && !timeout && (method === 'GET' || connectFailure(error))) {
          await sleep(500 * (attempt + 1));
          continue;
        }
        throw new AhError(
          'UNAVAILABLE',
          timeout
            ? 'Albert Heijn did not answer in time. Try again.'
            : 'Albert Heijn could not be reached. Check the connection.',
        );
      }
    }
  }

  private async postToken(path: string, body: Record<string, string>): Promise<TokenSet> {
    const url = new URL(path, this.config.apiUrl);
    const response = await this.raw(url, {
      method: 'POST',
      headers: { ...APP_HEADERS, 'Content-Type': 'application/json' },
      body: JSON.stringify({ clientId: CLIENT_ID, ...body }),
    });
    if (response.status === 400 || response.status === 401 || response.status === 403) {
      throw new AhError(
        'AUTH_REQUIRED',
        'Albert Heijn rejected the sign-in. Run "albertheijn-mcp login" again.',
      );
    }
    if (!response.ok)
      throw new AhError('UNAVAILABLE', `Albert Heijn sign-in answered with HTTP ${response.status}.`);
    return tokenSet((await response.json()) as TokenResponse);
  }

  /** Exchange the code from the appie://login-exit redirect for tokens. */
  async exchangeCode(code: string): Promise<TokenSet> {
    return this.postToken('/mobile-auth/v1/auth/token', { code });
  }

  private async anonymousToken(): Promise<string> {
    const saved = (await this.session.load()).anonymous;
    if (saved && saved.expiresAt - EXPIRY_MARGIN_MS > Date.now()) return saved.accessToken;
    const fresh = await this.anonymousing.run(async () => {
      const set = await this.postToken('/mobile-auth/v1/auth/token/anonymous', {});
      await this.session.update((data) => {
        data.anonymous = set;
      });
      return set;
    });
    return fresh.accessToken;
  }

  /** Refresh the user token. Returns undefined when there is no session or the refresh was refused. */
  async refreshUser(force = false): Promise<UserSession | undefined> {
    return this.refreshing.run(async () => {
      const user = (await this.session.load()).user;
      if (!user) return undefined;
      if (!force && user.expiresAt - EXPIRY_MARGIN_MS > Date.now()) return user;
      if (!user.refreshToken) return undefined;
      let set: TokenSet;
      try {
        set = await this.postToken('/mobile-auth/v1/auth/token/refresh', { refreshToken: user.refreshToken });
      } catch (error) {
        if (error instanceof AhError && error.code === 'AUTH_REQUIRED') return undefined;
        throw error;
      }
      const next: UserSession = { ...user, ...set, refreshToken: set.refreshToken ?? user.refreshToken };
      await this.session.update((data) => {
        data.user = next;
      });
      return next;
    });
  }

  async signedIn(): Promise<boolean> {
    return Boolean((await this.session.load()).user);
  }

  private async bearer(auth: AuthMode): Promise<{ token: string; user: boolean }> {
    const user = await this.refreshUser();
    if (user) return { token: user.accessToken, user: true };
    if (auth === 'user') {
      throw new AhError(
        'AUTH_REQUIRED',
        'This needs your Albert Heijn account. Run "albertheijn-mcp login" in a terminal, or call auth_login.',
      );
    }
    return { token: await this.anonymousToken(), user: false };
  }

  async request<T>(path: string, options: RequestOptions = {}): Promise<T> {
    const result = await this.requestMaybe<T>(path, options);
    return result as T;
  }

  async requestMaybe<T>(path: string, options: RequestOptions = {}): Promise<T | undefined> {
    const url = new URL(path, this.config.apiUrl);
    appendQuery(url, options.query);
    const auth = options.auth ?? 'any';
    for (let attempt = 0; attempt < 4; attempt++) {
      const { token, user } = await this.bearer(auth);
      const headers: Record<string, string> = { ...APP_HEADERS, Authorization: `Bearer ${token}` };
      if (options.body !== undefined) headers['Content-Type'] = 'application/json';
      const response = await this.raw(url, {
        method: options.method ?? 'GET',
        headers,
        ...(options.body !== undefined ? { body: JSON.stringify(options.body) } : {}),
      });
      // The API sometimes drops an anonymous token before it expires and answers 400
      // instead of 401. A fresh anonymous token is cheap, so try once more with one.
      if (response.status === 401 || (response.status === 400 && !user && attempt === 0)) {
        if (attempt === 0 && user && (await this.refreshUser(true))) continue;
        if (attempt === 0 && !user) {
          debug(`${url.pathname} refused the anonymous token (${response.status}), getting a new one`);
          await this.session.update((data) => {
            delete data.anonymous;
          });
          continue;
        }
        throw new AhError(
          'AUTH_REQUIRED',
          'The Albert Heijn session has expired. Run "albertheijn-mcp login" again.',
        );
      }
      if (response.status === 429 || response.status >= 500) {
        if (attempt < 3) {
          const retryAfter = Number(response.headers.get('retry-after'));
          await sleep(
            Number.isFinite(retryAfter) && retryAfter > 0
              ? Math.min(retryAfter, 10) * 1000
              : 800 * 2 ** attempt,
          );
          continue;
        }
        throw new AhError(
          response.status === 429 ? 'RATE_LIMITED' : 'UNAVAILABLE',
          response.status === 429
            ? 'Albert Heijn is limiting requests. Wait a minute.'
            : `Albert Heijn answered with HTTP ${response.status}.`,
        );
      }
      if (response.status === 404) {
        if (options.allow404) return undefined;
        throw new AhError('NOT_FOUND', 'Albert Heijn has no such item.');
      }
      if (response.status === 403)
        throw new AhError('PERMISSION_DENIED', 'Albert Heijn refused this request for your account.');
      if (!response.ok) {
        const detail = await response.text().catch(() => '');
        debug(`${url.pathname} answered ${response.status}: ${redact(detail.slice(0, 300))}`);
        throw new AhError('UNAVAILABLE', `Albert Heijn answered with HTTP ${response.status}.`, {
          status: response.status,
          ...(detail && detail.length < 300 && !/token/i.test(detail) ? { detail: redact(detail) } : {}),
        });
      }
      if (response.status === 204) return undefined;
      const text = await response.text();
      if (!text) return undefined;
      try {
        return JSON.parse(text) as T;
      } catch {
        throw new AhError('FORMAT_CHANGED', 'Albert Heijn returned something that is not JSON.');
      }
    }
    throw new AhError('UNAVAILABLE', 'Albert Heijn kept failing. Try again later.');
  }

  /** Run a GraphQL operation against /graphql. Throws on GraphQL errors unless allowPartial is set. */
  async graphql<T>(
    query: string,
    variables: Record<string, unknown> = {},
    options: { auth?: AuthMode; allowPartial?: boolean } = {},
  ): Promise<T> {
    const result = await this.request<{ data?: T; errors?: GraphQLError[] }>('/graphql', {
      method: 'POST',
      body: { query, variables },
      auth: options.auth ?? 'any',
    });
    if (result?.errors?.length && !(options.allowPartial && result.data)) {
      const first = result.errors[0];
      const code = first?.extensions?.code ?? first?.extensions?.classification;
      if (code === 'UNAUTHENTICATED' || code === 'UNAUTHORIZED')
        throw new AhError(
          'AUTH_REQUIRED',
          'This needs your Albert Heijn account. Run "albertheijn-mcp login".',
        );
      throw new AhError(
        'UNAVAILABLE',
        `Albert Heijn reported: ${redact(first?.message ?? 'unknown error').slice(0, 200)}`,
      );
    }
    if (!result?.data) throw new AhError('FORMAT_CHANGED', 'Albert Heijn returned no data.');
    return result.data;
  }
}
