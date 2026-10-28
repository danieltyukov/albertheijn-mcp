import { z } from 'zod';
import type { AppContext } from '../context.js';
import { browserLogin, completeLogin, extractCode } from '../auth/login.js';
import { authStatus, logout } from '../auth/status.js';
import { memberProfile } from '../ah/member.js';
import { AhError } from '../errors.js';
import { LOCAL, READ, type ToolRegistry } from './registry.js';

export function registerAccountTools(reg: ToolRegistry, _ctx: AppContext): void {
  reg.tool(
    'auth_status',
    {
      title: 'Sign-in status',
      description:
        'Whether an Albert Heijn account is signed in, until when the token is valid, and which browser sign-in would use. Set live to also check the API. Product, bonus, recipe and store tools work without signing in.',
      input: { live: z.boolean().default(false).describe('Also call the API once to verify the session') },
      annotations: READ,
    },
    async (args, ctx) => authStatus(ctx, args.live),
  );

  reg.tool(
    'auth_login',
    {
      title: 'Sign in to Albert Heijn',
      description:
        'Opens a browser window on the Albert Heijn login page on the computer running this server and waits up to ten minutes for the user to sign in. Call only when the user asks to sign in. If no browser can be opened, ask the user to sign in at the URL from auth_status and pass the address they land on (appie://login-exit?code=...) as redirectUrl.',
      input: {
        redirectUrl: z
          .string()
          .max(4000)
          .optional()
          .describe('The appie://login-exit?code=... address from a manual sign-in, or the bare code'),
      },
      annotations: LOCAL,
    },
    async (args, ctx) => {
      if (args.redirectUrl) {
        const code = extractCode(args.redirectUrl);
        if (!code) throw new AhError('INVALID_ARGUMENT', 'No login code found in that text.');
        return completeLogin(ctx, code, 'manual');
      }
      return browserLogin(ctx, (message) => process.stderr.write(`${message}\n`));
    },
  );

  reg.tool(
    'auth_logout',
    {
      title: 'Sign out',
      description:
        'Remove the saved Albert Heijn session and the sign-in browser profile from this computer.',
      input: {},
      annotations: { ...LOCAL, destructiveHint: true },
    },
    async (_args, ctx) => logout(ctx),
  );

  reg.tool(
    'get_profile',
    {
      title: 'Member profile',
      description:
        'Name, email, delivery address and the last digits of the Bonus card of the signed-in member. Needs sign-in.',
      input: {},
      annotations: READ,
    },
    async (_args, ctx) => memberProfile(ctx),
  );
}
