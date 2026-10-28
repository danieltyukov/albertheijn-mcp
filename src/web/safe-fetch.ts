import { lookup as dnsLookup, type LookupAddress, type LookupOptions } from 'node:dns';
import { lookup } from 'node:dns/promises';
import { request as httpRequest } from 'node:http';
import { request as httpsRequest } from 'node:https';
import { BlockList, isIP } from 'node:net';
import { Readable } from 'node:stream';
import { createBrotliDecompress, createGunzip, createInflate } from 'node:zlib';
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

const BLOCKED_V4 = new BlockList();
for (const [network, prefix] of [
  ['0.0.0.0', 8],
  ['10.0.0.0', 8],
  ['100.64.0.0', 10],
  ['127.0.0.0', 8],
  ['169.254.0.0', 16],
  ['172.16.0.0', 12],
  ['192.0.0.0', 24],
  ['192.168.0.0', 16],
  ['198.18.0.0', 15],
  ['224.0.0.0', 3],
] as const)
  BLOCKED_V4.addSubnet(network, prefix, 'ipv4');

// Kept separate: a BlockList also matches IPv4 addresses against IPv4-mapped IPv6 rules.
const BLOCKED_V6 = new BlockList();
for (const [network, prefix] of [
  ['64:ff9b:1::', 48], // local-use NAT64
  ['100::', 64], // discard
  ['2001:db8::', 32], // documentation
  ['fc00::', 7], // unique local
  ['fe80::', 10], // link-local
  ['fec0::', 10], // old site-local
  ['ff00::', 8], // multicast
] as const)
  BLOCKED_V6.addSubnet(network, prefix, 'ipv6');

/** The 16 bytes of an IPv6 address, including forms with "::" and a trailing dotted IPv4. */
export function ipv6Bytes(address: string): number[] | undefined {
  let text = address.toLowerCase();
  const dotted = /(\d+\.\d+\.\d+\.\d+)$/.exec(text);
  if (dotted?.[1]) {
    const parts = dotted[1].split('.').map(Number);
    if (parts.some((n) => n > 255)) return undefined;
    text = `${text.slice(0, -dotted[1].length)}${((parts[0]! << 8) | parts[1]!).toString(16)}:${((parts[2]! << 8) | parts[3]!).toString(16)}`;
  }
  const halves = text.split('::');
  if (halves.length > 2) return undefined;
  const head = halves[0] ? halves[0].split(':') : [];
  const tail = halves.length === 2 && halves[1] ? halves[1].split(':') : [];
  const missing = 8 - head.length - tail.length;
  if (halves.length === 1 ? missing !== 0 : missing < 0) return undefined;
  const groups = [...head, ...Array<string>(halves.length === 2 ? missing : 0).fill('0'), ...tail];
  const bytes: number[] = [];
  for (const group of groups) {
    if (!/^[0-9a-f]{1,4}$/.test(group)) return undefined;
    const value = parseInt(group, 16);
    bytes.push(value >> 8, value & 0xff);
  }
  return bytes;
}

/**
 * True for loopback, private, link-local, carrier-grade NAT, multicast and reserved
 * ranges, including IPv4 addresses written inside IPv6 (mapped, compatible, NAT64) in
 * any notation. Anything that is not an IP address counts as private.
 */
export function isPrivateAddress(address: string): boolean {
  const bare = address.replace(/^\[|\]$/g, '').split('%')[0]!;
  const version = isIP(bare);
  if (version === 4) return BLOCKED_V4.check(bare, 'ipv4');
  if (version !== 6) return true;
  const bytes = ipv6Bytes(bare);
  if (!bytes) return true;
  const zeros = (from: number, to: number) => bytes.slice(from, to).every((b) => b === 0);
  const v4 = bytes.slice(12).join('.');
  // ::, ::1 and the deprecated IPv4-compatible ::a.b.c.d form.
  if (zeros(0, 12)) return true;
  // IPv4-mapped ::ffff:a.b.c.d
  if (zeros(0, 10) && bytes[10] === 0xff && bytes[11] === 0xff) return BLOCKED_V4.check(v4, 'ipv4');
  // NAT64 64:ff9b::a.b.c.d
  if (bytes[0] === 0 && bytes[1] === 0x64 && bytes[2] === 0xff && bytes[3] === 0x9b && zeros(4, 12))
    return BLOCKED_V4.check(v4, 'ipv4');
  return BLOCKED_V6.check(bare, 'ipv6');
}

