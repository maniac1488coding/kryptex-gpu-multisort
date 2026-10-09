/* Kryptex GPU multi-sort — клиентская логика */
'use strict';

const API = '/api/data';

/* ------------------------------------------------------------------ */
/* Состояние                                                           */
/* ------------------------------------------------------------------ */

const state = {
  rows: [],
  rates: { fiat: { USD: 1 }, crypto: {} },
  fetchedAt: null,
  upstreamLastModified: null,
  stale: false,

  /** режим сравнения: weighted | tolerance | strict */
  mode: 'weighted',
  tolerance: 10,

  /** критерии: key — поле, dir — направление, weight — вес в режиме компромисса */
  sorts: [
    { key: 'profit', dir: 'desc', weight: 3 },
    { key: 'payback', dir: 'asc', weight: 2 },
  ],

  filters: {
    q: '',
    brand: '',
    algo: '',
    ticker: '',
    maxPrice: Infinity,
    maxPower: Infinity,
    onlyProfitable: false,
  },
  kwh: 0.04,
  currency: 'USD',
  period: 1,
};

/* ------------------------------------------------------------------ */
/* Поля сортировки                                                     */
/* ------------------------------------------------------------------ */

/** better — какое направление считать «лучшим» при первичном выборе критерия */
const FIELDS = {
  name: { label: 'Модель', type: 'text', better: 'asc', get: (r) => r.row.name },
  vendor: { label: 'Бренд', type: 'text', better: 'asc', get: (r) => r.row.vendor || '' },
  hashrate: { label: 'Хэшрейт', type: 'num', better: 'desc', get: (r) => r.best?.hashrate ?? null },
  ticker: { label: 'Монета', type: 'text', better: 'asc', get: (r) => r.best?.ticker || '' },
  power: { label: 'Мощность, Вт', type: 'num', better: 'asc', get: (r) => r.best?.power ?? null },
  jPerHash: { label: 'J/H', type: 'num', better: 'asc', get: (r) => r.best?.jPerHash ?? null },
  dollarPerHash: { label: '$/H', type: 'num', better: 'asc', get: (r) => r.best?.dollarPerHash ?? null },
  efficiency: { label: 'Эффективность, $/кВт·ч', type: 'num', better: 'desc', get: (r) => r.m.efficiency },
  price: { label: 'Цена', type: 'num', better: 'asc', get: (r) => r.row.price },
  revenue: { label: 'Доход в сутки, $', type: 'num', better: 'desc', get: (r) => r.m.revenueDay },
  profit: { label: 'Прибыль в сутки, $', type: 'num', better: 'desc', get: (r) => r.m.profitDay },
  payback: { label: 'Окупаемость, дней', type: 'num', better: 'asc', get: (r) => r.m.paybackDays },
  index: { label: 'Индекс баланса', type: 'num', better: 'desc', get: (r) => r.index },
};

const PRESETS = {
  // Основной сценарий: самые доходные карты, но с учётом окупаемости
  revenue_payback: {
    mode: 'weighted',
    sorts: [
      { key: 'revenue', dir: 'desc', weight: 3 },
      { key: 'payback', dir: 'asc', weight: 2 },
    ],
  },
  // Тот же сценарий через допуск: лучшие по доходу, внутри допуска — по окупаемости
  revenue_tolerance: {
    mode: 'tolerance',
    tolerance: 10,
    sorts: [
      { key: 'revenue', dir: 'desc', weight: 5 },
      { key: 'payback', dir: 'asc', weight: 3 },
    ],
  },
  balance: {
    mode: 'weighted',
    sorts: [
      { key: 'profit', dir: 'desc', weight: 3 },
      { key: 'payback', dir: 'asc', weight: 3 },
      { key: 'efficiency', dir: 'desc', weight: 2 },
    ],
  },
  payback: {
    mode: 'weighted',
    sorts: [
      { key: 'payback', dir: 'asc', weight: 5 },
      { key: 'profit', dir: 'desc', weight: 3 },
    ],
  },
  profit: {
    mode: 'weighted',
    sorts: [
      { key: 'profit', dir: 'desc', weight: 5 },
      { key: 'payback', dir: 'asc', weight: 2 },
    ],
  },
  efficiency: {
    mode: 'weighted',
    sorts: [
      { key: 'efficiency', dir: 'desc', weight: 5 },
      { key: 'profit', dir: 'desc', weight: 2 },
    ],
  },
  cheap: {
    mode: 'weighted',
    sorts: [
      { key: 'price', dir: 'asc', weight: 3 },
      { key: 'payback', dir: 'asc', weight: 3 },
      { key: 'profit', dir: 'desc', weight: 2 },
    ],
  },
  strict: {
    mode: 'strict',
    sorts: [
      { key: 'profit', dir: 'desc', weight: 5 },
      { key: 'payback', dir: 'asc', weight: 5 },
    ],
  },
};

const MODE_HINTS = {
  weighted:
    'Каждый критерий получает вес. Наверх поднимаются карты, хорошие сразу по нескольким критериям: карта, которая 2-я по доходу и 3-я по окупаемости, обгонит карту, которая 1-я по доходу, но 100-я по окупаемости.',
  tolerance:
    'Берутся лучшие карты по критерию №1; всё, что укладывается в допуск к лучшему, считается равным и сортируется по следующим критериям. Пример «Доход + окупаемость»: самые доходные карты, отсортированные по сроку окупаемости.',
  strict:
    'Сначала сравнивается критерий №1, следующие участвуют только при полном равенстве. Так работает Kryptex: при разных значениях вторичный критерий не влияет ни на что.',
};

