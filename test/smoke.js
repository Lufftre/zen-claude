// End-to-end smoke test: spawns the MCP server and drives the browser through it.
// Run with the extension loaded (npm run ext:run), then: node test/smoke.js
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { writeFileSync } from 'node:fs';

const client = new Client({ name: 'smoke', version: '0' });
await client.connect(new StdioClientTransport({ command: 'node', args: ['server/index.js'], stderr: 'inherit', env: process.env }));

const call = async (name, args = {}) => {
  const res = await client.callTool({ name, arguments: args });
  for (const c of res.content) {
    if (c.type === 'text') console.log(`\n### ${name} ${JSON.stringify(args)}${res.isError ? ' [ERROR]' : ''}\n${c.text.slice(0, 1500)}`);
    if (c.type === 'image') {
      const file = `test/out-${name}-${Date.now()}.jpg`;
      writeFileSync(file, Buffer.from(c.data, 'base64'));
      console.log(`[image saved to ${file}]`);
    }
  }
  return res;
};

// Wait for the extension to connect (it retries every 2s).
for (let i = 0; i < 15; i++) {
  const r = await client.callTool({ name: 'tabs_context', arguments: {} });
  if (!r.isError) break;
  await new Promise((r) => setTimeout(r, 1000));
}

const steps = JSON.parse(process.argv[2] || 'null') || [
  ['tabs_context'],
  ['navigate', { url: 'https://duckduckgo.com' }],
  ['find', { query: 'search' }],
  ['computer', { action: 'screenshot' }],
];
for (const [name, args] of steps) await call(name, args);
await client.close();