/**
 * DNS lookup for outgoing page requests that refuses private answers, so the address
 * checked is the address connected to (no DNS rebinding between check and connect).
 */
export function guardedLookup(
  hostname: string,
  options: LookupOptions,
  callback: (error: NodeJS.ErrnoException | null, address: string | LookupAddress[], family?: number) => void,
): void {
  dnsLookup(hostname, { all: true, verbatim: true }, (error, addresses) => {
    if (error) return callback(error, '');
    const list = addresses as LookupAddress[];
    if (!list.length || list.some((a) => isPrivateAddress(a.address))) {
      return callback(Object.assign(new Error('refused private address'), { code: 'EPRIVATE' }), '');
    }
    if (options.all) return callback(null, list);
    const first = options.family ? (list.find((a) => a.family === options.family) ?? list[0]!) : list[0]!;
    callback(null, first.address, first.family);
  });
}

/** fetch-like GET over node:http(s) with the guarded lookup and transparent decompression. */
export function pinnedFetch(
  url: URL,
  init: { headers: Record<string, string>; signal: AbortSignal },
): Promise<Response> {
  return new Promise((resolve, reject) => {
    const send = url.protocol === 'https:' ? httpsRequest : httpRequest;
    const req = send(
      url,
      {
        method: 'GET',
        headers: { ...init.headers, 'Accept-Encoding': 'gzip, deflate, br' },
        lookup: guardedLookup as never,
        signal: init.signal,
      },
      (res) => {
        const encoding = String(res.headers['content-encoding'] ?? '').toLowerCase();
        let stream: Readable = res;
        if (encoding === 'gzip' || encoding === 'x-gzip') stream = res.pipe(createGunzip());
        else if (encoding === 'deflate') stream = res.pipe(createInflate());
        else if (encoding === 'br') stream = res.pipe(createBrotliDecompress());
        const headers = new Headers();
        for (const [key, value] of Object.entries(res.headers)) {
          if (value === undefined || key === 'content-encoding' || (encoding && key === 'content-length'))
            continue;
          headers.set(key, Array.isArray(value) ? value.join(', ') : value);
        }
        const status = res.statusCode ?? 502;
        const empty = status === 204 || status === 304;
        if (empty) res.resume();
        resolve(
          new Response(empty ? null : (Readable.toWeb(stream) as ReadableStream<Uint8Array>), {
            status: status < 200 || status > 599 ? 502 : status,
            headers,
          }),
        );
      },
    );
    req.on('error', (error: NodeJS.ErrnoException) =>
      reject(
        error.code === 'EPRIVATE'
          ? new AhError('INVALID_URL', 'That host points to a private or local address.')
          : error,
      ),
    );
    req.end();
  });
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
  const fetcher =
    options.fetchImpl ??
    ((target: URL, init: { headers: Record<string, string>; signal: AbortSignal }) =>
      pinnedFetch(target, init));
  let url = parsePublicUrl(raw);
  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    await assertPublicHost(url, resolve);
    let response: Response;
    try {
      response = await (
        fetcher as (
          u: URL,
          i: RequestInit & { headers: Record<string, string>; signal: AbortSignal },
        ) => Promise<Response>
      )(url, {
        redirect: 'manual',
        signal: AbortSignal.timeout(options.timeoutMs),
        headers: {
          'User-Agent': `Mozilla/5.0 (compatible; albertheijn-mcp/${VERSION}; +https://github.com/danieltyukov/albertheijn-mcp)`,
          Accept: 'text/html,application/xhtml+xml,application/ld+json;q=0.9,text/plain;q=0.8,*/*;q=0.5',
          'Accept-Language': 'nl-NL,nl;q=0.9,en;q=0.8',
        },
      });
    } catch (error) {
      if (error instanceof AhError) throw error;
      const timeout =
        error instanceof Error && (error.name === 'TimeoutError' || error.name === 'AbortError');
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
