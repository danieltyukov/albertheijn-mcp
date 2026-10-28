import { describe, expect, it } from 'vitest';
import { guardedLookup, isPrivateAddress, parsePublicUrl, safeFetch } from '../src/web/safe-fetch.js';

const publicDns = async () => ['93.184.216.34'];

function fakeFetch(pages: Record<string, Response | (() => Response)>): typeof fetch {
  return (async (input: string | URL) => {
    const page = pages[String(input)];
    if (!page) return new Response('missing', { status: 404 });
    return typeof page === 'function' ? page() : page.clone();
  }) as typeof fetch;
}

describe('safe fetch', () => {
  it('classifies private and public addresses', () => {
    for (const ip of [
      '127.0.0.1',
      '10.1.2.3',
      '172.16.0.1',
      '192.168.1.1',
      '169.254.169.254',
      '100.64.0.1',
      '::1',
      'fd00::1',
      '::ffff:127.0.0.1',
      '0.0.0.0',
    ])
      expect(isPrivateAddress(ip), ip).toBe(true);
    for (const ip of ['93.184.216.34', '2a00:1450:4001::1', '::ffff:5db8:d822', '64:ff9b::5db8:d822'])
      expect(isPrivateAddress(ip), ip).toBe(false);
  });

  it('sees IPv4 inside IPv6 in every notation the URL parser produces', () => {
    for (const ip of [
      '::ffff:7f00:1',
      '::ffff:a9fe:a9fe',
      '64:ff9b::7f00:1',
      '::7f00:1',
      '::127.0.0.1',
      'fe80::1%eth0',
      'not-an-ip',
    ])
      expect(isPrivateAddress(ip), ip).toBe(true);
    for (const url of [
      'http://[::ffff:127.0.0.1]/',
      'http://[::ffff:169.254.169.254]/',
      'http://[64:ff9b::a00:1]/',
      'http://0x7f.1/',
      'http://2130706433/',
    ])
      expect(() => parsePublicUrl(url), url).toThrow();
  });

  it('refuses local, private, credentialed and odd-port URLs', () => {
    for (const url of [
      'http://localhost/',
      'http://127.0.0.1/',
      'http://[::1]/',
      'file:///etc/passwd',
      'https://user:pw@example.com/',
      'https://example.com:8080/',
      'http://router.local/',
    ])
      expect(() => parsePublicUrl(url), url).toThrow();
    expect(parsePublicUrl('https://example.com/recipe').hostname).toBe('example.com');
  });

  it('refuses hosts that resolve to private addresses', async () => {
    await expect(
      safeFetch('https://internal.example.com/', {
        maxBytes: 1000,
        timeoutMs: 1000,
        resolve: async () => ['10.0.0.5'],
        fetchImpl: fakeFetch({}),
      }),
    ).rejects.toMatchObject({ code: 'INVALID_URL' });
  });

  it('checks every redirect hop', async () => {
    const fetchImpl = fakeFetch({
      'https://example.com/a': new Response('', {
        status: 302,
        headers: { location: 'http://169.254.169.254/latest/meta-data' },
      }),
    });
    await expect(
      safeFetch('https://example.com/a', { maxBytes: 1000, timeoutMs: 1000, resolve: publicDns, fetchImpl }),
    ).rejects.toMatchObject({
      code: 'INVALID_URL',
    });
  });

  it('follows public redirects and stops at the size limit', async () => {
    const fetchImpl = fakeFetch({
      'https://example.com/a': new Response('', { status: 301, headers: { location: '/b' } }),
      'https://example.com/b': new Response('<html>ok</html>', {
        status: 200,
        headers: { 'content-type': 'text/html' },
      }),
      'https://example.com/big': () => new Response('x'.repeat(5000), { status: 200 }),
    });
    const page = await safeFetch('https://example.com/a', {
      maxBytes: 1000,
      timeoutMs: 1000,
      resolve: publicDns,
      fetchImpl,
    });
    expect(page).toMatchObject({ url: 'https://example.com/b', body: '<html>ok</html>' });
    await expect(
      safeFetch('https://example.com/big', {
        maxBytes: 1000,
        timeoutMs: 1000,
        resolve: publicDns,
        fetchImpl,
      }),
    ).rejects.toMatchObject({
      code: 'FILE_TOO_LARGE',
    });
  });
});

describe('guarded lookup', () => {
  it('refuses a hostname that resolves to loopback', async () => {
    const error = await new Promise<NodeJS.ErrnoException | null>((resolve) =>
      guardedLookup('localhost', {}, (e) => resolve(e)),
    );
    expect(error?.code).toBe('EPRIVATE');
  });
});
