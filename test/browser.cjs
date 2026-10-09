/**
 * Браузерная проверка на настоящем Chromium: скриншоты, экспорт CSV,
 * отсутствие ошибок в консоли, реакция на смену весов.
 *
 * Требуется Playwright (необязательная зависимость):
 *   npm i -D playwright && npx playwright install chromium
 *   npm run test:browser
 *
 * Переменные: BASE (по умолчанию http://127.0.0.1:8099), SHOT_DIR.
 */
'use strict';

const fs = require('node:fs');
const path = require('node:path');

let chromium;
try {
  ({ chromium } = require('playwright'));
} catch {
  console.log('Playwright не установлен — браузерная проверка пропущена.');
  console.log('Установить: npm i -D playwright && npx playwright install chromium');
  process.exit(0);
}

const BASE = process.env.BASE || 'http://127.0.0.1:8099';
const SHOT_DIR = process.env.SHOT_DIR || path.join(__dirname, '..', 'recon');
const TMP = process.env.TMPDIR || '/tmp';

let failures = 0;
const ok = (cond, msg) => {
  console.log(`${cond ? '  ✅' : '  ❌'} ${msg}`);
  if (!cond) failures++;
};

(async () => {
  fs.mkdirSync(SHOT_DIR, { recursive: true });
  const browser = await chromium.launch();
  const context = await browser.newContext({
    viewport: { width: 1720, height: 1080 },
    acceptDownloads: true,
  });
  const page = await context.newPage();

  const errors = [];
  page.on('pageerror', (e) => errors.push('pageerror: ' + e.message));
  page.on('console', (m) => {
    if (m.type() === 'error') errors.push(m.text());
  });

  await page.goto(BASE + '/', { waitUntil: 'networkidle' });
  await page.waitForSelector('#tbody tr');
  await page.waitForTimeout(700);

  console.log('\n=== Страница и режимы ===');
  ok((await page.locator('#tbody tr').count()) === 135, 'отрисовано 135 строк');
  ok(!(await page.locator('#tolWrap').isVisible()), 'поле допуска скрыто в режиме компромисса');
  ok(await page.locator('.col-index').first().isVisible(), 'колонка «Индекс» видна');

  const prices = await page.$$eval('#tbody tr', (trs) =>
    trs.slice(0, 12).map((tr) => tr.children[8].textContent.trim()));
  ok(!prices.some((p) => /USD|RUB|EUR/.test(p)), `валюта показана символом: ${prices.slice(0, 4).join(' | ')}`);

  await page.screenshot({ path: path.join(SHOT_DIR, 'browser-default.png') });

  await page.selectOption('#mode', 'tolerance');
  await page.waitForTimeout(400);
  ok(await page.locator('#tolWrap').isVisible(), 'поле допуска появилось в режиме допуска');
  await page.screenshot({ path: path.join(SHOT_DIR, 'browser-tolerance.png') });

  console.log('\n=== Веса реально меняют порядок ===');
  await page.click('[data-preset="revenue_payback"]');
  await page.waitForTimeout(500);
  const first1 = (await page.textContent('#tbody tr:first-child .nm')).trim();
  const sliders = page.locator('#sortChips .chip .weight input');
  await sliders.nth(0).fill('1');
  await sliders.nth(1).fill('10');
  await page.waitForTimeout(600);
  const first2 = (await page.textContent('#tbody tr:first-child .nm')).trim();
  ok(first1 !== first2, `лидер сменился при весах 3:2 → 1:10: «${first1}» → «${first2}»`);

  console.log('\n=== Скриншоты ===');
  await page.click('[data-preset="revenue_payback"]');
  await page.waitForTimeout(500);
  await page.screenshot({ path: path.join(SHOT_DIR, 'browser-table.png') });
  ok(true, 'browser-table.png');

  await page.click('#tbody tr:first-child');
  await page.waitForTimeout(500);
  ok(/Из чего сложился индекс/.test(await page.textContent('#detail')), 'в карточке есть расшифровка индекса');
  await page.screenshot({ path: path.join(SHOT_DIR, 'browser-detail.png') });
  ok(true, 'browser-detail.png');
  await page.keyboard.press('Escape');
  await page.waitForTimeout(200);

  console.log('\n=== Экспорт CSV ===');
  const [download] = await Promise.all([
    page.waitForEvent('download', { timeout: 20000 }),
    page.click('#exportBtn'),
  ]);
  const csvPath = path.join(TMP, 'kryptex-export.csv');
  await download.saveAs(csvPath);
  const csv = fs.readFileSync(csvPath, 'utf8');
  const lines = csv.trim().split('\r\n');
  ok(lines.length === 136, `строк в CSV: ${lines.length} (шапка + 135)`);
  ok(/Индекс баланса/.test(lines[0]), 'в CSV есть колонка «Индекс баланса»');
  ok(lines[1].split(';').length === 15, `колонок: ${lines[1].split(';').length}`);
  ok(/GeForce|Radeon|ARC|CMP|H100|B200|MI/.test(lines[1]), `первая строка: ${lines[1].slice(0, 90)}…`);

  console.log('\n=== Консоль ===');
  ok(errors.length === 0, errors.length ? `ошибки: ${errors.join(' | ')}` : 'ошибок в консоли нет');

  await browser.close();
  console.log(`\n${failures === 0 ? '✅ ВСЕ ПРОВЕРКИ ПРОЙДЕНЫ' : `❌ ПРОВАЛЕНО ПРОВЕРОК: ${failures}`}`);
  process.exit(failures === 0 ? 0 : 1);
})().catch((e) => {
  console.error('Ошибка браузерной проверки:', e);
  process.exit(1);
});
