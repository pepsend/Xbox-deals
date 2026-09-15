// ============================================================================
//  Xbox Deals — robot de datos (corre 1 vez al dia en GitHub Actions)
//  Enumera TODO el catalogo de Xbox por region, saca precios + descuentos,
//  les pega la nota (IGDB, opcional) y escribe public/data/*.json
//  Sin dependencias: usa fetch nativo de Node 18+.
// ============================================================================
import { mkdir, writeFile, readFile } from 'node:fs/promises';

// --- Regiones a comparar. La primera (CL) es la referencia -------------------
const REGIONS = [
  { code:'CL', name:'Chile',          locale:'es-CL', cur:'CLP', access:'Tu tienda',       giftCard:true, ref:true },
  { code:'AR', name:'Argentina',      locale:'es-AR', cur:'ARS', access:'Gift card',        giftCard:true },
  { code:'TR', name:'Turquia',        locale:'tr-TR', cur:'TRY', access:'Gift card',        giftCard:true },
  { code:'BR', name:'Brasil',         locale:'pt-BR', cur:'BRL', access:'Gift card',        giftCard:true },
  { code:'US', name:'Estados Unidos', locale:'en-US', cur:'USD', access:'Gift card',        giftCard:true },
  { code:'UA', name:'Ucrania',        locale:'uk-UA', cur:'UAH', access:'Gift card',        giftCard:true },
  { code:'PL', name:'Polonia',        locale:'pl-PL', cur:'PLN', access:'Gift card',        giftCard:true },
  { code:'CO', name:'Colombia',       locale:'es-CO', cur:'COP', access:'Gift card',        giftCard:true },
  { code:'IN', name:'India',          locale:'en-IN', cur:'INR', access:'Cambio de region', giftCard:false },
  { code:'NG', name:'Nigeria',        locale:'en-NG', cur:'NGN', access:'Cambio de region', giftCard:false },
  { code:'EG', name:'Egipto',         locale:'ar-EG', cur:'EGP', access:'Cambio de region', giftCard:false },
  { code:'ZA', name:'Sudafrica',      locale:'en-ZA', cur:'ZAR', access:'Cambio de region', giftCard:false },
];

const EMERALD = 'https://emerald.xboxservices.com/xboxcomfd/browse';
const HDRS = { 'Content-Type':'application/json', 'x-ms-api-version':'1.1', 'ms-cv':'xbxdeals.1' };
const b64 = (s) => Buffer.from(s).toString('base64');
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

// Limite opcional de paginas por region (para pruebas). 0 = todo el catalogo.
const MAX_PAGES = Number(process.env.MAX_PAGES || 0);

async function postJSON(url, body, tries = 4) {
  for (let i = 0; i < tries; i++) {
    try {
      const r = await fetch(url, { method:'POST', headers:HDRS, body: JSON.stringify(body) });
      if (r.ok) return await r.json();
      if (r.status === 429 || r.status >= 500) { await sleep(1500 * (i + 1)); continue; }
      throw new Error('HTTP ' + r.status);
    } catch (e) {
      if (i === tries - 1) throw e;
      await sleep(1500 * (i + 1));
    }
  }
}

