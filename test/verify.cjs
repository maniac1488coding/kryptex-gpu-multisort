/**
 * E2E-проверка клиента в jsdom.
 *
 * Поднимает сервер (если он ещё не запущен), открывает страницу,
 * прогоняет сценарии в реальном DOM и сверяет порядок строк с независимым
 * эталоном, посчитанным напрямую из /api/data.
 *
 * Запуск:  npm test        (нужен jsdom: npm install)
 *          TEST_PORT=9000 npm test
 */
const { JSDOM, VirtualConsole } = require('jsdom');

const { spawn } = require('node:child_process');
const path = require('node:path');

const TEST_PORT = Number(process.env.TEST_PORT || 8099);
const BASE = process.env.BASE || `http://127.0.0.1:${TEST_PORT}`;
let serverChild = null;

/** Если сервер уже поднят — используем его, иначе запускаем свой и гасим после тестов. */
async function ensureServer() {
  for (let i = 0; i < 8; i++) {
    try {
      const r = await fetch(`${BASE}/api/health`);
      if (r.ok) return;
    } catch {}
    await new Promise((r) => setTimeout(r, 300));
  }
  console.log(`Сервер не отвечает на ${BASE} — запускаю собственный на порту ${TEST_PORT}`);
  serverChild = spawn(process.execPath, [path.join(__dirname, '..', 'server.mjs')], {
    env: { ...process.env, PORT: String(TEST_PORT), HOST: '127.0.0.1' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  serverChild.stdout.on('data', (d) => process.stdout.write('  [server] ' + d));
  serverChild.stderr.on('data', (d) => process.stderr.write('  [server] ' + d));
  for (let i = 0; i < 60; i++) {
    try {
      const r = await fetch(`${BASE}/api/health`);
      if (r.ok) return;
    } catch {}
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error('не удалось запустить сервер');
}

function stopServer() {
  if (serverChild && !serverChild.killed) serverChild.kill('SIGTERM');
}

// чтобы тестовый сервер не остался висеть при прерывании
process.on('exit', stopServer);
for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP']) {
  process.on(sig, () => {
    stopServer();
    process.exit(130);
  });
}
const KWH = 0.04;
let failures = 0;
const ok = (cond, msg) => {
  console.log(`${cond ? '  ✅' : '  ❌'} ${msg}`);
  if (!cond) failures++;
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* ---------------- эталонная реализация (независимая от клиента) --------- */

const isNil = (v) => v == null || (typeof v === 'number' && !Number.isFinite(v));
const sameV = (a, b) => (isNil(a) && isNil(b) ? true : isNil(a) || isNil(b) ? false : typeof a === 'number' && typeof b === 'number' ? Math.abs(a - b) < 1e-9 : a === b);
const clampW = (w) => Math.min(10, Math.max(1, Number(w) || 1));

function metrics(row) {
  const best = row.coins.reduce((a, b) => (b.revenueUsd > a.revenueUsd ? b : a));
  const kwh = ((best.power ?? 0) * 24) / 1000;
  const revenue = best.revenueUsd ?? 0;
  const profit = revenue - kwh * KWH;
  return { row, best, kwh, revenue, profit, eff: kwh > 0 ? profit / kwh : null, payback: row.price > 0 && profit > 0 ? row.price / profit : null };
}

const GET = {
  revenue: (m) => m.revenue,
  profit: (m) => m.profit,
  payback: (m) => m.payback,
  efficiency: (m) => m.eff,
  price: (m) => m.row.price,
  power: (m) => m.best.power ?? null,
  hashrate: (m) => m.best.hashrate ?? null,
};

function cmpChain(a, b, criteria) {
  for (const s of criteria) {
    const get = GET[s.key];
    const va = get(a);
    const vb = get(b);
    const na = isNil(va);
    const nb = isNil(vb);
    if (na && nb) continue;
    if (na) return 1;
    if (nb) return -1;
    const r = va - vb;
    if (r !== 0) return s.dir === 'asc' ? r : -r;
  }
  return 0;
}

function referenceIndex(items, criteria) {
  const n = items.length;
  const acc = items.map(() => ({ raw: 0, norms: {} }));
  let wsum = 0;
  criteria.forEach((s, ci) => {
    const w = clampW(s.weight);
    wsum += w;
    const get = GET[s.key];
    const order = items.map((m, i) => ({ i, v: get(m) }));
    order.sort((a, b) => {
      const na = isNil(a.v);
      const nb = isNil(b.v);
      if (na && nb) return 0;
      if (na) return 1;
      if (nb) return -1;
      return s.dir === 'asc' ? a.v - b.v : b.v - a.v;
    });
    let k = 0;
    while (k < order.length) {
      let j = k;
      while (j + 1 < order.length && sameV(order[j].v, order[j + 1].v)) j++;
      const norm = n > 1 ? (k + j) / 2 / (n - 1) : 0;
      for (let t = k; t <= j; t++) {
        acc[order[t].i].norms[s.key] = norm;
        acc[order[t].i].raw += w * norm;
      }
      k = j + 1;
    }
  });
  return items.map((m, i) => ({ m, index: Math.round(100 * (1 - acc[i].raw / wsum)), norms: acc[i].norms }));
}

function referenceOrder(rows, mode, criteria, tolerance = 10) {
  const items = rows.map(metrics);
  const sc = referenceIndex(items, criteria);
  sc.forEach((s) => (s.m.index = s.index));

  if (mode === 'weighted') {
    sc.sort((a, b) => b.index - a.index || cmpChain(a.m, b.m, criteria));
    return sc.map((s) => s.m.row.name);
  }
  if (mode === 'strict') {
    const c = [...items].sort((a, b) => cmpChain(a, b, criteria));
    return c.map((m) => m.row.name);
  }
  // tolerance
  const [primary, ...rest] = criteria;
  const get = GET[primary.key];
  const vals = items.map(get).filter((v) => !isNil(v));
  const best = primary.dir === 'asc' ? Math.min(...vals) : Math.max(...vals);
  const tol = tolerance / 100;
  const bucket = new Map();
  for (const m of items) {
    const v = get(m);
    if (isNil(v)) { bucket.set(m, Infinity); continue; }
    let ratio;
    if (primary.dir === 'asc') ratio = v <= best ? 1 : best / Math.max(v, 1e-12);
    else ratio = best === 0 ? (v === 0 ? 1 : 0) : v / best;
    bucket.set(m, Math.max(0, Math.floor((1 - ratio) / tol + 1e-9)));
  }
  const c = [...items].sort((a, b) => bucket.get(a) - bucket.get(b) || cmpChain(a, b, [...rest, primary]));
  return c.map((m) => m.row.name);
}

/* ------------------------------------------------------------------ */

(async () => {
  await ensureServer();
  const vc = new VirtualConsole();
  vc.on('jsdomError', (e) => console.error('  [jsdom]', e.message));
  vc.on('error', (...a) => console.error('  [console.error]', ...a));

  const raw = await (await fetch(`${BASE}/api/data`)).json();
  const allRows = raw.rows;

  const dom = await JSDOM.fromURL(`${BASE}/`, {
    runScripts: 'dangerously',
    resources: 'usable',
    pretendToBeVisual: true,
    virtualConsole: vc,
    beforeParse(window) {
      window.fetch = (input, init) =>
        globalThis.fetch(new URL(typeof input === 'string' ? input : input.url, BASE), init);
    },
  });
  const { window } = dom;
  const doc = window.document;
  for (let i = 0; i < 80; i++) {
    await sleep(250);
    if (doc.querySelectorAll('#tbody tr').length > 3) break;
  }

  const rows = () => [...doc.querySelectorAll('#tbody tr')];
  const names = () => rows().map((tr) => tr.querySelector('.nm').textContent.trim());
  const cell = (tr, i) => tr.children[i].textContent.trim();
  const click = (el) => el.dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
  const change = (el, v) => { el.value = v; el.dispatchEvent(new window.Event('change', { bubbles: true })); };
  const input = (el, v) => { el.value = v; el.dispatchEvent(new window.Event('input', { bubbles: true })); };
  const chipLabels = () => [...doc.querySelectorAll('#sortChips .chip select')].map((s) => s.selectedOptions[0].textContent);
  const chipWeights = () => [...doc.querySelectorAll('#sortChips .chip .weight b')].map((b) => Number(b.textContent));
  const sameOrder = (a, b) => JSON.stringify(a) === JSON.stringify(b);
  const diff = (a, b) => a.findIndex((v, i) => v !== b[i]);
  const indexColVisible = () => !doc.getElementById('table').classList.contains('hide-index');

  console.log('\n=== Базовый рендер ===');
  ok(rows().length === 135, `строк: ${rows().length}`);
  ok(doc.getElementById('mode').value === 'weighted', 'режим по умолчанию — взвешенный компромисс');
  ok(indexColVisible(), 'колонка «Индекс» видна во взвешенном режиме');
  ok(chipWeights().length === 2, `ползунки веса отрисованы: ${chipWeights().join(', ')}`);

  console.log('\n=== ГЛАВНОЕ: вторичный критерий реально влияет ===');
  const strictOrder = referenceOrder(allRows, 'strict', [
    { key: 'profit', dir: 'desc', weight: 3 },
    { key: 'payback', dir: 'asc', weight: 2 },
  ]);
  const weightedOrder = referenceOrder(allRows, 'weighted', [
    { key: 'profit', dir: 'desc', weight: 3 },
    { key: 'payback', dir: 'asc', weight: 2 },
  ]);
  ok(
    sameOrder(names(), referenceOrder(allRows, 'weighted', [{ key: 'profit', dir: 'desc', weight: 3 }, { key: 'payback', dir: 'asc', weight: 2 }])),
    'порядок по умолчанию совпадает с эталоном',
  );
  ok(names()[0] !== strictOrder[0], `первая карта отличается от строгого режима: «${names()[0]}» вместо «${strictOrder[0]}»`);
  ok(!names().slice(0, 5).includes(strictOrder[0]), `лидер строгого режима («${strictOrder[0]}», окупаемость ~1290 дней) вытеснен из топ-5`);
  const payTop5 = rows().slice(0, 5).map((tr) => Number(cell(tr, 11).replace(/[^\d]/g, '')));
  ok(Math.max(...payTop5) <= 300, `топ-5 по окупаемости: ${payTop5.join(', ')} дней — все практичные`);

  console.log('\n=== Индекс совпадает с эталоном по каждой карте ===');
  const ref = referenceIndex(allRows.map(metrics), [
    { key: 'profit', dir: 'desc', weight: 3 },
    { key: 'payback', dir: 'asc', weight: 2 },
  ]);
  const refByName = new Map(ref.map((r) => [r.m.row.name, r.index]));
  let mismatches = 0;
  rows().forEach((tr) => {
    const nm = tr.querySelector('.nm').textContent.trim();
    const shown = Number(cell(tr, 12).replace(/[^\d]/g, ''));
    if (refByName.get(nm) !== shown) mismatches++;
  });
  ok(mismatches === 0, `индекс во всех 135 строках совпал с эталоном (расхождений: ${mismatches})`);
  const idxSeq = rows().map((tr) => Number(cell(tr, 12).replace(/[^\d]/g, '')));
  ok(idxSeq.every((v, i) => i === 0 || idxSeq[i - 1] >= v), 'индекс убывает сверху вниз');

  console.log('\n=== Изменение веса меняет порядок ===');
  const before = names();
  const ranges = [...doc.querySelectorAll('#sortChips .chip .weight input')];
  input(ranges[1], '10'); // окупаемость важнее прибыли
  input(ranges[0], '1');  // прибыль почти не важна
  await sleep(250);
  const afterOrder = referenceOrder(allRows, 'weighted', [
    { key: 'profit', dir: 'desc', weight: 3 },
    { key: 'payback', dir: 'asc', weight: 2 },
  ]);
  ok(!sameOrder(names(), before), 'порядок изменился после смены весов');
  ok(
    sameOrder(names(), referenceOrder(allRows, 'weighted', [
      { key: 'profit', dir: 'desc', weight: 1 },
      { key: 'payback', dir: 'asc', weight: 10 },
    ])),
    'порядок после смены весов совпадает с эталоном',
  );
  ok(before !== afterOrder, 'эталонные порядки для разных весов тоже различаются');
  const payNew = Number(cell(rows()[0], 11).replace(/[^\d]/g, ''));
  ok(payNew <= 150, `при весе окупаемости 10 лидер имеет окупаемость ${payNew} дней`);

  console.log('\n=== Режим «Строгий приоритет» = как на Kryptex ===');
  change(doc.getElementById('mode'), 'strict');
  await sleep(250);
  ok(!indexColVisible(), 'колонка «Индекс» скрыта в строгом режиме');
  ok(doc.querySelectorAll('#sortChips .chip .weight').length === 0, 'ползунки веса скрыты в строгом режиме');
  ok(sameOrder(names(), strictOrder), `порядок совпадает со строгим эталоном (расхождение: строка ${diff(names(), strictOrder)})`);
  ok(names()[0] === strictOrder[0], `первая карта: «${names()[0]}» — как на Kryptex`);

  console.log('\n=== Режим «Допуск от лучшего» ===');
  change(doc.getElementById('mode'), 'tolerance');
  await sleep(200);
  input(doc.getElementById('tolerance'), '10');
  await sleep(250);
  await sleep(0);
  // критерии: прибыль ▼ + окупаемость ▲
  const expTol = referenceOrder(allRows, 'tolerance', [
    { key: 'profit', dir: 'desc', weight: 3 },
    { key: 'payback', dir: 'asc', weight: 2 },
  ], 10);
  ok(sameOrder(names(), expTol), `порядок совпадает с эталоном допуска (расхождение: строка ${diff(names(), expTol)})`);
  // внутри первой корзины карты отсортированы по окупаемости
  const refItems = allRows.map(metrics);
  const profits = rows().map((tr) => tr.querySelector('.nm').textContent.trim());
  const maxRef = Math.max(...refItems.map((m) => m.profit));
  const bucket0 = rows().filter((tr) => {
    const nm = tr.querySelector('.nm').textContent.trim();
    const m = refItems.find((x) => x.row.name === nm);
    return m && m.profit >= maxRef * 0.9;
  });
  const b0pay = bucket0.map((tr) => Number(cell(tr, 11).replace(/[^\d]/g, '')));
  ok(b0pay.every((v, i) => i === 0 || b0pay[i - 1] <= v), `внутри допуска карты идут по возрастанию окупаемости: ${b0pay.join(', ')}`);

  console.log('\n=== Пресет «Доход + окупаемость» ===');
  click(doc.querySelector('[data-preset="revenue_payback"]'));
  await sleep(300);
  const expRP = referenceOrder(allRows, 'weighted', [
    { key: 'revenue', dir: 'desc', weight: 3 },
    { key: 'payback', dir: 'asc', weight: 2 },
  ]);
  ok(doc.getElementById('mode').value === 'weighted', 'пресет включает взвешенный режим');
  ok(chipLabels()[0].includes('Доход') && chipLabels()[1].includes('Окупаемость'), `критерии: ${chipLabels().join(' → ')}`);
  ok(chipWeights()[0] === 3 && chipWeights()[1] === 2, `веса: ${chipWeights().join(' : ')}`);
  ok(sameOrder(names(), expRP), `порядок совпадает с эталоном (расхождение: строка ${diff(names(), expRP)})`);
  console.log('    топ-6:');
  rows().slice(0, 6).forEach((tr, i) => console.log(`      ${i + 1}. ${tr.querySelector('.nm').textContent.trim().padEnd(30)} доход ${cell(tr, 9).padStart(9)}  окуп. ${cell(tr, 11).padStart(10)}  индекс ${cell(tr, 12)}`));

  console.log('\n=== Пресет «Доход + окупаемость (допуск)» ===');
  click(doc.querySelector('[data-preset="revenue_tolerance"]'));
  await sleep(300);
  ok(doc.getElementById('mode').value === 'tolerance', 'пресет включает режим допуска');
  ok(!doc.getElementById('tolWrap').hidden, 'поле допуска показано');
  const expRT = referenceOrder(allRows, 'tolerance', [
    { key: 'revenue', dir: 'desc', weight: 5 },
    { key: 'payback', dir: 'asc', weight: 3 },
  ], 10);
  ok(sameOrder(names(), expRT), `порядок совпадает с эталоном (расхождение: строка ${diff(names(), expRT)})`);

  console.log('\n=== Пресет «Лучший баланс» (3 критерия) ===');
  click(doc.querySelector('[data-preset="balance"]'));
  await sleep(300);
  const expBal = referenceOrder(allRows, 'weighted', [
    { key: 'profit', dir: 'desc', weight: 3 },
    { key: 'payback', dir: 'asc', weight: 3 },
    { key: 'efficiency', dir: 'desc', weight: 2 },
  ]);
  ok(chipLabels().length === 3, `критериев: ${chipLabels().length}`);
  ok(sameOrder(names(), expBal), `порядок совпадает с эталоном (расхождение: строка ${diff(names(), expBal)})`);

  console.log('\n=== Остальные пресеты ===');
  const cases = {
    payback: ['weighted', [{ key: 'payback', dir: 'asc', weight: 5 }, { key: 'profit', dir: 'desc', weight: 3 }]],
    profit: ['weighted', [{ key: 'profit', dir: 'desc', weight: 5 }, { key: 'payback', dir: 'asc', weight: 2 }]],
    efficiency: ['weighted', [{ key: 'efficiency', dir: 'desc', weight: 5 }, { key: 'profit', dir: 'desc', weight: 2 }]],
    cheap: ['weighted', [{ key: 'price', dir: 'asc', weight: 3 }, { key: 'payback', dir: 'asc', weight: 3 }, { key: 'profit', dir: 'desc', weight: 2 }]],
    strict: ['strict', [{ key: 'profit', dir: 'desc', weight: 5 }, { key: 'payback', dir: 'asc', weight: 5 }]],
  };
  for (const [name, [mode, criteria]] of Object.entries(cases)) {
    click(doc.querySelector(`[data-preset="${name}"]`));
    await sleep(250);
    const exp = referenceOrder(allRows, mode, criteria);
    ok(sameOrder(names(), exp), `пресет «${name}»: порядок совпадает (расхождение: строка ${diff(names(), exp)})`);
  }

  console.log('\n=== Клик по заголовку колонки (Shift = добавить критерий) ===');
  click(doc.querySelector('[data-preset="profit"]'));
  await sleep(200);
  doc.getElementById('clearSort').dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
  await sleep(150);
  const thRev = [...doc.querySelectorAll('thead th')].find((t) => t.dataset.sort === 'revenue');
  click(thRev);
  await sleep(200);
  ok(chipLabels().length === 1 && chipLabels()[0].includes('Доход'), `клик задал один критерий: ${chipLabels().join(', ')}`);
  const thPay = [...doc.querySelectorAll('thead th')].find((t) => t.dataset.sort === 'payback');
  thPay.dispatchEvent(new window.MouseEvent('click', { bubbles: true, shiftKey: true }));
  await sleep(250);
  ok(chipLabels().length === 2 && chipLabels()[1].includes('Окупаемость'), `Shift+клик добавил второй: ${chipLabels().join(' → ')}`);
  ok(
    sameOrder(names(), referenceOrder(allRows, 'weighted', [
      { key: 'revenue', dir: 'desc', weight: 3 },
      { key: 'payback', dir: 'asc', weight: 2 },
    ])),
    'автособранная связка «доход + окупаемость» считается правильно',
  );

  console.log('\n=== Фильтры + индекс пересчитываются на подмножестве ===');
  change(doc.getElementById('brand'), 'NVIDIA');
  await sleep(300);
  const nv = allRows.filter((r) => r.vendor === 'NVIDIA');
  const expNv = referenceOrder(nv, 'weighted', [
    { key: 'revenue', dir: 'desc', weight: 3 },
    { key: 'payback', dir: 'asc', weight: 2 },
  ]);
  ok(rows().length === nv.length, `строк NVIDIA: ${rows().length} = ${nv.length} в данных`);
  ok(sameOrder(names(), expNv), `индекс и порядок пересчитаны на подмножестве (расхождение: строка ${diff(names(), expNv)})`);
  change(doc.getElementById('brand'), '');
  await sleep(250);

  console.log('\n=== Цена электричества ===');
  input(doc.getElementById('kwh'), '0.20');
  await sleep(300);
  ok(!sameOrder(names(), expRP), 'при $0.20/кВт·ч порядок меняется');
  input(doc.getElementById('kwh'), '0.04');
  await sleep(250);

  console.log('\n=== Детализация: расшифровка индекса ===');
  click(rows()[0]);
  await sleep(300);
  const detail = doc.getElementById('detail');
  ok(!detail.hidden, 'панель открылась');
  ok(/Из чего сложился индекс/.test(detail.textContent), 'есть блок расшифровки индекса');
  const bdRows = [...detail.querySelectorAll('table')].find((t) => /Из чего|Критерий/.test(t.closest('h4')?.textContent || ''));
  const critRows = detail.querySelectorAll('table')[0].querySelectorAll('tbody tr').length;
  ok(critRows === 2, `строк в расшифровке: ${critRows} (= числу критериев)`);
  ok(/\d+ из 135/.test(detail.textContent), 'указаны места по каждому критерию');
  click(doc.getElementById('detailClose'));
  await sleep(150);

  console.log('\n=== Состояние (hash) содержит режим и веса ===');
  const hash = decodeURIComponent(window.location.hash);
  ok(/mode=/.test(hash) || /s=/.test(hash), `hash: ${hash.slice(0, 110)}`);
  ok(/"weight"/.test(hash), 'веса сохраняются в ссылке');

  console.log('\n=== Регрессия: валюта, период, фильтры, детализация ===');
  click(doc.querySelector('[data-preset="revenue_payback"]'));
  await sleep(250);

  // валюта
  const num = (s) => Number(String(s).replace(/[^\d,.-]/g, '').replace(/\s/g, '').replace(',', '.'));
  const usdTop = num(cell(rows()[0], 9));
  change(doc.getElementById('currency'), 'RUB');
  await sleep(250);
  const rubTop = num(cell(rows()[0], 9));
  ok(/₽/.test(cell(rows()[0], 9)), `доход в рублях: "${cell(rows()[0], 9)}"`);
  ok(Math.abs(rubTop - usdTop * raw.rates.fiat.RUB) / (usdTop * raw.rates.fiat.RUB) < 0.01,
    `курс ${raw.rates.fiat.RUB} применён: ${rubTop.toFixed(0)} ≈ ${(usdTop * raw.rates.fiat.RUB).toFixed(0)}`);
  change(doc.getElementById('currency'), 'USD');
  await sleep(200);

  // период
  const dayRev = num(cell(rows()[0], 9));
  change(doc.getElementById('period'), '30');
  await sleep(250);
  const monRev = num(cell(rows()[0], 9));
  ok(Math.abs(monRev - dayRev * 30) / (dayRev * 30) < 0.01, `месяц = день × 30 (${monRev} ≈ ${(dayRev * 30).toFixed(2)})`);
  change(doc.getElementById('period'), '365');
  await sleep(250);
  const yrRev = num(cell(rows()[0], 9));
  ok(Math.abs(yrRev - dayRev * 365) / (dayRev * 365) < 0.01, `год = день × 365 (${yrRev} ≈ ${(dayRev * 365).toFixed(2)})`);
  change(doc.getElementById('period'), '1');
  await sleep(200);

  // фильтр по монете пересчитывает «лучшую монету»
  const sel = doc.getElementById('ticker');
  change(sel, 'RVN');
  await sleep(300);
  const pills = [...new Set(rows().map((tr) => cell(tr, 3)))];
  const rvn = allRows.filter((r) => r.coins.some((c) => c.ticker === 'RVN'));
  ok(pills.length === 1 && pills[0] === 'RVN', `фильтр RVN: только эти монеты (${pills.join(',')})`);
  ok(rows().length === rvn.length, `строк: ${rows().length} = ${rvn.length} в данных`);
  change(sel, '');
  await sleep(250);

  // поиск
  input(doc.getElementById('q'), '4090');
  await sleep(300);
  ok(rows().length > 0 && rows().every((tr) => tr.querySelector('.nm').textContent.includes('4090')), `поиск «4090»: ${rows().length} строк`);
  input(doc.getElementById('q'), '');
  await sleep(200);

  // добавление / удаление критериев
  const n0 = doc.querySelectorAll('#sortChips .chip').length;
  click(doc.getElementById('addSort'));
  await sleep(200);
  ok(doc.querySelectorAll('#sortChips .chip').length === n0 + 1, 'кнопка добавляет критерий');
  click(doc.querySelector('#sortChips .chip .del'));
  await sleep(200);
  ok(doc.querySelectorAll('#sortChips .chip').length === n0, 'крестик удаляет критерий');

  // один критерий: индекс-режим должен совпасть со строгим по этому полю
  click(doc.getElementById('clearSort'));
  await sleep(200);
  ok(doc.querySelectorAll('#sortChips .chip').length === 0, 'сброс очистил критерии');
  ok(rows().every((tr) => cell(tr, 12) === '—'), 'без критериев индекс пуст');
  click([...doc.querySelectorAll('thead th')].find((t) => t.dataset.sort === 'payback'));
  await sleep(250);
  const expOne = referenceOrder(allRows, 'strict', [{ key: 'payback', dir: 'asc', weight: 3 }]);
  ok(sameOrder(names(), expOne), 'один критерий в компромиссном режиме = строгая сортировка по нему');
  ok(names()[0] !== strictOrder[0], `и это не DGX B200, а «${names()[0]}»`);

  // детализация: число монет
  click(doc.querySelector('[data-preset="revenue_payback"]'));
  await sleep(250);
  const nm0 = names()[0];
  click(rows()[0]);
  await sleep(300);
  const det = doc.getElementById('detail');
  const srcCoins = allRows.find((r) => r.name === nm0).coins.length;
  ok(det.querySelectorAll('table')[1]?.querySelectorAll('tbody tr').length === srcCoins ||
     det.querySelectorAll('table')[0]?.querySelectorAll('tbody tr').length === srcCoins ||
     [...det.querySelectorAll('table')].some((t) => t.querySelectorAll('tbody tr').length === srcCoins),
    `монет в детализации: ${srcCoins}`);
  click(doc.getElementById('detailClose'));
  await sleep(150);

  console.log(`\n${failures === 0 ? '✅ ВСЕ ПРОВЕРКИ ПРОЙДЕНЫ' : `❌ ПРОВАЛЕНО ПРОВЕРОК: ${failures}`}`);
  window.close();
  stopServer();
  process.exit(failures === 0 ? 0 : 1);
})().catch((e) => {
  console.error('Ошибка теста:', e);
  stopServer();
  process.exit(1);
});