/* ------------------------------------------------------------------ */
/* Утилиты                                                             */
/* ------------------------------------------------------------------ */

const nf = (min = 0, max = 2) =>
  new Intl.NumberFormat('ru-RU', { minimumFractionDigits: min, maximumFractionDigits: max });

const HASH_UNITS = ['H/s', 'kH/s', 'MH/s', 'GH/s', 'TH/s', 'PH/s', 'EH/s'];

function fmtHashrate(v) {
  if (v == null || !Number.isFinite(v)) return '—';
  let x = v;
  let i = 0;
  while (x >= 1000 && i < HASH_UNITS.length - 1) {
    x /= 1000;
    i++;
  }
  const digits = x >= 100 ? 0 : x >= 10 ? 1 : 2;
  const s = x.toFixed(digits).replace(/\.?0+$/, '');
  return `${s} ${HASH_UNITS[i]}`;
}

function money(usd, opts = {}) {
  if (usd == null || !Number.isFinite(usd)) return '—';
  const rate = state.rates.fiat[state.currency] ?? 1;
  const value = usd * rate;
  const abs = Math.abs(value);
  const maxFrac = opts.max ?? (abs >= 1000 ? 0 : abs >= 1 ? 2 : 3);
  // min никогда не должен превышать max, иначе Intl бросает RangeError
  const minFrac = Math.min(opts.min ?? (abs >= 1000 ? 0 : 2), maxFrac);
  try {
    return new Intl.NumberFormat('ru-RU', {
      style: 'currency',
      currency: state.currency,
      minimumFractionDigits: minFrac,
      maximumFractionDigits: maxFrac,
      currencyDisplay: 'narrowSymbol',
    }).format(value);
  } catch {
    return `${nf(2, 2).format(value)} ${state.currency}`;
  }
}

function daysWord(n) {
  const a = Math.abs(n) % 100;
  const b = a % 10;
  if (a > 10 && a < 20) return 'дней';
  if (b === 1) return 'день';
  if (b >= 2 && b <= 4) return 'дня';
  return 'дней';
}

function fmtPayback(d) {
  if (d == null || !Number.isFinite(d)) return '—';
  const s = d < 1 ? nf(2, 2).format(d) : nf(0, 0).format(Math.round(d));
  return `${s} ${daysWord(d)}`;
}

function paybackClass(d) {
  if (d == null) return 'dim';
  if (d <= 120) return 'good';
  if (d <= 400) return 'warn';
  return 'bad';
}

function indexClass(i) {
  if (i == null) return 'dim';
  if (i >= 80) return 'good';
  if (i >= 55) return 'warn';
  return 'bad';
}

function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function toast(msg, ms = 2400) {
  const el = document.getElementById('toast');
  el.textContent = msg;
  el.hidden = false;
  clearTimeout(toast._t);
  toast._t = setTimeout(() => (el.hidden = true), ms);
}

const isNil = (v) => v == null || (typeof v === 'number' && !Number.isFinite(v));
const clampW = (w) => Math.min(10, Math.max(1, Number(w) || 1));

/* ------------------------------------------------------------------ */
/* Расчёт метрик (формулы Kryptex)                                     */
/* ------------------------------------------------------------------ */

function prepare(row) {
  const { algo, ticker } = state.filters;
  let pool = row.coins;
  if (algo) pool = pool.filter((c) => c.algo === algo);
  if (ticker) pool = pool.filter((c) => c.ticker === ticker);

  if (!pool.length) return null;
  const best = pool.reduce((a, b) => (b.revenueUsd > a.revenueUsd ? b : a));

  const power = best.power ?? 0;
  const kwhPerDay = (power * 24) / 1000;
  const elecDay = kwhPerDay * state.kwh;
  const revenueDay = best.revenueUsd ?? 0;
  const profitDay = revenueDay - elecDay;
  const efficiency = kwhPerDay > 0 ? profitDay / kwhPerDay : null;
  const paybackDays =
    row.price != null && row.price > 0 && profitDay > 0 ? row.price / profitDay : null;

  return {
    row,
    best,
    pool,
    m: { kwhPerDay, elecDay, revenueDay, profitDay, efficiency, paybackDays },
    norms: {},
    raw: 0,
    index: null,
    bucket: 0,
  };
}

function passesFilters(item) {
  const { q, brand, maxPrice, maxPower, onlyProfitable } = state.filters;
  const { row, best, m } = item;

  if (q && !row.name.toLowerCase().includes(q)) return false;
  if (brand && row.vendor !== brand) return false;
  if (maxPrice !== Infinity && (row.price == null || row.price > maxPrice)) return false;
  if (maxPower !== Infinity && (best.power ?? Infinity) > maxPower) return false;
  if (onlyProfitable && !(m.profitDay > 0)) return false;
  return true;
}

/* ------------------------------------------------------------------ */
/* Движок сравнения                                                    */
/* ------------------------------------------------------------------ */

const activeSorts = () => state.sorts.filter((s) => FIELDS[s.key]);

