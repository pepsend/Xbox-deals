// ============================================================================
//  Xbox Deals — robot de datos (corre 1 vez al dia en GitHub Actions)
//  Enumera TODO el catalogo de Xbox por region, saca precios + descuentos,
//  les pega la nota (IGDB, opcional) y escribe public/data/*.json
//  Sin dependencias: usa fetch nativo de Node 18+.
import { mkdir, writeFile, readFile } from 'node:fs/promises';
import { crawlAddons } from './crawl-addons.mjs';

// --- Regiones a comparar. La primera (CL) es la referencia -------------------
const REGIONS = [
  { code:'CL', name:'Chile',          locale:'es-CL', cur:'CLP', access:'Tu tienda',       giftCard:true, ref:true },
  { code:'AR', name:'Argentina',      locale:'es-AR', cur:'ARS', access:'Gift card',        giftCard:true },
  { code:'TR', name:'Turquia',        locale:'tr-TR', cur:'TRY', access:'Gift card',        giftCard:true },
  { code:'BR', name:'Brasil',         locale:'pt-BR', cur:'BRL', access:'Gift card',        giftCard:true },
  { code:'US', name:'Estados Unidos', locale:'en-US', cur:'USD', access:'Gift card',        giftCard:true },
  { code:'MX', name:'Mexico',         locale:'es-MX', cur:'MXN', access:'Gift card',        giftCard:true },
  { code:'JP', name:'Japon',          locale:'ja-JP', cur:'JPY', access:'Gift card',        giftCard:true },
  { code:'SA', name:'Arabia Saudita', locale:'ar-SA', cur:'SAR', access:'Gift card',        giftCard:true },
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

// Extrae productos y disponibilidad con precios de una respuesta de emerald
function extractProducts(j, items, region) {
  if (!j) return 0;
  const ps = j.productSummaries || {};
  const av = j.availabilitySummaries || [];
  const avArr = Array.isArray(av) ? av : Object.values(av);
  const priceById = {};
  for (const a of avArr) if (a && a.price) priceById[a.productId] = a.price;

  const psArr = Array.isArray(ps) ? ps : Object.values(ps);
  let added = 0;
  for (const s of psArr) {
    const id = s.productId;
    if (!id) continue;
    const p = priceById[id];
    if (!p || !(p.listPrice > 0)) continue;         // omite gratis / sin precio
    if (s.productKind && s.productKind !== 'Game' && s.productKind !== 'Bundle') continue; // solo juegos y bundles
    const disc = Math.round(p.discountPercentage || 0);
    if (!items[id]) added++;
    items[id] = {
      title: s.title || items[id]?.title || id,
      img: pickImg(s) || items[id]?.img || null,
      year: yearOf(s) || items[id]?.year,
      d: dateStr(s.releaseDate) || items[id]?.d,
      list: p.listPrice, msrp: p.msrp || p.listPrice,
      cur: p.currency || region.cur,
      disc,
      ends: disc > 0 ? endDateOf(p.endDateUtc) : null,   // fecha fin de oferta
      cats: (s.categories || []).filter(c => c && c !== 'Otros' && c !== 'Other'),
    };
  }
  return added;
}

// Recorre el catalogo para un locale de forma ultra-agresiva:
// 1) Primero barre lanzamientos recientes ordenados por fecha (ReleaseDate desc)
// 2) Búsqueda agresiva de nuevos juegos (/search/Games)
// 3) Recorrido completo del catalogo general
async function crawlRegion(region) {
  const items = {}; // productId -> { title, img, list, msrp, cur, disc }

  // --- FASE 1 (ULTRA-AGRESIVA): Lanzamientos más recientes primero ---
  // Garantiza que el 100% de los juegos lanzados hoy, ayer y en las últimas semanas
  // sean capturados de inmediato sin importar la popularidad.
  try {
    const relFilter = b64(JSON.stringify({
      orderby: { id: 'orderby', choices: [{ id: 'ReleaseDate desc' }] }
    }));
    const relKey = 'BROWSE_CHANNELID=_FILTERS=ORDERBY=RELEASEDATE DESC';
    let ctRel = b64(JSON.stringify({ HasMore:true, SkipCount:0, TotalCount:0, PreviousPageProductIds:[] }));
    let relPage = 0;
    const MAX_REL = Number(process.env.MAX_REL_PAGES || 50); // 50 pags = ~1.250 títulos más recientes
    while (relPage < MAX_REL) {
      const body = {
        Filters: relFilter,
        ReturnFilters: false,
        ChannelKeyToBeUsedInResponse: relKey,
        EncodedCT: ctRel,
        ChannelId: '',
      };
      let j;
      try { j = await postJSON(`${EMERALD}?locale=${region.locale}`, body); }
      catch (e) { break; }
      if (!j) break;
      const ch = j.channels ? j.channels[relKey] : null;
      extractProducts(j, items, region);
      relPage++;
      if (!ch || !ch.encodedCT) break;
      ctRel = ch.encodedCT;
      let more = false;
      try { more = JSON.parse(Buffer.from(ctRel, 'base64').toString()).HasMore; } catch {}
      if (!more) break;
      await sleep(40);
    }
    console.log(`  [${region.code}] Escaneo agresivo por fecha: ${Object.keys(items).length} capturados en ${relPage} pags.`);
  } catch (err) {
    console.error(`  [${region.code}] Error en barrido por fecha: ${err.message}`);
  }

  // --- FASE 2: Búsqueda agresiva de títulos (/search/Games) para atrapar indies recientes ---
  try {
    const searchChars = ['a', 'e', 'i', 'o', 'u', 's', 'r', 't', '2', '0'];
    for (const char of searchChars) {
      const body = {
        Query: char,
        Filters: b64('{}'),
        ReturnFilters: false,
        ChannelKeyToBeUsedInResponse: 'SEARCH',
        EncodedCT: b64(JSON.stringify({ HasMore:true, SkipCount:0, TotalCount:0, PreviousPageProductIds:[] })),
        ChannelId: '',
      };
      let j;
      try { j = await postJSON(`https://emerald.xboxservices.com/xboxcomfd/search/Games?locale=${region.locale}`, body); }
      catch (e) { continue; }
      if (j) extractProducts(j, items, region);
      await sleep(30);
    }
  } catch (err) {
    // Si falla la búsqueda, el catálogo general igual cubre
  }

  // --- FASE 3: Recorrido completo del catálogo general con reintentos robustos ---
  let ct = b64(JSON.stringify({ HasMore:true, SkipCount:0, TotalCount:0, PreviousPageProductIds:[] }));
  let page = 0, total = 0, errCount = 0;
  while (true) {
    const body = {
      Filters: b64('{}'),
      ReturnFilters: false,
      ChannelKeyToBeUsedInResponse: 'BROWSE_CHANNELID=_FILTERS=',
      EncodedCT: ct,
      ChannelId: '',
    };
    let j;
    try {
      j = await postJSON(`${EMERALD}?locale=${region.locale}`, body);
      errCount = 0;
    }
    catch (e) {
      console.error(`  [${region.code}] pagina ${page} fallo: ${e.message}`);
      errCount++;
      if (errCount >= 3) break; // solo aborta si 3 paginas consecutivas fallan
      await sleep(800);
      page++;
      continue;
    }

    const ch = j.channels ? j.channels[Object.keys(j.channels)[0]] : null;
    if (!ch) break;
    total = ch.totalItems || total;

    extractProducts(j, items, region);

    page++;
    ct = ch.encodedCT;
    let more = false;
    try { more = JSON.parse(Buffer.from(ct, 'base64').toString()).HasMore; } catch {}
    if (!more || !ct) break;
    if (MAX_PAGES && page >= MAX_PAGES) break;
    if (page % 50 === 0) console.log(`  [${region.code}] ${page} pag, ${Object.keys(items).length} con precio...`);
    await sleep(50);
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
    const today = new Date().toISOString().slice(0, 10);
    const prices = {};
    for (const r of REGIONS) {
      const it = byRegion[r.code][id];
      if (!it) continue;
      const clp = toCLP(it.list, it.cur);
      if (clp == null) continue;
      const isExpired = it.ends && it.ends < today;
      const disc = isExpired ? 0 : it.disc;
      const cell = [Math.round(it.list * 100) / 100, Math.round(clp), disc];
      if (it.ends && !isExpired) cell.push(it.ends);
      prices[r.code] = cell;
    }
    if (Object.keys(prices).length === 0) continue;
    const entry = {
      id, t: base.title, img: base.img, y: base.year || null, d: base.d || null,
      mc: ratings[norm(base.title)]?.mc ?? null,
      r: prices,
    };
    const igdbGenres = ratings[norm(base.title)]?.g || [];
    const storeCats = base.cats || [];
    const merged = [...new Set([...storeCats, ...igdbGenres])];
    if (merged.length) entry.g = merged;
    games.push(entry);
  }

  // Proteccion: si una corrida trae muy pocos juegos, algo fallo -> no pisamos los datos buenos.
  if (games.length < 3000) throw new Error('Solo ' + games.length + ' juegos con precio; parece corrida fallida, NO sobreescribo.');

  const today = new Date().toISOString().slice(0, 10); // YYYY-MM-DD

  // Ordenar API / catálogo: nuevos lanzamientos día a día al inicio, luego preventas, luego catálogo
  games.sort((a, b) => {
    const aIsRel = a.d && a.d <= today;
    const bIsRel = b.d && b.d <= today;
    if (aIsRel && bIsRel) return b.d.localeCompare(a.d);
    if (aIsRel && !bIsRel) return -1;
    if (!aIsRel && bIsRel) return 1;

    const aIsPre = a.d && a.d > today;
    const bIsPre = b.d && b.d > today;
    if (aIsPre && bIsPre) return a.d.localeCompare(b.d);
    if (aIsPre && !bIsPre) return -1;
    if (!aIsPre && bIsPre) return 1;

    const aY = a.y || 0, bY = b.y || 0;
    if (aY !== bY) return bY - aY;
    return a.t.localeCompare(b.t);
  });

  await mkdir('public/data', { recursive: true });

  // --- Historial de precios (#2): acumula solo cuando hay ofertas o cambios significativos de precio ----------
  let history = {};
  try { history = JSON.parse(await readFile('public/data/history.json', 'utf8')); } catch {}
  for (const g of games) {
    if (!history[g.id]) history[g.id] = {};
    for (const [regionCode, cell] of Object.entries(g.r)) {
      const clp = cell[1];
      const disc = cell[2] || 0;
      if (!history[g.id][regionCode]) history[g.id][regionCode] = [];
      const entries = history[g.id][regionCode];
      const last = entries[entries.length - 1];
      if (!last) {
        entries.push([today, clp, disc]);
      } else {
        const discChanged = (last[2] || 0) !== disc;
        const priceChanged = Math.abs(clp - last[1]) / (last[1] || 1) >= 0.02;
        if (discChanged || priceChanged) {
          entries.push([today, clp, disc]);
          if (entries.length > 40) history[g.id][regionCode] = entries.slice(-40);
        } else {
          last[0] = today;
          last[1] = clp;
          last[2] = disc;
        }
      }
    }
  }
  await writeFile('public/data/history.json', JSON.stringify(history));
  console.log(`Historial: ${Object.keys(history).length} juegos con datos historicos.`);
  // ---------------------------------------------------------------------------

  const activeOffersCount = games.filter(g => Object.values(g.r).some(cell => cell[2] > 0)).length;
  const newReleasesCount = games.filter(g => g.d && g.d <= today && g.d >= new Date(new Date(today).getTime() - 30 * 864e5).toISOString().slice(0, 10)).length;

  await writeFile('public/data/games.json', JSON.stringify(games));

  let addons = [];
  try {
    addons = await crawlAddons(rates);
  } catch (err) {
    console.error('Error al recolectar DLCs y monedas:', err);
  }

  const dlcCount = addons.filter(x => x.kind === 'dlc').length;
  const currencyCount = addons.filter(x => x.kind === 'cur').length;

  await writeFile('public/data/meta.json', JSON.stringify({
    updated: new Date().toISOString(),
    fxDate, count: games.length,
    withRating: games.filter(g => g.mc != null).length,
    activeOffersCount,
    newReleasesCount,
    addonsCount: addons.length,
    dlcCount,
    currencyCount,
    regions: REGIONS,
  }));
  console.log(`== Listo: ${games.length} juegos y ${addons.length} DLCs/Monedas escritos (${games.filter(g=>g.mc!=null).length} con nota) ==`);
}
function firstMeta(byRegion, id) { for (const c of Object.keys(byRegion)) if (byRegion[c][id]) return byRegion[c][id]; return null; }

main().catch(e => { console.error('ERROR:', e); process.exit(1); });
