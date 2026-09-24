// Diagnoses trusted input delivery: logs which events reach a fresh tab of the test page.
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
const client = new Client({ name: 'diag', version: '0' });
await client.connect(new StdioClientTransport({ command: 'node', args: ['server/index.js'], env: process.env }));
const call = async (name, args = {}) => {
  const r = await client.callTool({ name, arguments: args });
  const t = r.content.find((c) => c.type === 'text')?.text;
  if (!process.env.QUIET || r.isError || name === 'javascript_tool') console.log(`### ${name} ${args.action || ''} ${JSON.stringify(args.coordinate || args.text || '')}${r.isError ? ' [ERROR]' : ''}\n${t}\n`);
  return t;
};
for (let i = 0; i < 15 && (await client.callTool({ name: 'tabs_context', arguments: {} })).isError; i++) await new Promise((r) => setTimeout(r, 1000));
const created = await call('tabs_create', { url: 'http://localhost:8931/page.html' });
const tabId = Number(created.match(/Created tab (\d+)/)[1]);
await call('javascript_tool', { tabId, code: `
  window.__log = [];
  for (const t of ['mousedown', 'click', 'keydown', 'input']) addEventListener(t, (e) => window.__log.push(t + (e.isTrusted ? '' : '(untrusted)') + (e.clientX != null ? '@' + e.clientX + ',' + e.clientY : '') + (e.key ? ':' + e.key : '')), true);
  return 'hasFocus=' + document.hasFocus()` });
const steps = JSON.parse(process.argv[2]);
for (const s of steps) await call('computer', { tabId, ...s });
await call('javascript_tool', { tabId, code: 'return { log: window.__log, value: document.getElementById("q").value, hasFocus: document.hasFocus() }' });
if (!process.env.KEEP) await call('tabs_close', { tabId });
await client.close();