// Recorre TODAS las paginas del catalogo para un locale y devuelve items.
async function crawlRegion(region) {
  const items = {}; // productId -> { title, img, list, msrp, cur, disc }
  let ct = b64(JSON.stringify({ HasMore:true, SkipCount:0, TotalCount:0, PreviousPageProductIds:[] }));
  let page = 0, total = 0;
  while (true) {
    const body = {
      Filters: b64('{}'),
      ReturnFilters: false,
      ChannelKeyToBeUsedInResponse: 'BROWSE_CHANNELID=_FILTERS=',
      EncodedCT: ct,
      ChannelId: '',
    };
    let j;
    try { j = await postJSON(`${EMERALD}?locale=${region.locale}`, body); }
    catch (e) { console.error(`  [${region.code}] pagina ${page} fallo: ${e.message}`); break; }

    const ch = j.channels ? j.channels[Object.keys(j.channels)[0]] : null;
    if (!ch) break;
    total = ch.totalItems || total;

    const ps = j.productSummaries || {};
    const av = j.availabilitySummaries || [];
    const avArr = Array.isArray(av) ? av : Object.values(av);
    const priceById = {};
    for (const a of avArr) if (a && a.price) priceById[a.productId] = a.price;

    const psArr = Array.isArray(ps) ? ps : Object.values(ps);
    for (const s of psArr) {
      const id = s.productId;
      if (!id) continue;
      const p = priceById[id];
      if (!p || !(p.listPrice > 0)) continue;         // omite gratis / sin precio
      if (s.productKind && s.productKind !== 'Game') continue; // solo juegos
      const disc = Math.round(p.discountPercentage || 0);
      items[id] = {
        title: s.title || items[id]?.title || id,
        img: pickImg(s) || items[id]?.img || null,
        year: yearOf(s),
        d: dateStr(s.releaseDate),
        list: p.listPrice, msrp: p.msrp || p.listPrice,
        cur: p.currency || region.cur,
        disc,
        ends: disc > 0 ? endDateOf(p.endDateUtc) : null,   // fecha fin de oferta
      };
    }

    page++;
    ct = ch.encodedCT;
    let more = false;
    try { more = JSON.parse(Buffer.from(ct, 'base64').toString()).HasMore; } catch {}
    if (!more || !ct) break;
    if (MAX_PAGES && page >= MAX_PAGES) break;
    if (page % 40 === 0) console.log(`  [${region.code}] ${page} pag, ${Object.keys(items).length} con precio...`);
    await sleep(60); // freno suave
  }
  console.log(`  [${region.code}] listo: ${Object.keys(items).length} juegos con precio (catalogo ~${total})`);
  return items;
}

function pickImg(s) {
  const imgs = s.images || {};
  const cand = imgs.boxArt || imgs.featurePromotionalSquareArt || imgs.poster || imgs.superHeroArt || (Array.isArray(imgs) ? imgs[0] : null);
  let u = cand && (cand.url || cand.uri || cand);
  if (!u || typeof u !== 'string') return null;
  if (u.startsWith('//')) u = 'https:' + u;
  return u.split('?')[0];
}
function yearOf(s) {
  const d = s.releaseDate || s.releaseDateUtc;
  if (!d) return null;
  const y = new Date(d).getFullYear();
  return (y > 1990 && y < 2100) ? y : null;
}
function endDateOf(s) {
  if (!s) return null;
  const d = new Date(s); const y = d.getFullYear();
  if (!(y > 2000 && y < 2100)) return null;   // ignora el placeholder lejano (9998)
  return d.toISOString().slice(0, 10);          // YYYY-MM-DD
}
function dateStr(x) {
  if (!x) return null;
  const d = new Date(x); const y = d.getFullYear();
  if (!(y > 1990 && y < 2100)) return null;
  return d.toISOString().slice(0, 10);          // fecha de lanzamiento YYYY-MM-DD
}

// --- Tipo de cambio (base CLP) ----------------------------------------------
async function getFX() {
  try {
    const j = await (await fetch('https://open.er-api.com/v6/latest/CLP')).json();
    return { rates: j.rates, date: j.time_last_update_utc };
  } catch { return { rates: null, date: '' }; }
}