/** Компаратор строгого приоритета (лексикографический). */
function makeComparator(criteria) {
  return (a, b) => {
    for (const s of criteria) {
      const get = FIELDS[s.key].get;
      const va = get(a);
      const vb = get(b);
      const na = isNil(va);
      const nb = isNil(vb);
      if (na && nb) continue;
      if (na) return 1; // пустые значения — всегда вниз
      if (nb) return -1;

      let r;
      if (typeof va === 'number' && typeof vb === 'number') r = va - vb;
      else r = String(va).localeCompare(String(vb), 'ru');
      if (r !== 0) return s.dir === 'asc' ? r : -r;
    }
    return 0;
  };
}

/**
 * Взвешенный компромисс.
 * Каждая карта получает перцентильный ранг по каждому критерию (0 — лучшая,
 * 1 — худшая), затем считается взвешенное среднее. Благодаря этому вторичный
 * критерий реально влияет на место, а не только при полном равенстве.
 */
function computeIndex(items, criteria) {
  const n = items.length;
  for (const it of items) {
    it.norms = {};
    it.raw = 0;
    it.index = null;
  }
  if (!n || !criteria.length) return;

  let wsum = 0;
  for (const s of criteria) {
    const w = clampW(s.weight);
    wsum += w;
    const get = FIELDS[s.key].get;

    const order = items.map((it, i) => ({ i, v: get(it) }));
    order.sort((a, b) => {
      const na = isNil(a.v);
      const nb = isNil(b.v);
      if (na && nb) return 0;
      if (na) return 1;
      if (nb) return -1;
      const r =
        typeof a.v === 'number' && typeof b.v === 'number'
          ? a.v - b.v
          : String(a.v).localeCompare(String(b.v), 'ru');
      return s.dir === 'asc' ? r : -r;
    });

    // одинаковые значения получают один и тот же (средний) ранг
    let k = 0;
    while (k < order.length) {
      let j = k;
      while (j + 1 < order.length && sameValue(order[j].v, order[j + 1].v)) j++;
      const norm = n > 1 ? (k + j) / 2 / (n - 1) : 0;
      for (let t = k; t <= j; t++) {
        const it = items[order[t].i];
        it.norms[s.key] = norm;
        it.raw += w * norm;
      }
      k = j + 1;
    }
  }

  for (const it of items) {
    it.score = wsum > 0 ? it.raw / wsum : 0;
    it.index = Math.round(100 * (1 - it.score)); // 100 — лучшая, 0 — худшая
  }
}

function sameValue(a, b) {
  if (isNil(a) && isNil(b)) return true;
  if (isNil(a) || isNil(b)) return false;
  if (typeof a === 'number' && typeof b === 'number') return Math.abs(a - b) < 1e-9;
  return a === b;
}

/**
 * Допуск от лучшего: критерий №1 задаёт «корзины».
 * Всё, что в пределах допуска к лучшему значению, — одна корзина,
 * внутри корзины сортируют следующие критерии.
 */
function toleranceSort(items, criteria) {
  const [primary, ...rest] = criteria;
  if (FIELDS[primary.key].type === 'text') {
    items.sort(makeComparator(criteria));
    return;
  }
  const get = FIELDS[primary.key].get;
  const vals = items.map(get).filter((v) => !isNil(v));
  if (!vals.length) return;

  const best = primary.dir === 'asc' ? Math.min(...vals) : Math.max(...vals);
  const tol = Math.max(0.001, state.tolerance / 100);

  for (const it of items) {
    const v = get(it);
    if (isNil(v)) {
      it.bucket = Infinity;
      continue;
    }
    let ratio;
    if (primary.dir === 'asc') {
      ratio = v <= best ? 1 : best / Math.max(v, 1e-12); // меньше — лучше
      if (v < 0 && best >= 0) ratio = 0; // убыточные — в самый низ
    } else if (best === 0) {
      ratio = v === 0 ? 1 : 0;
    } else {
      ratio = v / best;
    }
    it.bucket = Math.max(0, Math.floor((1 - ratio) / tol + 1e-9));
  }

  const cmp = makeComparator([...rest, primary]);
  items.sort((a, b) => a.bucket - b.bucket || cmp(a, b));
}

function buildView() {
  const items = [];
  for (const row of state.rows) {
    const item = prepare(row);
    if (item && passesFilters(item)) items.push(item);
  }

  const criteria = activeSorts();
  computeIndex(items, criteria); // индекс считается всегда: он показывается в таблице и в детализации

  if (!criteria.length) return items;

  if (state.mode === 'weighted') {
    const strict = makeComparator(criteria);
    items.sort((a, b) => (b.index - a.index) || strict(a, b));
  } else if (state.mode === 'tolerance') {
    toleranceSort(items, criteria);
  } else {
    items.sort(makeComparator(criteria));
  }
  return items;
}

/* ------------------------------------------------------------------ */
/* Рендер: чипы критериев                                              */
/* ------------------------------------------------------------------ */

