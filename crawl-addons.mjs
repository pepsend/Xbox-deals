// ============================================================================
//  Xbox Deals — Crawler de DLCs y Monedas de juego
//  Descubre DLCs, expansiones, pases de temporada y monedas del juego (V-Bucks,
//  Minecoins, Shark Cards, FC Points, etc.), obtiene sus precios multi-región y
//  los guarda en public/data/addons.json con mapeo al juego base.
// ============================================================================
import { writeFile, readFile } from 'node:fs/promises';

const REGIONS = [
  { code:'CL', cur:'CLP' },
  { code:'AR', cur:'ARS' },
  { code:'TR', cur:'TRY' },
  { code:'BR', cur:'BRL' },
  { code:'US', cur:'USD' },
  { code:'MX', cur:'MXN' },
  { code:'JP', cur:'JPY' },
  { code:'UA', cur:'UAH' },
  { code:'PL', cur:'PLN' },
  { code:'CO', cur:'COP' },
  { code:'IN', cur:'INR' },
  { code:'NG', cur:'NGN' },
  { code:'EG', cur:'EGP' },
  { code:'ZA', cur:'ZAR' },
];

const sleep = ms => new Promise(r => setTimeout(r, ms));

async function fetchJSON(url, tries = 4) {
  for (let i = 0; i < tries; i++) {
    try {
      const res = await fetch(url);
      if (res.ok) return await res.json();
      if (res.status === 429 || res.status >= 500) { await sleep(1000 * (i + 1)); continue; }
      return null;
    } catch (e) {
      if (i === tries - 1) return null;
      await sleep(1000 * (i + 1));
    }
  }
  return null;
}

async function postJSON(url, body, tries = 4) {
  for (let i = 0; i < tries; i++) {
    try {
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-ms-api-version': '1.1', 'ms-cv': 'xbxdeals.1' },
        body: JSON.stringify(body)
      });
      if (res.ok) return await res.json();
      if (res.status === 429 || res.status >= 500) { await sleep(1000 * (i + 1)); continue; }
      return null;
    } catch (e) {
      if (i === tries - 1) return null;
      await sleep(1000 * (i + 1));
    }
  }
  return null;
}

function pickImg(s) {
  const imgs = s.images || {};
  const cand = imgs.boxArt || imgs.featurePromotionalSquareArt || imgs.poster || imgs.superHeroArt || (Array.isArray(imgs) ? imgs[0] : null);
  let u = cand && (cand.url || cand.uri || cand);
  if (!u || typeof u !== 'string') return null;
  if (u.startsWith('//')) u = 'https:' + u;
  return u.split('?')[0];
}

const cleanTitle = s => (s || '').toLowerCase()
  .replace(/[™®]/g, '')
  .replace(/[:\-–—]/g, ' ')
  .replace(/\b(para (xbox|pc|windows).*|edición\b.*|edition\b.*|deluxe|standard|complete|goty|digital|ultimate|bundle|remastered|definitive|anniversary|gold|premium|x\|s|series x\|s|xbox one|windows)\b/gi, ' ')
  .replace(/[^a-z0-9 ]/g, ' ')
  .replace(/\s+/g, ' ').trim();

