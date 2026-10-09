#!/usr/bin/env node
/**
 * Kryptex GPU Multi-Sort — backend
 *
 * Тянет данные с pool.kryptex.com/ru/device/gpu (Nuxt payload, формат devalue),
 * распаковывает и отдаёт нормализованный JSON на /api/data.
 *
 * Без внешних зависимостей.
 */
import http from 'node:http';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = path.join(__dirname, 'public');

const PORT = Number(process.env.PORT || 8099);
const HOST = process.env.HOST || '127.0.0.1';
const LOCALE = process.env.LOCALE || 'ru';
const UPSTREAM =
  process.env.UPSTREAM || `https://pool.kryptex.com/${LOCALE}/device/gpu/_payload.json`;
const PAGE_URL = `https://pool.kryptex.com/${LOCALE}/device/gpu`;
const TTL_MS = Number(process.env.TTL_MS || 5 * 60 * 1000);
const DEBUG = process.env.DEBUG === '1';

/* ------------------------------------------------------------------ */
/* devalue: разворачивание плоского Nuxt-payload в обычные объекты     */
/* ------------------------------------------------------------------ */

const UNDEFINED = -1;
const HOLE = -2;
const NAN = -3;
const POS_INF = -4;
const NEG_INF = -5;
const NEG_ZERO = -6;

function unflatten(parsed) {
  if (typeof parsed === 'number') return hydrate(parsed);
  const values = parsed;
  const hydrated = new Array(values.length);

  function hydrate(index) {
    if (index === UNDEFINED) return undefined;
    if (index === NAN) return NaN;
    if (index === POS_INF) return Infinity;
    if (index === NEG_INF) return -Infinity;
    if (index === NEG_ZERO) return -0;
    if (index < 0 || index >= values.length) return undefined;
    if (hydrated[index] !== undefined) return hydrated[index];

    const value = values[index];
    if (value === null || typeof value !== 'object') {
      hydrated[index] = value;
      return value;
    }

    if (Array.isArray(value)) {
      if (typeof value[0] === 'string') {
        const type = value[0];
        switch (type) {
          case 'Date':
            return (hydrated[index] = new Date(value[1]));
          case 'BigInt':
            return (hydrated[index] = BigInt(value[1]));
          case 'RegExp':
            return (hydrated[index] = new RegExp(value[1], value[2]));
          case 'Set': {
            const set = new Set();
            hydrated[index] = set;
            for (let i = 1; i < value.length; i++) set.add(hydrate(value[i]));
            return set;
          }
          case 'Map': {
            const map = new Map();
            hydrated[index] = map;
            for (let i = 1; i < value.length; i += 2) map.set(hydrate(value[i]), hydrate(value[i + 1]));
            return map;
          }
          case 'Object': {
            const obj = {};
            hydrated[index] = obj;
            for (let i = 1; i < value.length; i += 2) obj[value[i]] = hydrate(value[i + 1]);
            return obj;
          }
          case 'null':
            return (hydrated[index] = null);
          case 'undefined':
            return (hydrated[index] = undefined);
          // Vue / Nuxt-обёртки: разворачиваем до полезной нагрузки
          case 'ShallowReactive':
          case 'Reactive':
          case 'Ref':
          case 'ShallowRef':
          case 'NuxtError':
            return (hydrated[index] = hydrate(value[1]));
          default: {
            const obj = {};
            hydrated[index] = obj;
            for (let i = 1; i < value.length; i += 2) obj[value[i]] = hydrate(value[i + 1]);
            return obj;
          }
        }
      }
      const arr = [];
      hydrated[index] = arr;
      for (let i = 0; i < value.length; i++) {
        const n = value[i];
        arr.push(n === HOLE ? undefined : hydrate(n));
      }
      return arr;
    }

    const obj = {};
    hydrated[index] = obj;
    for (const key of Object.keys(value)) obj[key] = hydrate(value[key]);
    return obj;
  }

  // Nuxt payload: [ { data: <idx>, prerenderedAt }, <root value> ]
  if (Array.isArray(parsed) && parsed[0] && typeof parsed[0] === 'object' && !Array.isArray(parsed[0])) {
    const meta = parsed[0];
    if (typeof meta.data === 'number') return hydrate(meta.data);
  }
  return hydrate(1);
}

