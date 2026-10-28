import { createContext, type AppContext } from './context.js';
import { toSafeError } from './errors.js';
import { VERSION } from './version.js';

const HELP = `albertheijn-mcp ${VERSION}

Usage: albertheijn-mcp <command> [options]

Commands
  login [--manual] [--code URL]             Sign in once in a browser window (--manual: paste the redirect yourself)
  status                                    Show whether you are signed in and check the API live
  logout                                    Remove the saved session and the browser profile
  serve [--http] [--port N] [--host H]      Run the MCP server (stdio by default; --http listens on 127.0.0.1:3848)
        [--token T] [--show-token]          With --http: use this bearer token; print the token that is in use
        [--tunnel]                          With --http: expose it publicly through cloudflared or ngrok for ChatGPT
  setup [client...] [--all] [--dry-run]     Write MCP config for installed clients (claude-desktop, cursor, codex, ...)
        [--json] [--command npx|node]       Machine-readable summary; how clients start the server (default: auto)
  tools                                     List the tools this server exposes
  browser [install|which]                   Download Chromium, or show the browser that will be used

Environment
  AH_MCP_HOME             Data directory (default ~/.albertheijn-mcp)
  AH_MCP_BROWSER_PATH     Browser executable to use instead of auto-detection
  AH_MCP_DEBUG            Print diagnostics to stderr
`;

export interface ParsedArgs {
  command: string;
  positional: string[];
  flags: Record<string, string | boolean>;
}

export function parseArgs(argv: string[]): ParsedArgs {
  const [command = 'help', ...rest] = argv;
  const positional: string[] = [];
  const flags: Record<string, string | boolean> = {};
  for (let i = 0; i < rest.length; i++) {
    const arg = rest[i]!;
    if (arg.startsWith('--')) {
      const [key, inline] = arg.slice(2).split('=', 2);
      if (inline !== undefined) flags[key!] = inline;
      else if (rest[i + 1] && !rest[i + 1]!.startsWith('--')) flags[key!] = rest[++i]!;
      else flags[key!] = true;
    } else positional.push(arg);
  }
  return { command, positional, flags };
}

const log = (message: string): void => {
  process.stderr.write(`${message}\n`);
};

const print = (value: unknown): void => {
  process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
};

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  if (args.flags.version || args.command === '--version' || args.command === '-v') {
    process.stdout.write(`${VERSION}\n`);
    return;
  }
  if (args.command === 'help' || args.command === '--help' || args.command === '-h') {
    process.stdout.write(HELP);
    return;
  }
  const ctx = createContext();
  try {
    switch (args.command) {
      case 'serve': {
        const { serve } = await import('./transport/serve.js');
        await serve(ctx, args);
        return;
      }
      case 'login': {
        const { browserLogin, manualLogin } = await import('./auth/login.js');
        const code = typeof args.flags.code === 'string' ? args.flags.code : undefined;
        const report =
          args.flags.manual || code ? await manualLogin(ctx, log, code) : await browserLogin(ctx, log);
        print(report);
        return;
      }
      case 'logout': {
        const { logout } = await import('./auth/status.js');
        print(await logout(ctx));
        return;
      }
      case 'status':
      case 'doctor': {
        const { authStatus } = await import('./auth/status.js');
        print(await authStatus(ctx, true));
        return;
      }
      case 'tools': {
        const { createServer } = await import('./server.js');
        const { registry } = createServer(ctx);
        for (const tool of registry.tools)
          process.stdout.write(`${tool.name.padEnd(30)} ${tool.description.split('. ')[0]}\n`);
        process.stdout.write(`\n${registry.tools.length} tools\n`);
        return;
      }
      case 'setup': {
        const { runSetup } = await import('./setup/index.js');
        await runSetup(ctx, args, log);
        return;
      }
      case 'browser': {
        const { browserCommand } = await import('./auth/browser-cli.js');
        await browserCommand(ctx, args, log);
        return;
      }
      default:
        process.stderr.write(`Unknown command "${args.command}".\n\n${HELP}`);
        process.exitCode = 2;
    }
  } finally {
    if (args.command !== 'serve') await ctx.close().catch(() => undefined);
  }
}

export function runCli(): void {
  main().catch((error: unknown) => {
    const safe = toSafeError(error);
    process.stderr.write(`${safe.code}: ${safe.message}\n`);
    process.exitCode = 1;
  });
}

export type { AppContext };
runCli();