// --- Notas IGDB (opcional; requiere TWITCH_CLIENT_ID/SECRET) -----------------
const norm = (s) => (s || '').toLowerCase()
  .replace(/[™®]/g, '')
  .replace(/[:'’\-–—]/g, ' ')
  .replace(/\b(edition|deluxe|standard|complete|goty|game of the year|digital|ultimate|bundle|remastered|definitive|anniversary|gold|premium)\b/g, ' ')
  .replace(/[^a-z0-9 ]/g, ' ').replace(/\s+/g, ' ').trim();

async function getRatings() {
  const id = process.env.TWITCH_CLIENT_ID, secret = process.env.TWITCH_CLIENT_SECRET;
  if (!id || !secret) { console.log('IGDB: sin credenciales, se omiten notas.'); return {}; }
  try {
    const tok = await (await fetch(`https://id.twitch.tv/oauth2/token?client_id=${id}&client_secret=${secret}&grant_type=client_credentials`, { method:'POST' })).json();
    const h = { 'Client-ID': id, 'Authorization': 'Bearer ' + tok.access_token };
    const map = {};
    // Trae juegos con nota critica (aggregated_rating), paginando.
    for (let off = 0; off < 20000; off += 500) {
      const q = `fields name,aggregated_rating,genres.name; where aggregated_rating != null & aggregated_rating_count >= 3; sort aggregated_rating desc; limit 500; offset ${off};`;
      const rows = await (await fetch('https://api.igdb.com/v4/games', { method:'POST', headers:h, body:q })).json();
      if (!Array.isArray(rows) || rows.length === 0) break;
      for (const g of rows) {
        const k = norm(g.name);
        if (k && !map[k]) {
          const genres = (g.genres || []).map(x => x.name).filter(Boolean);
          map[k] = { mc: Math.round(g.aggregated_rating), g: genres };
        }
      }
      await sleep(280); // IGDB ~4 req/s
    }
    console.log(`IGDB: ${Object.keys(map).length} juegos con nota.`);
    return map;
  } catch (e) { console.error('IGDB fallo:', e.message); return {}; }
}

// --- Main -------------------------------------------------------------------
async function main() {
  console.log('== Xbox Deals: iniciando ==');
  const { rates, date: fxDate } = await getFX();
  if (!rates) throw new Error('No pude obtener tipo de cambio.');
  const ratings = await getRatings();

  const byRegion = {};
  console.log(`Recorriendo ${REGIONS.length} regiones en paralelo...`);
  await Promise.all(REGIONS.map(async (r) => { byRegion[r.code] = await crawlRegion(r); }));

  const refCode = REGIONS.find(r => r.ref).code;
  const allIds = new Set();
  for (const r of REGIONS) Object.keys(byRegion[r.code]).forEach(id => allIds.add(id));

  const toCLP = (amt, cur) => (cur === 'CLP') ? amt : (rates[cur] ? amt / rates[cur] : null);
  const games = [];
  for (const id of allIds) {
    const base = byRegion[refCode][id] || firstMeta(byRegion, id);
    if (!base) continue;
    const prices = {};
    for (const r of REGIONS) {
      const it = byRegion[r.code][id];
      if (!it) continue;
      const clp = toCLP(it.list, it.cur);
      if (clp == null) continue;
      const cell = [Math.round(it.list * 100) / 100, Math.round(clp), it.disc]; // [local, clp, disc%, (fin)]
      if (it.ends) cell.push(it.ends);
      prices[r.code] = cell;
    }
    if (Object.keys(prices).length === 0) continue;
    games.push({
      id, t: base.title, img: base.img, y: base.year || null, d: base.d || null,
      mc: ratings[norm(base.title)]?.mc ?? null,
      g: ratings[norm(base.title)]?.g ?? [],
      r: prices,
    });
  }

  // Proteccion: si una corrida trae muy pocos juegos, algo fallo -> no pisamos los datos buenos.
  if (games.length < 3000) throw new Error('Solo ' + games.length + ' juegos con precio; parece corrida fallida, NO sobreescribo.');

  games.sort((a, b) => (b.mc ?? -1) - (a.mc ?? -1));
  await mkdir('public/data', { recursive: true });

  // --- Historial de precios (#2): acumula solo cuando el precio cambia ----------
  let history = {};
  try { history = JSON.parse(await readFile('public/data/history.json', 'utf8')); } catch {}
  const today = new Date().toISOString().slice(0, 10); // YYYY-MM-DD
  for (const g of games) {
    if (!history[g.id]) history[g.id] = {};
    for (const [regionCode, cell] of Object.entries(g.r)) {
      const clp = cell[1];
      const disc = cell[2] || 0;
      if (!history[g.id][regionCode]) history[g.id][regionCode] = [];
      const entries = history[g.id][regionCode];
      const last = entries[entries.length - 1];
      // Solo agrega si no hay entradas o si el precio cambio
      if (!last || last[1] !== clp) {
        entries.push([today, clp, disc]);
        // Cap: maximo 60 entradas por juego/region
        if (entries.length > 60) history[g.id][regionCode] = entries.slice(-60);
      }
    }
  }
  await writeFile('public/data/history.json', JSON.stringify(history));
  console.log(`Historial: ${Object.keys(history).length} juegos con datos historicos.`);
  // ---------------------------------------------------------------------------

  await writeFile('public/data/games.json', JSON.stringify(games));
  await writeFile('public/data/meta.json', JSON.stringify({
    updated: new Date().toISOString(),
    fxDate, count: games.length,
    withRating: games.filter(g => g.mc != null).length,
    regions: REGIONS,
  }));
  console.log(`== Listo: ${games.length} juegos escritos (${games.filter(g=>g.mc!=null).length} con nota) ==`);
}
function firstMeta(byRegion, id) { for (const c of Object.keys(byRegion)) if (byRegion[c][id]) return byRegion[c][id]; return null; }

main().catch(e => { console.error('ERROR:', e); process.exit(1); });
