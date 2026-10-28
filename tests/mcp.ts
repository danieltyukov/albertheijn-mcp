import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import type { AppContext } from '../src/context.js';
import { createServer } from '../src/server.js';
import { anonymousContext } from './helpers.js';

export async function connect(ctx?: AppContext) {
  const context = ctx ?? (await anonymousContext());
  const { server, registry } = createServer(context);
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  const client = new Client({ name: 'test', version: '0.0.0' });
  await client.connect(clientTransport);
  return { client, ctx: context, registry };
}

export async function call(client: Client, name: string, args: Record<string, unknown> = {}) {
  const result = await client.callTool({ name, arguments: args });
  return {
    isError: Boolean(result.isError),
    data: result.structuredContent as Record<string, unknown> & { error?: { code: string; message: string } },
  };
}
