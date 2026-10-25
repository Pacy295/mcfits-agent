import { mcp } from '../src/mcp/client.js';
const store = '3350241';
const base = { storeCode: store, orderType: 1, beType: 1 };

const d1 = await mcp.callTool('query-meal-detail', { ...base, code: '1600' });
console.log('=== 1600 麦香鱼 ===');
console.log(JSON.stringify(d1.data, null, 1).slice(0, 1500));

const d2 = await mcp.callTool('query-meal-detail', { ...base, code: '9900005460' });
const r2 = d2.data.rounds;
console.log('\n=== 9900005460 rounds ===');
console.log('name:', d2.data.name, 'rounds:', r2.length, 'supportModify:', d2.data.supportModify);
for (const r of r2) {
  console.log(` round ${r.id} "${r.name}" quantity=${r.quantity} choices=${r.choices.length}`);
  console.log('   ', r.choices.map((c) => `${c.code}:${c.name}${c.isDefault ? '*' : ''}${c.diffPrice}`).join(' | ').slice(0, 900));
}

// 价格试算：默认组合
const itemsDefault = [
  {
    productCode: '9900005460',
    quantity: 1,
    roundList: [
      { round: '1', comboItemList: [{ code: '1600', quantity: 1 }] },
      { round: '2', comboItemList: [{ code: '4810', quantity: 1 }] },
      { round: '3', comboItemList: [{ code: '3050', quantity: 1 }] },
    ],
  },
];
const p1 = await mcp.callTool('calculate-price', { ...base, items: itemsDefault });
console.log('\n=== price default ===');
console.log(JSON.stringify(p1.data, null, 1).slice(0, 1200));
console.log('trace:', p1.traceId, p1.datetime);