function renderChips() {
  const box = document.getElementById('sortChips');
  box.innerHTML = '';
  const weighted = state.mode === 'weighted';

  state.sorts.forEach((s, i) => {
    const chip = document.createElement('div');
    chip.className = 'chip';

    const opts = Object.entries(FIELDS)
      .filter(([k]) => k !== 'index')
      .map(([k, f]) => `<option value="${k}"${k === s.key ? ' selected' : ''}>${esc(f.label)}</option>`)
      .join('');

    chip.innerHTML = `
      <span class="prio" title="Приоритет критерия">${i + 1}</span>
      <select data-act="key" title="Критерий">${opts}</select>
      <button class="dir" data-act="dir" title="Направление: что считать лучшим">${s.dir === 'asc' ? '▲ меньше — лучше' : '▼ больше — лучше'}</button>
      ${
        weighted
          ? `<label class="weight" title="Вес критерия в общем индексе (1–10)">вес
               <input type="range" min="1" max="10" step="1" value="${clampW(s.weight)}" data-act="weight">
               <b>${clampW(s.weight)}</b>
             </label>`
          : ''
      }
      <button class="move" data-act="up" title="Выше приоритет" ${i === 0 ? 'disabled' : ''}>▲</button>
      <button class="move" data-act="down" title="Ниже приоритет" ${i === state.sorts.length - 1 ? 'disabled' : ''}>▼</button>
      <button class="del" data-act="del" title="Убрать критерий">✕</button>
    `;

    chip.addEventListener('change', (e) => {
      if (e.target.dataset.act === 'key') {
        s.key = e.target.value;
        render();
      }
    });

    // вес меняем без пересборки чипов, иначе ползунок теряет фокус при перетаскивании
    chip.addEventListener('input', (e) => {
      if (e.target.dataset.act === 'weight') {
        s.weight = clampW(e.target.value);
        const out = chip.querySelector('.weight b');
        if (out) out.textContent = s.weight;
        refreshTable();
      }
    });

    chip.addEventListener('click', (e) => {
      const act = e.target.dataset?.act;
      if (!act) return;
      if (act === 'dir') {
        s.dir = s.dir === 'asc' ? 'desc' : 'asc';
      } else if (act === 'del') {
        state.sorts.splice(i, 1);
      } else if (act === 'up' && i > 0) {
        [state.sorts[i - 1], state.sorts[i]] = [state.sorts[i], state.sorts[i - 1]];
      } else if (act === 'down' && i < state.sorts.length - 1) {
        [state.sorts[i + 1], state.sorts[i]] = [state.sorts[i], state.sorts[i + 1]];
      } else return;
      render();
    });

    box.appendChild(chip);
  });
}

/* ------------------------------------------------------------------ */
/* Рендер: таблица                                                     */
/* ------------------------------------------------------------------ */

function renderHead() {
  const active = activeSorts();
  document.querySelectorAll('thead th[data-sort]').forEach((th) => {
    const key = th.dataset.sort;
    const idx = active.findIndex((s) => s.key === key);
    th.classList.toggle('sorted', idx !== -1);
    th.querySelector('.arrow')?.remove();
    th.querySelector('.badge')?.remove();
    if (idx !== -1 && key !== 'index') {
      th.insertAdjacentHTML(
        'beforeend',
        `<span class="badge">${idx + 1}</span><span class="arrow">${active[idx].dir === 'asc' ? '▲' : '▼'}</span>`,
      );
    }
  });
}

function indexTooltip(it, total) {
  const parts = activeSorts().map((s) => {
    const norm = it.norms[s.key];
    const place = norm == null ? '—' : Math.round(norm * (total - 1)) + 1;
    return `${FIELDS[s.key].label}: место ${place} из ${total} (вес ${clampW(s.weight)})`;
  });
  return `Индекс баланса: ${it.index ?? '—'} из 100\n${parts.join('\n')}`;
}

function renderTable(items) {
  const tbody = document.getElementById('tbody');
  const weighted = state.mode === 'weighted';
  document.getElementById('table').classList.toggle('hide-index', !weighted);

  if (!items.length) {
    tbody.innerHTML = `<tr><td colspan="13" class="empty">Ничего не найдено — ослабьте фильтры.</td></tr>`;
    return;
  }

  const period = state.period;
  const total = items.length;
  const frag = document.createDocumentFragment();

  items.forEach((it, i) => {
    const { row, best, m } = it;
    const tr = document.createElement('tr');
    const power = best.power ?? null;
    const revP = m.revenueDay * period;
    const profP = m.profitDay * period;

    tr.innerHTML = `
      <td class="rank num">${i + 1}</td>
      <td class="left">
        <div class="gpu">
          ${row.vendorImage ? `<img src="${esc(row.vendorImage)}" alt="" loading="lazy">` : ''}
          <div>
            <div class="nm">${esc(row.name)}</div>
            <div class="vn">${esc(row.vendor)}${row.price != null ? ` · ${money(row.price, { max: 0 })}` : ''}</div>
          </div>
        </div>
      </td>
      <td class="num">${fmtHashrate(best.hashrate)}</td>
      <td><span class="pill${i < 3 ? ' best' : ''}">${esc(best.ticker)}</span></td>
      <td class="num">${power != null ? `${nf(0, 0).format(power)} Вт` : '—'}</td>
      <td class="num dim">${best.jPerHash != null ? `${nf(0, 2).format(best.jPerHash)} ${esc(best.jPerHashUnit)}` : '—'}</td>
      <td class="num dim">${best.dollarPerHash != null ? `${nf(0, 2).format(best.dollarPerHash)} ${esc(best.dollarPerHashUnit)}` : '—'}</td>
      <td class="num ${m.efficiency > 0 ? 'good' : 'bad'}">${m.efficiency != null ? nf(0, 2).format(m.efficiency) : '—'}</td>
      <td class="num">${money(row.price, { max: 0 })}</td>
      <td class="num strong">${money(revP)}</td>
      <td class="num strong ${m.profitDay > 0 ? 'good' : 'bad'}">${money(profP)}</td>
      <td class="num ${paybackClass(m.paybackDays)}">${fmtPayback(m.paybackDays)}</td>
      <td class="num col-index">
        <div class="idxcell" title="${esc(indexTooltip(it, total))}">
          <span class="${indexClass(it.index)}">${it.index ?? '—'}</span>
          <span class="bar"><i style="width:${it.index ?? 0}%"></i></span>
        </div>
      </td>
    `;

    tr.addEventListener('click', () => openDetail(it, total));
    frag.appendChild(tr);
  });

  tbody.innerHTML = '';
  tbody.appendChild(frag);
}

