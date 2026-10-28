import { describe, expect, it } from 'vitest';
import { authorizeUrl, extractCode, loginRefused } from '../src/auth/login.js';
import { loadConfig } from '../src/config.js';

describe('login helpers', () => {
  it('builds the app login URL', () => {
    const url = new URL(authorizeUrl('https://login.ah.nl'));
    expect(url.origin + url.pathname).toBe('https://login.ah.nl/login');
    expect(url.searchParams.get('client_id')).toBe('appie-ios');
    expect(url.searchParams.get('redirect_uri')).toBe('appie://login-exit');
    expect(url.searchParams.get('response_type')).toBe('code');
  });

  it('recognises the login page being refused, not other 403s', () => {
    const login = 'https://login.ah.nl';
    expect(loginRefused(403, 'document', 'https://login.ah.nl/login?client_id=appie-ios', login)).toBe(true);
    expect(loginRefused(403, 'xhr', 'https://login.ah.nl/api/x', login)).toBe(false);
    expect(loginRefused(403, 'document', 'https://www.ah.nl/', login)).toBe(false);
    expect(loginRefused(200, 'document', 'https://login.ah.nl/login', login)).toBe(false);
  });

  it('pulls the code out of whatever the user pastes', () => {
    expect(extractCode('appie://login-exit?code=abc123DEF456')).toBe('abc123DEF456');
    expect(extractCode('appie%3A%2F%2Flogin-exit%3Fcode%3Dabc123DEF456')).toBe('abc123DEF456');
    expect(extractCode('  abc123DEF456  ')).toBe('abc123DEF456');
    expect(extractCode('Request URL: appie://login-exit?code=xyz98765&state=1')).toBe('xyz98765');
    expect(extractCode('nothing here')).toBeUndefined();
    expect(extractCode('')).toBeUndefined();
  });
});

describe('config', () => {
  it('accepts https origins and a local mock only', () => {
    expect(loadConfig({ AH_MCP_API_URL: 'https://api.ah.nl' }).apiUrl).toBe('https://api.ah.nl');
    expect(loadConfig({ AH_MCP_API_URL: 'http://127.0.0.1:9999' }).apiUrl).toBe('http://127.0.0.1:9999');
    expect(() => loadConfig({ AH_MCP_API_URL: 'http://evil.example.com' })).toThrow();
    expect(() => loadConfig({ AH_MCP_API_URL: 'https://api.ah.nl/path' })).toThrow();
  });
});
