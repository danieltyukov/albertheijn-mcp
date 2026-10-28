import { accessSync, constants, readdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { Config } from '../config.js';

export interface BrowserInfo {
  name: string;
  executablePath: string;
}

function exists(path: string): boolean {
  try {
    accessSync(path, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

function candidates(platform: NodeJS.Platform, env: NodeJS.ProcessEnv): BrowserInfo[] {
  const home = homedir();
  if (platform === 'win32') {
    const roots = [env.PROGRAMFILES, env['PROGRAMFILES(X86)'], env.LOCALAPPDATA].filter((r): r is string =>
      Boolean(r),
    );
    const list: BrowserInfo[] = [];
    for (const root of roots) {
      list.push({
        name: 'Google Chrome',
        executablePath: join(root, 'Google', 'Chrome', 'Application', 'chrome.exe'),
      });
      list.push({
        name: 'Microsoft Edge',
        executablePath: join(root, 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
      });
      list.push({
        name: 'Brave',
        executablePath: join(root, 'BraveSoftware', 'Brave-Browser', 'Application', 'brave.exe'),
      });
      list.push({ name: 'Chromium', executablePath: join(root, 'Chromium', 'Application', 'chrome.exe') });
    }
    return list;
  }
  if (platform === 'darwin') {
    return [
      {
        name: 'Google Chrome',
        executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
      },
      {
        name: 'Google Chrome',
        executablePath: join(home, 'Applications/Google Chrome.app/Contents/MacOS/Google Chrome'),
      },
      {
        name: 'Microsoft Edge',
        executablePath: '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
      },
      { name: 'Brave', executablePath: '/Applications/Brave Browser.app/Contents/MacOS/Brave Browser' },
      { name: 'Chromium', executablePath: '/Applications/Chromium.app/Contents/MacOS/Chromium' },
      { name: 'Arc', executablePath: '/Applications/Arc.app/Contents/MacOS/Arc' },
      { name: 'Vivaldi', executablePath: '/Applications/Vivaldi.app/Contents/MacOS/Vivaldi' },
    ];
  }
  const names = [
    ['Google Chrome', 'google-chrome'],
    ['Google Chrome', 'google-chrome-stable'],
    ['Chromium', 'chromium'],
    ['Chromium', 'chromium-browser'],
    ['Microsoft Edge', 'microsoft-edge'],
    ['Microsoft Edge', 'microsoft-edge-stable'],
    ['Brave', 'brave-browser'],
    ['Brave', 'brave'],
    ['Vivaldi', 'vivaldi'],
  ] as const;
  const dirs = [
    '/usr/bin',
    '/usr/local/bin',
    '/snap/bin',
    '/opt/google/chrome',
    '/var/lib/flatpak/exports/bin',
    join(home, '.local/bin'),
  ];
  const list: BrowserInfo[] = [];
  for (const [name, bin] of names)
    for (const dir of dirs) list.push({ name, executablePath: join(dir, bin) });
  list.push({ name: 'Google Chrome', executablePath: '/opt/google/chrome/chrome' });
  return list;
}

/** Chromium installed by "npx playwright-core install chromium" in the Playwright cache. */
function playwrightCached(platform: NodeJS.Platform, env: NodeJS.ProcessEnv): BrowserInfo | undefined {
  const cache =
    env.PLAYWRIGHT_BROWSERS_PATH && env.PLAYWRIGHT_BROWSERS_PATH !== '0'
      ? env.PLAYWRIGHT_BROWSERS_PATH
      : platform === 'win32'
        ? join(env.LOCALAPPDATA ?? join(homedir(), 'AppData', 'Local'), 'ms-playwright')
        : platform === 'darwin'
          ? join(homedir(), 'Library', 'Caches', 'ms-playwright')
          : join(env.XDG_CACHE_HOME ?? join(homedir(), '.cache'), 'ms-playwright');
  let entries: string[];
  try {
    entries = readdirSync(cache)
      .filter((name) => /^chromium-\d+$/.test(name))
      .sort();
  } catch {
    return undefined;
  }
  for (const entry of entries.reverse()) {
    const dir = join(cache, entry);
    const paths =
      platform === 'win32'
        ? [join(dir, 'chrome-win', 'chrome.exe'), join(dir, 'chrome-win64', 'chrome.exe')]
        : platform === 'darwin'
          ? [
              join(dir, 'chrome-mac', 'Chromium.app', 'Contents', 'MacOS', 'Chromium'),
              join(dir, 'chrome-mac-arm64', 'Chromium.app', 'Contents', 'MacOS', 'Chromium'),
            ]
          : [join(dir, 'chrome-linux', 'chrome'), join(dir, 'chrome-linux64', 'chrome')];
    for (const path of paths) if (exists(path)) return { name: 'Playwright Chromium', executablePath: path };
  }
  return undefined;
}

export function findBrowser(
  config: Pick<Config, 'browserPath'>,
  platform: NodeJS.Platform = process.platform,
  env: NodeJS.ProcessEnv = process.env,
): BrowserInfo | undefined {
  if (config.browserPath)
    return exists(config.browserPath)
      ? { name: 'Configured browser', executablePath: config.browserPath }
      : undefined;
  for (const candidate of candidates(platform, env)) if (exists(candidate.executablePath)) return candidate;
  return playwrightCached(platform, env);
}