/* ------------------------------------------------------------------ */
/* Детализация по видеокарте                                           */
/* ------------------------------------------------------------------ */

function openDetail(item, total) {
  const { row, best } = item;
  const panel = document.getElementById('detail');
  const body = document.getElementById('detailBody');
  const period = state.period;

  const coins = row.coins
    .map((c) => {
      const kwhPerDay = ((c.power ?? 0) * 24) / 1000;
      const profitDay = (c.revenueUsd ?? 0) - kwhPerDay * state.kwh;
      const payback = row.price != null && profitDay > 0 ? row.price / profitDay : null;
      const eff = kwhPerDay > 0 ? profitDay / kwhPerDay : null;
      return { c, profitDay, payback, eff, kwhPerDay };
    })
    .sort((a, b) => b.profitDay - a.profitDay);

  const periodLabel = period === 1 ? 'в сутки' : period === 30 ? 'в месяц' : 'в год';

  const breakdown = activeSorts()
    .map((s) => {
      const norm = item.norms[s.key];
      const place = norm == null ? '—' : Math.round(norm * (total - 1)) + 1;
      const pct = norm == null ? '—' : `${Math.round(norm * 100)}%`;
      return `<tr>
        <td class="left">${esc(FIELDS[s.key].label)}</td>
        <td class="num">${s.dir === 'asc' ? '▲ меньше' : '▼ больше'}</td>
        <td class="num">${place} из ${total}</td>
        <td class="num dim">${pct} хуже всех</td>
        <td class="num">${clampW(s.weight)}</td>
      </tr>`;
    })
    .join('');

  body.innerHTML = `
    <h3>${esc(row.name)}</h3>
    <p class="sub2">${esc(row.vendor)}${row.price != null ? ` · цена ${money(row.price, { max: 0 })}` : ''} · монет доступно: ${row.coins.length}</p>

    <div class="metrics">
      <div class="metric"><div class="k">Индекс баланса</div><div class="v ${indexClass(item.index)}">${item.index ?? '—'} / 100</div></div>
      <div class="metric"><div class="k">Доход ${periodLabel}</div><div class="v">${money(item.m.revenueDay * period)}</div></div>
      <div class="metric"><div class="k">Прибыль ${periodLabel}</div><div class="v ${item.m.profitDay > 0 ? 'good' : 'bad'}">${money(item.m.profitDay * period)}</div></div>
      <div class="metric"><div class="k">Окупаемость</div><div class="v ${paybackClass(item.m.paybackDays)}">${fmtPayback(item.m.paybackDays)}</div></div>
      <div class="metric"><div class="k">Эфф-ть, $/кВт·ч</div><div class="v">${item.m.efficiency != null ? nf(0, 2).format(item.m.efficiency) : '—'}</div></div>
      <div class="metric"><div class="k">Потребление</div><div class="v">${nf(0, 2).format(item.m.kwhPerDay)} кВт·ч/сут</div></div>
    </div>

    ${
      breakdown
        ? `<h4 class="dtitle">Из чего сложился индекс</h4>
           <div class="table-scroll"><table>
             <thead><tr><th class="left">Критерий</th><th>Лучше</th><th>Место</th><th>Отставание</th><th>Вес</th></tr></thead>
             <tbody>${breakdown}</tbody>
           </table></div>`
        : ''
    }

    <p class="sub2">Лучшая монета: <b>${esc(best.coin)} (${esc(best.ticker)})</b>, алгоритм ${esc(best.algo)}, ${fmtHashrate(best.hashrate)}, ${best.power ?? '—'} Вт при ${nf(0, 2).format(state.kwh)} $/кВт·ч</p>

    <h4 class="dtitle">Все монеты этой карты</h4>
    <div class="table-scroll">
    <table>
      <thead>
        <tr>
          <th class="left">Монета</th><th>Алго</th><th>Хэшрейт</th><th>Вт</th>
          <th>Доход/сут</th><th>Прибыль/сут</th><th>Эфф-ть</th><th>Окуп.</th>
        </tr>
      </thead>
      <tbody>
        ${coins
          .map(
            ({ c, profitDay, payback, eff }) => `
          <tr>
            <td class="left"><span class="pill${c.ticker === best.ticker ? ' best' : ''}">${esc(c.ticker)}</span></td>
            <td class="dim">${esc(c.algo)}</td>
            <td class="num">${fmtHashrate(c.hashrate)}</td>
            <td class="num">${c.power ?? '—'}</td>
            <td class="num">${money(c.revenueUsd)}</td>
            <td class="num ${profitDay > 0 ? 'good' : 'bad'}">${money(profitDay)}</td>
            <td class="num">${eff != null ? nf(0, 2).format(eff) : '—'}</td>
            <td class="num ${paybackClass(payback)}">${fmtPayback(payback)}</td>
          </tr>`,
          )
          .join('')}
      </tbody>
    </table>
    </div>
  `;

  panel.hidden = false;
}

