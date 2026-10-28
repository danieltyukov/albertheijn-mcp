import { realpathSync } from 'node:fs';
import { isAbsolute, resolve } from 'node:path';
import { VERSION } from '../version.js';

/** How an MCP client should start this server. */
export interface ServerEntry {
  command: string;
  args: string[];
}

/**
 * auto, node: node plus the running cli.js, both as absolute paths. GUI clients such as
 *             Claude Desktop do not load the shell PATH, so a bare command installed through
 *             nvm or Homebrew is not found there.
 * npx:        npx with this version's GitHub release. Not the registry name, which this
 *             project has not published, so a package under it could be anyone's.
 */
export type CommandMode = 'auto' | 'npx' | 'node';

export const COMMAND_MODES: readonly CommandMode[] = ['auto', 'npx', 'node'];

export const RELEASE_TARBALL = `https://github.com/danieltyukov/albertheijn-mcp/releases/download/v${VERSION}/albertheijn-mcp.tgz`;

export interface CommandOptions {
  mode?: CommandMode;
  /** The running entry script, default process.argv[1]. */
  entry?: string;
  /** The node binary, default process.execPath. */
  execPath?: string;
}

export function serverCommand(options: CommandOptions = {}): ServerEntry {
  if (options.mode === 'npx') {
    return { command: 'npx', args: ['-y', `--package=${RELEASE_TARBALL}`, 'albertheijn-mcp', 'serve'] };
  }
  const given = options.entry ?? process.argv[1] ?? 'dist/cli.js';
  let entry = isAbsolute(given) ? given : resolve(given);
  // A global install runs through npm's bin symlink; write the file it points to.
  try {
    entry = realpathSync(entry);
  } catch {
    /* keep the path as given */
  }
  // Running from source through tsx: clients need the built entry point instead.
  entry = entry.replace(/([\\/])src[\\/]cli\.ts$/, '$1dist$1cli.js');
  return { command: options.execPath ?? process.execPath, args: [entry, 'serve'] };
}
