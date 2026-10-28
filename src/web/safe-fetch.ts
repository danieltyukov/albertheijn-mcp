import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';
import { AhError } from '../errors.js';
import { VERSION } from '../version.js';

export interface FetchedPage {
  url: string;
  status: number;
  contentType: string;
  body: string;
}

export interface SafeFetchOptions {
  maxBytes: number;
  timeoutMs: number;
  /** Resolver injection for tests. */
  resolve?: (host: string) => Promise<string[]>;
  fetchImpl?: typeof fetch;
}

const MAX_REDIRECTS = 5;

/** True for loopback, private, link-local, carrier-grade NAT, multicast and reserved ranges. */
export function isPrivateAddress(address: string): boolean {
  const version = isIP(address);
  if (version === 4) {
    const [a = 0, b = 0] = address.split('.').map(Number);
    return (
      a === 0 ||
      a === 10 ||
      a === 127 ||
      (a === 100 && b >= 64 && b <= 127) ||
      (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 168) ||
      (a === 198 && (b === 18 || b === 19)) ||
      a >= 224
    );
  }
  if (version === 6) {
    const lower = address.toLowerCase();
    if (lower === '::' || lower === '::1') return true;
    const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(lower);
    if (mapped?.[1]) return isPrivateAddress(mapped[1]);
    return /^(fc|fd|fe8|fe9|fea|feb|ff)/.test(lower);
  }
  return true;
}

async function defaultResolve(host: string): Promise<string[]> {
  const records = await lookup(host, { all: true, verbatim: true });
  return records.map((record) => record.address);
}

/** Parse and vet a user-supplied URL: public http(s) only, no credentials, default ports. */
export function parsePublicUrl(raw: string): URL {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new AhError('INVALID_URL', 'That is not a valid URL.');
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:')
    throw new AhError('INVALID_URL', 'Only http and https URLs can be read.');
  if (url.username || url.password) throw new AhError('INVALID_URL', 'URLs with credentials are not read.');
  if (url.port && url.port !== '80' && url.port !== '443')
    throw new AhError('INVALID_URL', 'Only the default web ports are allowed.');
  const host = url.hostname.replace(/^\[|\]$/g, '');
  if (
    host === 'localhost' ||
    host.endsWith('.localhost') ||
    host.endsWith('.local') ||
    host.endsWith('.internal')
  )
    throw new AhError('INVALID_URL', 'Local addresses are not read.');
  if (isIP(host) && isPrivateAddress(host))
    throw new AhError('INVALID_URL', 'Private addresses are not read.');
  return url;
}

async function assertPublicHost(url: URL, resolve: (host: string) => Promise<string[]>): Promise<void> {
  const host = url.hostname.replace(/^\[|\]$/g, '');
  if (isIP(host)) return;
  let addresses: string[];
  try {
    addresses = await resolve(host);
  } catch {
    throw new AhError('EXTERNAL_RESOURCE', `Could not resolve ${host}.`);
  }
  if (!addresses.length || addresses.some(isPrivateAddress))
    throw new AhError('INVALID_URL', 'That host points to a private or local address.');
}

/**
 * Fetch a public web page for reading. Follows redirects by hand so every hop is
 * checked against private address ranges, and stops reading past maxBytes.
 */
export async function safeFetch(raw: string, options: SafeFetchOptions): Promise<FetchedPage> {
  const resolve = options.resolve ?? defaultResolve;
  const fetcher = options.fetchImpl ?? fetch;
  let url = parsePublicUrl(raw);
  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    await assertPublicHost(url, resolve);
    let response: Response;
    try {
      response = await fetcher(url, {
        redirect: 'manual',
        signal: AbortSignal.timeout(options.timeoutMs),
        headers: {
          'User-Agent': `Mozilla/5.0 (compatible; albertheijn-mcp/${VERSION}; +https://github.com/danieltyukov/albertheijn-mcp)`,
          Accept: 'text/html,application/xhtml+xml,application/ld+json;q=0.9,text/plain;q=0.8,*/*;q=0.5',
          'Accept-Language': 'nl-NL,nl;q=0.9,en;q=0.8',
        },
      });
    } catch (error) {
      const timeout = error instanceof Error && error.name === 'TimeoutError';
      throw new AhError(
        'EXTERNAL_RESOURCE',
        timeout ? 'The page took too long to respond.' : 'The page could not be reached.',
      );
    }
    if (response.status >= 300 && response.status < 400 && response.headers.get('location')) {
      url = parsePublicUrl(new URL(response.headers.get('location')!, url).toString());
      continue;
    }
    const contentType = response.headers.get('content-type') ?? '';
    const declared = Number(response.headers.get('content-length'));
    if (Number.isFinite(declared) && declared > options.maxBytes)
      throw new AhError('FILE_TOO_LARGE', 'The page is larger than the reading limit.');
    const reader = response.body?.getReader();
    const chunks: Uint8Array[] = [];
    let size = 0;
    if (reader) {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        size += value.byteLength;
        if (size > options.maxBytes) {
          await reader.cancel().catch(() => undefined);
          throw new AhError('FILE_TOO_LARGE', 'The page is larger than the reading limit.');
        }
        chunks.push(value);
      }
    }
    const body = new TextDecoder('utf-8', { fatal: false }).decode(Buffer.concat(chunks));
    if (response.status >= 400)
      throw new AhError('EXTERNAL_RESOURCE', `The page answered with HTTP ${response.status}.`, {
        status: response.status,
      });
    return { url: url.toString(), status: response.status, contentType, body };
  }
  throw new AhError('EXTERNAL_RESOURCE', 'Too many redirects.');
}