/* ------------------------------------------------------------------ */
/* Общий рендер                                                        */
/* ------------------------------------------------------------------ */

const MODE_LABELS = {
  weighted: 'взвешенный компромисс',
  tolerance: 'допуск от лучшего',
  strict: 'строгий приоритет',
};

function updateStatusLine(count) {
  const updated = state.upstreamLastModified
    ? new Date(state.upstreamLastModified).toLocaleString('ru-RU')
    : state.fetchedAt
      ? new Date(state.fetchedAt).toLocaleString('ru-RU')
      : '—';
  const modeLabel =
    state.mode === 'tolerance'
      ? `допуск ${nf(0, 1).format(state.tolerance)}% от лучшего`
      : MODE_LABELS[state.mode];
  document.getElementById('resultCount').textContent =
    `Показано ${count} из ${state.rows.length} GPU · данные Kryptex от ${updated} · режим: ${modeLabel}`;
}

/** Пересчёт и перерисовка только таблицы (без пересборки чипов). */
function refreshTable() {
  const items = buildView();
  renderTable(items);
  updateStatusLine(items.length);
  saveState();
}

function render() {
  const items = buildView();
  renderChips();
  renderHead();
  renderTable(items);
  renderMode();
  updateStatusLine(items.length);
  saveState();
}

function renderMode() {
  document.getElementById('mode').value = state.mode;
  document.getElementById('tolerance').value = state.tolerance;
  document.getElementById('tolWrap').hidden = state.mode !== 'tolerance';
  document.getElementById('modeHint').textContent = MODE_HINTS[state.mode];
}

/* ------------------------------------------------------------------ */
/* Состояние в URL / localStorage                                      */
/* ------------------------------------------------------------------ */

function saveState() {
  const snap = {
    mode: state.mode,
    tolerance: state.tolerance,
    sorts: state.sorts,
    filters: {
      ...state.filters,
      maxPrice: state.filters.maxPrice === Infinity ? null : state.filters.maxPrice,
      maxPower: state.filters.maxPower === Infinity ? null : state.filters.maxPower,
    },
    kwh: state.kwh,
    currency: state.currency,
    period: state.period,
  };
  try {
    localStorage.setItem('kryptex-multisort', JSON.stringify(snap));
  } catch {}
  try {
    const p = new URLSearchParams();
    p.set('s', JSON.stringify(state.sorts));
    if (state.mode !== 'weighted') p.set('mode', state.mode);
    if (state.mode === 'tolerance' && state.tolerance !== 5) p.set('tol', String(state.tolerance));
    if (state.kwh !== 0.04) p.set('kwh', String(state.kwh));
    if (state.currency !== 'USD') p.set('cur', state.currency);
    if (state.period !== 1) p.set('p', String(state.period));
    if (state.filters.brand) p.set('brand', state.filters.brand);
    if (state.filters.algo) p.set('algo', state.filters.algo);
    if (state.filters.ticker) p.set('ticker', state.filters.ticker);
    if (state.filters.q) p.set('q', state.filters.q);
    history.replaceState(null, '', `#${p.toString()}`);
  } catch {}
}

function loadState() {
  let snap = null;
  try {
    const hash = new URLSearchParams(location.hash.slice(1));
    if (hash.get('s')) {
      snap = {
        sorts: JSON.parse(hash.get('s')),
        mode: hash.get('mode') ?? 'weighted',
        tolerance: Number(hash.get('tol') ?? 5),
        kwh: Number(hash.get('kwh') ?? 0.04),
        currency: hash.get('cur') ?? 'USD',
        period: Number(hash.get('p') ?? 1),
        filters: {
          q: hash.get('q') ?? '',
          brand: hash.get('brand') ?? '',
          algo: hash.get('algo') ?? '',
          ticker: hash.get('ticker') ?? '',
          maxPrice: null,
          maxPower: null,
          onlyProfitable: false,
        },
      };
    }
  } catch {}
  if (!snap) {
    try {
      snap = JSON.parse(localStorage.getItem('kryptex-multisort') || 'null');
    } catch {}
  }
  if (!snap) return;

  if (Array.isArray(snap.sorts) && snap.sorts.length) {
    state.sorts = snap.sorts
      .filter((s) => FIELDS[s.key] && s.key !== 'index')
      .map((s) => ({ key: s.key, dir: s.dir === 'asc' ? 'asc' : 'desc', weight: clampW(s.weight ?? 2) }));
  }
  if (['weighted', 'tolerance', 'strict'].includes(snap.mode)) state.mode = snap.mode;
  if (Number.isFinite(snap.tolerance) && snap.tolerance > 0) state.tolerance = snap.tolerance;
  if (snap.filters) {
    state.filters.q = snap.filters.q ?? '';
    state.filters.brand = snap.filters.brand ?? '';
    state.filters.algo = snap.filters.algo ?? '';
    state.filters.ticker = snap.filters.ticker ?? '';
    state.filters.onlyProfitable = !!snap.filters.onlyProfitable;
    state.filters.maxPrice = snap.filters.maxPrice == null ? Infinity : Number(snap.filters.maxPrice);
    state.filters.maxPower = snap.filters.maxPower == null ? Infinity : Number(snap.filters.maxPower);
  }
  if (Number.isFinite(snap.kwh)) state.kwh = snap.kwh;
  if (snap.currency) state.currency = snap.currency;
  if ([1, 30, 365].includes(Number(snap.period))) state.period = Number(snap.period);
}

