import { scrapeProduto } from './src/scraper.js';
import { closeChrome } from './src/chrome.js';
const t0 = Date.now();
const r = await scrapeProduto('https://www.ligapokemon.com.br/?view=prod/view&pcode=135107',
  (e, a, t) => { if (!t || a === t || (a && a % 20 === 0)) console.log('  ·', e); });
console.log(`\nproduto: ${r.produto}`);
console.log(`lojas: ${r.lojas.length} | sem telefone: ${r.semTelefone} | ${((Date.now()-t0)/1000).toFixed(1)}s`);
console.log('\namostra:');
for (const l of r.lojas.slice(0, 8)) console.log(`  ${l.nome.padEnd(28)} ${l.telefone}`);
const vazios = r.lojas.filter(l => !l.telefone);
if (vazios.length) console.log('\nsem telefone:', vazios.map(v => v.nome).join(', '));
closeChrome();
