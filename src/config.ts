import { homedir } from 'node:os';
import { join, resolve } from 'node:path';

export interface Config {
  /** Data directory, default ~/.albertheijn-mcp */
  home: string;
  profileDir: string;
  sessionFile: string;
  apiUrl: string;
  loginUrl: string;
  /** Explicit browser executable, otherwise auto-detected. */
  browserPath: string | undefined;
  timeoutMs: number;
  loginTimeoutMs: number;
  /** Minimum gap between two calls to the AH API, to stay polite. */
  minIntervalMs: number;
  maxPageBytes: number;
}

function httpsOrigin(value: string, name: string): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error(`${name} must be a valid HTTPS origin.`);
  }
  // Plain http is accepted only for a local mock, which the end-to-end tests use.
  const local = url.protocol === 'http:' && (url.hostname === '127.0.0.1' || url.hostname === 'localhost');
  if (
    (url.protocol !== 'https:' && !local) ||
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    url.pathname !== '/'
  ) {
    throw new Error(`${name} must be a bare HTTPS origin such as https://api.ah.nl.`);
  }
  return url.origin;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const home = resolve(env.AH_MCP_HOME ?? join(homedir(), '.albertheijn-mcp'));
  return {
    home,
    profileDir: join(home, 'profile'),
    sessionFile: join(home, 'session.json'),
    apiUrl: httpsOrigin(env.AH_MCP_API_URL ?? 'https://api.ah.nl', 'AH_MCP_API_URL'),
    loginUrl: httpsOrigin(env.AH_MCP_LOGIN_URL ?? 'https://login.ah.nl', 'AH_MCP_LOGIN_URL'),
    browserPath: env.AH_MCP_BROWSER_PATH || undefined,
    timeoutMs: 30_000,
    loginTimeoutMs: Math.max(1, Number(env.AH_MCP_LOGIN_TIMEOUT_MIN ?? 10)) * 60_000,
    minIntervalMs: Number(env.AH_MCP_MIN_INTERVAL_MS ?? 120),
    maxPageBytes: 5 * 1024 * 1024,
  };
}

export const TIMEZONE = 'Europe/Amsterdam';
export const SERVER_NAME = 'albertheijn';