/* ------------------------------------------------------------------ */
/* Данные                                                              */
/* ------------------------------------------------------------------ */

async function loadData(force = false) {
  const dot = document.getElementById('statusDot');
  const txt = document.getElementById('statusText');
  dot.className = 'dot load';
  txt.textContent = 'загрузка данных Kryptex…';

  try {
    const res = await fetch(`${API}${force ? '?refresh=1' : ''}`, { cache: 'no-store' });
    const data = await res.json();
    if (!data.ok) throw new Error(data.error || 'ошибка API');

    state.rows = data.rows;
    state.rates = data.rates;
    state.fetchedAt = data.fetchedAt;
    state.upstreamLastModified = data.upstreamLastModified;
    state.stale = !!data.stale;

    dot.className = data.stale ? 'dot err' : 'dot ok';
    txt.textContent = `${data.count} GPU · обновлено ${new Date(data.fetchedAt).toLocaleTimeString('ru-RU')}${data.stale ? ' (устаревшие данные)' : ''}`;

    fillSelectors();
    render();
  } catch (err) {
    dot.className = 'dot err';
    txt.textContent = `ошибка: ${err.message}`;
    console.error(err);
  }
}

function fillSelectors() {
  const opts = (values, current, allLabel = 'Все') => {
    const list = [`<option value="">${allLabel}</option>`];
    for (const v of values) {
      list.push(`<option value="${esc(v)}"${v === current ? ' selected' : ''}>${esc(v)}</option>`);
    }
    return list.join('');
  };

  const brands = [...new Set(state.rows.map((r) => r.vendor).filter(Boolean))].sort();
  const algos = [...new Set(state.rows.flatMap((r) => r.coins.map((c) => c.algo)).filter(Boolean))].sort();
  const tickers = [...new Set(state.rows.flatMap((r) => r.coins.map((c) => c.ticker)).filter(Boolean))].sort();

  document.getElementById('brand').innerHTML = opts(brands, state.filters.brand);
  document.getElementById('algo').innerHTML = opts(algos, state.filters.algo);
  document.getElementById('ticker').innerHTML = opts(tickers, state.filters.ticker);

  const currencies = Object.keys(state.rates.fiat || { USD: 1 }).sort();
  document.getElementById('currency').innerHTML = currencies
    .map((c) => `<option value="${c}"${c === state.currency ? ' selected' : ''}>${c}</option>`)
    .join('');

  const prices = state.rows.map((r) => r.price).filter((v) => Number.isFinite(v));
  const powers = state.rows.flatMap((r) => r.coins.map((c) => c.power)).filter((v) => Number.isFinite(v));
  const maxPrice = Math.ceil(Math.max(...prices, 100) / 100) * 100;
  const maxPower = Math.ceil(Math.max(...powers, 100) / 50) * 50;

  const priceEl = document.getElementById('maxPrice');
  const powerEl = document.getElementById('maxPower');
  priceEl.max = maxPrice;
  powerEl.max = maxPower;
  priceEl.value = state.filters.maxPrice === Infinity ? maxPrice : state.filters.maxPrice;
  powerEl.value = state.filters.maxPower === Infinity ? maxPower : state.filters.maxPower;
  updateRangeLabels();
}

function updateRangeLabels() {
  const p = Number(document.getElementById('maxPrice').value);
  const w = Number(document.getElementById('maxPower').value);
  document.getElementById('maxPriceOut').textContent =
    p >= Number(document.getElementById('maxPrice').max) ? '∞' : money(p, { max: 0 });
  document.getElementById('maxPowerOut').textContent =
    w >= Number(document.getElementById('maxPower').max) ? '∞' : nf(0, 0).format(w);
}

/* ------------------------------------------------------------------ */
/* Экспорт                                                             */
/* ------------------------------------------------------------------ */

