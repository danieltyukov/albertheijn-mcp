import { AhClient } from './ah/client.js';
import { SessionStore } from './auth/session.js';
import { loadConfig, type Config } from './config.js';
import { PreviewStore } from './previews.js';
import { TtlCache } from './util/cache.js';

export { debug, type Logger } from './util/debug.js';

export interface AppContext {
  config: Config;
  session: SessionStore;
  ah: AhClient;
  previews: PreviewStore;
  /** In-memory cache for data that does not change within a session (products, recipes, stores). */
  cache: TtlCache;
  close(): Promise<void>;
}

export function createContext(config: Config = loadConfig(), fetchImpl?: typeof fetch): AppContext {
  const session = new SessionStore(config.sessionFile);
  const ah = new AhClient(config, session, fetchImpl);
  const previews = new PreviewStore();
  const cache = new TtlCache();
  return {
    config,
    session,
    ah,
    previews,
    cache,
    async close() {
      previews.clear();
      cache.clear();
    },
  };
}

/** The account id previews are bound to; falls back to a fixed id for sessions without a profile. */
export async function accountId(ctx: AppContext): Promise<string> {
  const user = (await ctx.session.load()).user;
  return user?.memberId ?? (user ? 'signed-in' : 'anonymous');
}
