import { mcp } from '../src/mcp/client.js';
import { config, tokenStatus } from '../src/config.js';

console.log('token:', JSON.stringify(tokenStatus()));
console.log('url:', config.mcp.url);
const t0 = Date.now();
const tools = await mcp.listTools();
console.log('tools:', tools.length, `${Date.now() - t0}ms`);
const r = await mcp.callTool('now-time-info', {});
console.log('now-time-info:', JSON.stringify(r).slice(0, 400));