function exportCsv() {
  const items = buildView();
  const period = state.period;
  const head = [
    'Место', 'Модель', 'Бренд', 'Монета', 'Алгоритм', 'Хэшрейт', 'Мощность, Вт',
    'J/H', '$/H', 'Эфф-ть $/кВт·ч', 'Цена USD', 'Доход за период USD', 'Прибыль за период USD',
    'Окупаемость, дней', 'Индекс баланса',
  ];
  const rows = items.map((it, i) => {
    const { row, best, m } = it;
    return [
      i + 1,
      row.name,
      row.vendor,
      best.ticker,
      best.algo,
      fmtHashrate(best.hashrate),
      best.power ?? '',
      best.jPerHash ?? '',
      best.dollarPerHash ?? '',
      m.efficiency != null ? m.efficiency.toFixed(3) : '',
      row.price ?? '',
      (m.revenueDay * period).toFixed(4),
      (m.profitDay * period).toFixed(4),
      m.paybackDays != null ? Math.round(m.paybackDays) : '',
      it.index ?? '',
    ];
  });

  const csv = [head, ...rows]
    .map((r) => r.map((v) => `"${String(v).replace(/"/g, '""')}"`).join(';'))
    .join('\r\n');

  const blob = new Blob(['\ufeff' + csv], { type: 'text/csv;charset=utf-8' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `kryptex-gpu-${new Date().toISOString().slice(0, 10)}.csv`;
  a.click();
  URL.revokeObjectURL(a.href);
  toast(`Экспортировано строк: ${items.length}`);
}

/* ------------------------------------------------------------------ */
/* Инициализация                                                       */
/* ------------------------------------------------------------------ */

function addSort(key = 'efficiency', weight = 2) {
  if (key === 'index' || !FIELDS[key]) return;
  if (state.sorts.length >= 8) return toast('Максимум 8 критериев');
  const existing = state.sorts.find((s) => s.key === key);
  if (existing) {
    existing.dir = existing.dir === 'asc' ? 'desc' : 'asc';
  } else {
    state.sorts.push({ key, dir: FIELDS[key].better, weight });
  }
  render();
}

/** Клик по заголовку колонки. */
function onHeaderClick(key, shift) {
  if (key === 'index') {
    state.mode = 'weighted';
    render();
    toast('Индекс баланса — это и есть результат взвешенного режима; таблица уже отсортирована по нему');
    return;
  }
  if (!FIELDS[key]) return;
  if (shift) return addSort(key, 2);

  const cur = state.sorts[0];
  if (cur && cur.key === key) {
    if (state.sorts.length === 1) cur.dir = cur.dir === 'asc' ? 'desc' : 'asc';
    else state.sorts = [{ ...cur }];
  } else {
    state.sorts = [
      { key, dir: FIELDS[key].better, weight: 3 },
      ...state.sorts.filter((s) => s.key !== key),
    ];
  }
  render();
}

function bindUi() {
  document.getElementById('q').addEventListener('input', (e) => {
    state.filters.q = e.target.value.trim().toLowerCase();
    refreshTable();
  });
  for (const [id, field] of [['brand', 'brand'], ['algo', 'algo'], ['ticker', 'ticker']]) {
    document.getElementById(id).addEventListener('change', (e) => {
      state.filters[field] = e.target.value;
      refreshTable();
    });
  }
  document.getElementById('kwh').addEventListener('input', (e) => {
    const v = Number(e.target.value);
    state.kwh = Number.isFinite(v) && v >= 0 ? v : 0;
    refreshTable();
  });
  document.getElementById('currency').addEventListener('change', (e) => {
    state.currency = e.target.value;
    refreshTable();
  });
  document.getElementById('period').addEventListener('change', (e) => {
    state.period = Number(e.target.value);
    refreshTable();
  });
  document.getElementById('maxPrice').addEventListener('input', (e) => {
    const v = Number(e.target.value);
    state.filters.maxPrice = v >= Number(e.target.max) ? Infinity : v;
    updateRangeLabels();
    refreshTable();
  });
  document.getElementById('maxPower').addEventListener('input', (e) => {
    const v = Number(e.target.value);
    state.filters.maxPower = v >= Number(e.target.max) ? Infinity : v;
    updateRangeLabels();
    refreshTable();
  });
  document.getElementById('onlyProfitable').addEventListener('change', (e) => {
    state.filters.onlyProfitable = e.target.checked;
    refreshTable();
  });

  document.getElementById('mode').addEventListener('change', (e) => {
    state.mode = e.target.value;
    render();
  });
  document.getElementById('tolerance').addEventListener('input', (e) => {
    const v = Number(e.target.value);
    state.tolerance = Number.isFinite(v) && v > 0 ? Math.min(50, v) : 5;
    refreshTable();
  });

  document.getElementById('addSort').addEventListener('click', () => addSort('efficiency', 2));
  document.getElementById('clearSort').addEventListener('click', () => {
    state.sorts = [];
    render();
  });

  document.querySelectorAll('[data-preset]').forEach((btn) => {
    btn.addEventListener('click', () => {
      const p = PRESETS[btn.dataset.preset];
      state.sorts = p.sorts.map((s) => ({ ...s }));
      state.mode = p.mode || 'weighted';
      if (p.tolerance) state.tolerance = p.tolerance;
      render();
      toast(`Пресет: ${btn.textContent}`);
    });
  });

  document.querySelectorAll('thead th[data-sort]').forEach((th) => {
    th.addEventListener('click', (e) => onHeaderClick(th.dataset.sort, e.shiftKey));
  });

  document.getElementById('refreshBtn').addEventListener('click', () => loadData(true));
  document.getElementById('exportBtn').addEventListener('click', exportCsv);
  document.getElementById('linkBtn').addEventListener('click', async () => {
    saveState();
    try {
      await navigator.clipboard.writeText(location.href);
      toast('Ссылка на текущую выборку скопирована');
    } catch {
      toast(location.href, 6000);
    }
  });
  document.getElementById('detailClose').addEventListener('click', () => {
    document.getElementById('detail').hidden = true;
  });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') document.getElementById('detail').hidden = true;
  });
}

function main() {
  loadState();
  bindUi();

  document.getElementById('q').value = state.filters.q;
  document.getElementById('kwh').value = state.kwh;
  document.getElementById('period').value = String(state.period);

  loadData();
  setInterval(() => loadData(false), 5 * 60 * 1000);
}

main();
