import { describe, expect, it } from 'vitest';
import { serverCommand } from '../src/setup/command.js';
import { VERSION } from '../src/version.js';

const globalEntry = '/home/me/.nvm/versions/node/v22.17.1/lib/node_modules/albertheijn-mcp/dist/cli.js';
const node = '/home/me/.nvm/versions/node/v22.17.1/bin/node';

describe('serverCommand', () => {
  it('writes absolute paths by default, so GUI clients without the shell PATH can start it', () => {
    expect(serverCommand({ entry: globalEntry, execPath: node })).toEqual({
      command: node,
      args: [globalEntry, 'serve'],
    });
    expect(serverCommand({ mode: 'node', entry: globalEntry, execPath: node })).toEqual({
      command: node,
      args: [globalEntry, 'serve'],
    });
  });

  it('points a source checkout at the built entry point', () => {
    expect(serverCommand({ entry: '/src/albertheijn-mcp/src/cli.ts', execPath: node }).args).toEqual([
      '/src/albertheijn-mcp/dist/cli.js',
      'serve',
    ]);
  });

  it('runs npx on this version of the GitHub release, never the bare registry name', () => {
    const entry = serverCommand({ mode: 'npx' });
    expect(entry.command).toBe('npx');
    expect(entry.args).toEqual([
      '-y',
      `--package=https://github.com/danieltyukov/albertheijn-mcp/releases/download/v${VERSION}/albertheijn-mcp.tgz`,
      'albertheijn-mcp',
      'serve',
    ]);
  });
});
