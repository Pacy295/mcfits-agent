import { mcp } from '../src/mcp/client.js';
const r = await mcp.callTool('list-nutrition-foods', {});
const d = r.data;
console.log('type:', typeof d, Array.isArray(d) ? 'len=' + d.length : '');
if (typeof d === 'string') {
  console.log('--- head 800 ---');
  console.log(d.slice(0, 800));
  const lines = d.split(/\r?\n/);
  console.log('lines:', lines.length);
  console.log('--- last 3 ---');
  console.log(lines.slice(-3).join('\n'));
  const withComma = lines.filter((l) => (l.match(/,/g) || []).length !== 8);
  console.log('异常逗号数行:', withComma.length);
  console.log(withComma.slice(0, 5));
} else {
  console.log(JSON.stringify(d).slice(0, 1500));
}
