export type Logger = (message: string) => void;

/** Diagnostics for AH_MCP_DEBUG=1, written to stderr so the MCP stream stays clean. */
export const debug: Logger = (message) => {
  if (process.env.AH_MCP_DEBUG) process.stderr.write(`[albertheijn-mcp] ${message}\n`);
};