/* ------------------------------------------------------------------ */
/* Нормализация                                                        */
/* ------------------------------------------------------------------ */

/** Ищем в payload массив видеокарт и таблицы курсов, не завязываясь на хеш-ключи. */
function normalize(root) {
  if (!root || typeof root !== 'object') throw new Error('payload: неожиданный корень');

  let gpus = null;
  let rates = { fiat: { USD: 1 }, crypto: {} };

  const visit = (node, depth = 0) => {
    if (!node || typeof node !== 'object' || depth > 4) return;
    if (Array.isArray(node)) {
      if (
        !gpus &&
        node.length > 3 &&
        node[0] &&
        typeof node[0] === 'object' &&
        Array.isArray(node[0].supported_coins)
      ) {
        gpus = node;
      }
      for (const item of node) {
        if (item && typeof item === 'object' && !Array.isArray(item) && item.fiat && item.crypto) {
          rates = item;
        }
      }
      return;
    }
    if (node.fiat && node.crypto) rates = node;
    for (const key of Object.keys(node)) visit(node[key], depth + 1);
  };
  visit(root);

  if (!gpus) throw new Error('payload: массив видеокарт не найден');

  const rows = gpus
    .filter((g) => g && g.name && Array.isArray(g.supported_coins))
    .map((g) => {
      const coins = g.supported_coins
        .filter((c) => c && typeof c.revenue_usd === 'number')
        .map((c) => ({
          coin: c.coin ?? '',
          ticker: c.ticker ?? '',
          algo: c.algo ?? '',
          hashrate: num(c.hashrate),
          power: num(c.power),
          revenueCoin: num(c.revenue),
          revenueUsd: num(c.revenue_usd),
          jPerHash: c.j_per_h && typeof c.j_per_h.value === 'number' ? c.j_per_h.value : null,
          jPerHashUnit: c.j_per_h ? c.j_per_h.unit ?? '' : '',
          dollarPerHash:
            c.dollar_per_h && typeof c.dollar_per_h.value === 'number' ? c.dollar_per_h.value : null,
          dollarPerHashUnit: c.dollar_per_h ? c.dollar_per_h.unit ?? '' : '',
          image: c.image ?? '',
        }))
        .sort((a, b) => b.revenueUsd - a.revenueUsd);

      const best = coins[0] ?? null;
      return {
        name: g.name,
        slug: g.slug ?? '',
        vendor: (g.vendor && g.vendor.name) || '',
        vendorImage: (g.vendor && g.vendor.image) || '',
        price: num(g.price),
        best,
        coins,
      };
    });

  return {
    rows,
    rates: {
      fiat: rates.fiat ?? { USD: 1 },
      crypto: rates.crypto ?? {},
    },
  };
}

function num(v) {
  return typeof v === 'number' && Number.isFinite(v) ? v : null;
}

/* ------------------------------------------------------------------ */
/* Забор данных с апстримом + кэш                                      */
/* ------------------------------------------------------------------ */

const cache = {
  payload: null, // { rows, rates, upstreamLastModified, fetchedAt }
  inflight: null,
  lastError: null,
};

const UA =
  'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0 Safari/537.36';

async function fetchText(url) {
  const res = await fetch(url, {
    headers: {
      'User-Agent': UA,
      Accept: 'application/json, text/html;q=0.9,*/*;q=0.8',
      'Accept-Language': 'ru,en;q=0.8',
      'Cache-Control': 'no-cache',
    },
    redirect: 'follow',
  });
  if (!res.ok) throw new Error(`upstream ${url} -> HTTP ${res.status}`);
  return { text: await res.text(), headers: res.headers };
}

/** Достаём данные: сначала _payload.json, при неудаче — SSR-страница. */
async function fetchUpstream() {
  let lastErr;
  try {
    const { text, headers } = await fetchText(UPSTREAM);
    const parsed = JSON.parse(text);
    return { root: unflatten(parsed), lastModified: headers.get('last-modified') };
  } catch (err) {
    lastErr = err;
    if (DEBUG) console.warn('[kryptex] payload.json недоступен:', err.message);
  }
  try {
    const { text, headers } = await fetchText(PAGE_URL);
    const m = text.match(
      /<script[^>]+id="__NUXT_DATA__"[^>]*>([\s\S]*?)<\/script>/,
    );
    if (!m) throw new Error('__NUXT_DATA__ не найден в HTML');
    const parsed = JSON.parse(m[1]);
    return { root: unflatten(parsed), lastModified: headers.get('last-modified') };
  } catch (err) {
    throw new Error(`${lastErr?.message ?? 'payload fail'}; fallback: ${err.message}`);
  }
}