export async function crawlAddons(rates) {
  console.log('== Iniciando descubrimiento de DLCs y Monedas ==');

  const terms = [
    // Monedas y consumibles
    'coins', 'points', 'credits', 'tokens', 'v-bucks', 'minecoins', 'shark', 'robux',
    'gold', 'silver', 'platinum', 'gems', 'monedas', 'puntos', 'creditos', 'fc points',
    'cod points', 'fifa points', 'apex coins', 'overwatch coins', 'halo credits', 'warframe platinum',
    'atoms', 'crowns', 'cristales', 'orbes',
    // DLCs, expansiones y pases
    'dlc', 'expansion', 'season pass', 'expansion pass', 'upgrade', 'pack', 'bundle',
    'pass', 'chapter', 'episode', 'story', 'fighter', 'character', 'car pass', 'addon',
    // Franquicias populares con mucho contenido adicional
    'ea sports fc', 'fifa', 'fortnite', 'call of duty', 'gta', 'grand theft auto',
    'minecraft', 'roblox', 'diablo', 'destiny', 'halo', 'forza', 'dead by daylight',
    'apex', 'overwatch', 'rainbow six', 'cyberpunk', 'witcher', 'elden ring', 'dark souls',
    'fallout', 'skyrim', 'the elder scrolls', 'sims', 'dragon ball', 'resident evil',
    'assassin', 'mortal kombat', 'street fighter', 'tekken', 'sea of thieves', 'warframe',
    'rust', 'borderlands', 'persona', 'monster hunter', 'starfield', 'naruto', 'one piece',
    // Letras para alta cobertura de catálogo adicional
    'a', 'e', 'i', 'o', 'u', 's', 'r', 't', 'n', 'l', 'c', 'm', 'p', 'b', 'd'
  ];

  const rawItems = new Map();
  const searchStart = Date.now();

  for (let i = 0; i < terms.length; i += 6) {
    const chunk = terms.slice(i, i + 6);
    await Promise.all(chunk.map(async term => {
      const url = 'https://emerald.xboxservices.com/xboxcomfd/search/Addons?locale=es-CL';
      let ct = Buffer.from(JSON.stringify({ HasMore: true, SkipCount: 0, TotalCount: 0, PreviousPageProductIds: [] })).toString('base64');
      const maxPages = (term.length === 1) ? 1 : 2;
      for (let p = 0; p < maxPages; p++) {
        const body = {
          Query: term,
          Filters: Buffer.from('{}').toString('base64'),
          ReturnFilters: false,
          ChannelKeyToBeUsedInResponse: 'SEARCH',
          EncodedCT: ct,
          ChannelId: ''
        };
        const data = await postJSON(url, body);
        if (!data) break;
        const ps = Object.values(data.productSummaries || {});
        for (const prod of ps) {
          if (!prod.productId) continue;
          if (prod.productKind !== 'Durable' && prod.productKind !== 'Consumable') continue;
          if (!rawItems.has(prod.productId)) {
            const kind = prod.productKind === 'Consumable' ? 'cur' : 'dlc';
            rawItems.set(prod.productId, {
              id: prod.productId,
              t: prod.title || prod.productId,
              kind,
              img: pickImg(prod),
              d: prod.releaseDate ? prod.releaseDate.slice(0, 10) : null
            });
          }
        }
        ct = data?.channels?.SEARCH?.encodedCT;
        if (!ct) break;
        await sleep(50);
      }
    }));
  }

  const searchSec = ((Date.now() - searchStart) / 1000).toFixed(1);
  console.log(`Descubrimiento completado: ${rawItems.size} ítems en ${searchSec}s`);

  // Indexar juegos base para vincular addons a sus respectivos juegos
  let games = [];
  try { games = JSON.parse(await readFile('public/data/games.json', 'utf8')); } catch {}
  const indexedGames = games
    .map(g => ({ id: g.id, t: g.t, clean: cleanTitle(g.t) }))
    .filter(g => g.clean.length >= 4)
    .sort((a, b) => b.clean.length - a.clean.length);

  for (const item of rawItems.values()) {
    const cleanItem = ' ' + cleanTitle(item.t) + ' ';
    const match = indexedGames.find(g => cleanItem.includes(' ' + g.clean + ' '));
    if (match) {
      item.baseId = match.id;
      item.baseTitle = match.t;
    }
  }

  // Precios multi-región con displaycatalog
  const allIds = [...rawItems.keys()];
  const BATCH_SIZE = 50;
  const priceStart = Date.now();
  const regionalPrices = {}; // id -> { regionCode: [list, clp, disc, ends?] }
  const today = new Date().toISOString().slice(0, 10);
  const toCLP = (amt, cur) => (cur === 'CLP') ? amt : (rates[cur] ? amt / rates[cur] : null);

  for (let i = 0; i < allIds.length; i += BATCH_SIZE) {
    const chunkIds = allIds.slice(i, i + BATCH_SIZE);
    await Promise.all(REGIONS.map(async r => {
      const url = `https://displaycatalog.mp.microsoft.com/v7.0/products?bigIds=${chunkIds.join(',')}&market=${r.code}&languages=es-${r.code}&MS-CV=1`;
      const data = await fetchJSON(url);
      if (!data || !Array.isArray(data.Products)) return;
      for (const p of data.Products) {
        const id = p.ProductId;
        const av = p.DisplaySkuAvailabilities?.[0]?.Availabilities?.[0];
        const pr = av?.OrderManagementData?.Price;
        if (!pr || !(pr.ListPrice > 0)) continue;
        const cur = pr.CurrencyCode || r.cur;
        const clp = toCLP(pr.ListPrice, cur);
        if (clp == null) continue;
        const msrp = pr.MSRP || pr.ListPrice;
        const ends = (av?.Conditions?.EndDate && !av.Conditions.EndDate.startsWith('9998'))
          ? av.Conditions.EndDate.slice(0, 10)
          : null;
        const isExpired = ends && ends < today;
        let disc = Math.round((1 - pr.ListPrice / msrp) * 100);
        if (disc < 0 || isExpired) disc = 0;

        if (!regionalPrices[id]) regionalPrices[id] = {};
        const cell = [Math.round(pr.ListPrice * 100) / 100, Math.round(clp), disc];
        if (ends && !isExpired) cell.push(ends);
        regionalPrices[id][r.code] = cell;
      }
    }));
    await sleep(40);
  }

  const priceSec = ((Date.now() - priceStart) / 1000).toFixed(1);
  console.log(`Precios multi-región obtenidos en ${priceSec}s`);

  // Construir lista final
  const addons = [];
  for (const [id, item] of rawItems.entries()) {
    const r = regionalPrices[id];
    if (!r || Object.keys(r).length === 0) continue;
    addons.push({
      id: item.id,
      t: item.t,
      kind: item.kind,
      img: item.img,
      d: item.d,
      baseId: item.baseId || null,
      baseTitle: item.baseTitle || null,
      r
    });
  }

  // Ordenar: primero los que tienen oferta activa, luego por fecha de lanzamiento, luego título
  addons.sort((a, b) => {
    const aHasOffer = Object.values(a.r).some(cell => cell[2] > 0);
    const bHasOffer = Object.values(b.r).some(cell => cell[2] > 0);
    if (aHasOffer && !bHasOffer) return -1;
    if (!aHasOffer && bHasOffer) return 1;
    if (a.d && b.d) return b.d.localeCompare(a.d);
    return a.t.localeCompare(b.t);
  });

  await writeFile('public/data/addons.json', JSON.stringify(addons));
  console.log(`Guardado public/data/addons.json con ${addons.length} items (${addons.filter(x => x.kind === 'dlc').length} DLCs, ${addons.filter(x => x.kind === 'cur').length} Monedas)`);

  try {
    const meta = JSON.parse(await readFile('public/data/meta.json', 'utf8'));
    meta.addonsCount = addons.length;
    meta.dlcCount = addons.filter(x => x.kind === 'dlc').length;
    meta.currencyCount = addons.filter(x => x.kind === 'cur').length;
    await writeFile('public/data/meta.json', JSON.stringify(meta, null, 2));
    console.log('meta.json actualizado con conteos de DLCs y Monedas');
  } catch (err) {
    console.warn('No se pudo actualizar meta.json:', err.message);
  }

  return addons;
}

// Ejecución directa si se invoca como script principal
if (process.argv[1]?.endsWith('crawl-addons.mjs')) {
  (async () => {
    const fx = await (await fetch('https://open.er-api.com/v6/latest/CLP')).json();
    await crawlAddons(fx.rates);
  })().catch(e => {
    console.error('Error en crawl-addons:', e);
    process.exit(1);
  });
}
