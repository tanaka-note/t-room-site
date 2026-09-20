import { serveStdio } from '@modelcontextprotocol/server/stdio';
import { createServer } from './server.mjs';

// Local MCP only. Credentials stay in process memory, never tool arguments or stdout.
serveStdio(() => createServer({
  config: {
    accountId: process.env.CF_READ_ACCOUNT_ID,
    zoneIds: (process.env.CF_READ_ZONE_IDS || '').split(',').filter(Boolean),
    databaseIds: (process.env.CF_READ_DATABASE_IDS || '').split(',').filter(Boolean)
  },
  apiToken: process.env.CF_READ_API_TOKEN
}));