async function getData({ force = false } = {}) {
  const fresh = cache.payload && Date.now() - cache.payload.fetchedAt < TTL_MS;
  if (fresh && !force) return cache.payload;
  if (cache.inflight) return cache.inflight;

  cache.inflight = (async () => {
    try {
      const { root, lastModified } = await fetchUpstream();
      const { rows, rates } = normalize(root);
      cache.payload = {
        rows,
        rates,
        upstreamLastModified: lastModified,
        fetchedAt: Date.now(),
        sourceUrl: UPSTREAM,
      };
      cache.lastError = null;
      return cache.payload;
    } catch (err) {
      cache.lastError = err.message;
      if (cache.payload) return cache.payload; // отдаём устаревшее, но живое
      throw err;
    } finally {
      cache.inflight = null;
    }
  })();

  return cache.inflight;
}

/* ------------------------------------------------------------------ */
/* HTTP-сервер                                                         */
/* ------------------------------------------------------------------ */

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.png': 'image/png',
  '.woff2': 'font/woff2',
};

function sendJson(res, status, body) {
  const data = JSON.stringify(body);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(data),
    'Cache-Control': 'no-store',
  });
  res.end(data);
}

async function serveStatic(res, urlPath) {
  const rel = urlPath === '/' ? 'index.html' : decodeURIComponent(urlPath).replace(/^\/+/, '');
  const target = path.resolve(PUBLIC_DIR, rel);
  if (!target.startsWith(PUBLIC_DIR + path.sep) && target !== PUBLIC_DIR) {
    return sendJson(res, 403, { error: 'forbidden' });
  }
  try {
    const stat = await fsp.stat(target);
    if (stat.isDirectory()) throw new Error('is dir');
    const ext = path.extname(target).toLowerCase();
    res.writeHead(200, {
      'Content-Type': MIME[ext] || 'application/octet-stream',
      'Content-Length': stat.size,
      'Cache-Control': ext === '.html' ? 'no-cache' : 'public, max-age=60',
    });
    fs.createReadStream(target).pipe(res);
  } catch {
    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('404 Not Found');
  }
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  const p = url.pathname;

  try {
    if (p === '/api/data') {
      const force = url.searchParams.get('refresh') === '1';
      const data = await getData({ force });
      return sendJson(res, 200, {
        ok: true,
        fetchedAt: data.fetchedAt,
        upstreamLastModified: data.upstreamLastModified,
        sourceUrl: data.sourceUrl,
        count: data.rows.length,
        stale: cache.lastError ? true : false,
        error: cache.lastError,
        rates: data.rates,
        rows: data.rows,
      });
    }

    if (p === '/api/health') {
      return sendJson(res, 200, {
        ok: true,
        cached: !!cache.payload,
        fetchedAt: cache.payload?.fetchedAt ?? null,
        count: cache.payload?.rows?.length ?? 0,
        lastError: cache.lastError,
        ttlMs: TTL_MS,
      });
    }

    if (req.method !== 'GET' && req.method !== 'HEAD') {
      return sendJson(res, 405, { error: 'method not allowed' });
    }

    return await serveStatic(res, p);
  } catch (err) {
    console.error('[kryptex]', err);
    return sendJson(res, 502, { ok: false, error: String(err.message || err) });
  }
});

server.listen(PORT, HOST, async () => {
  console.log(`Kryptex GPU multi-sort: http://${HOST}:${PORT}`);
  try {
    const d = await getData();
    console.log(
      `Данные загружены: ${d.rows.length} GPU, апстрим обновлён ${d.upstreamLastModified ?? 'н/д'}`,
    );
  } catch (err) {
    console.error('Первичная загрузка не удалась:', err.message);
  }
});

for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, () => {
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 2000).unref();
  });
}
