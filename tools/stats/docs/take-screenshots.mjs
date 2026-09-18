/**
 * Regenerates the screenshots in this folder.
 *
 *   node tools/stats/serve.mjs .local/site        # in one terminal
 *   npx --yes playwright@latest install chromium  # once
 *   node tools/stats/docs/take-screenshots.mjs tools/stats/docs
 *
 * Playwright is not a dependency of this tool, so it is resolved from wherever it happens
 * to be installed; adjust the import if yours lives elsewhere.
 */
import { chromium } from 'playwright';

const OUT = process.argv[2];
const browser = await chromium.launch();
const errors = [];

async function open(height = 1200) {
  const page = await browser.newPage({ viewport: { width: 1240, height }, deviceScaleFactor: 1 });
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
  await page.goto('http://localhost:4173/', { waitUntil: 'networkidle' });
  await page.waitForSelector('#campaigns tbody tr');
  return page;
}

// 1. Overview: coverage, filters, run health, time, trend, and the head of the table.
let page = await open(1400);
const tableTop = await page.$eval('#campaigns', (e) => Math.round(e.getBoundingClientRect().top + window.scrollY));
await page.screenshot({ path: `${OUT}/dashboard-overview.png`, clip: { x: 0, y: 0, width: 1240, height: tableTop + 430 } });
console.log('overview captured');

// 2. The campaign ranking on its own.
const box = await page.$eval('#campaigns', (e) => { const r = e.getBoundingClientRect(); return { top: Math.round(r.top + window.scrollY) }; });
await page.screenshot({ path: `${OUT}/campaign-ranking.png`, clip: { x: 0, y: box.top - 40, width: 1240, height: 780 } });
console.log('ranking captured');
await page.close();

// 3. A campaign expanded: the scenarios behind its failures.
page = await open(1400);
await page.click('#campaigns tbody tr.campaign:first-child');
await page.waitForTimeout(400);
const detail = await page.$eval('tr.detail', (e) => { const r = e.getBoundingClientRect(); return { top: Math.round(r.top + window.scrollY), height: Math.round(r.height) }; });
const first = await page.$eval('#campaigns tbody tr.campaign:first-child', (e) => Math.round(e.getBoundingClientRect().top + window.scrollY));
await page.screenshot({ path: `${OUT}/campaign-scenarios.png`, clip: { x: 0, y: first - 60, width: 1240, height: Math.min(detail.height + 140, 900) } });
console.log('scenarios captured');
await page.close();

// 4. The filter bar with the custom range open.
page = await open(700);
await page.selectOption('#f-window', 'custom');
await page.waitForTimeout(300);
await page.screenshot({ path: `${OUT}/filters.png`, clip: { x: 0, y: 60, width: 1240, height: 190 } });
console.log('filters captured');
await page.close();

console.log(errors.length ? `JS ERRORS: ${errors.join(' | ')}` : 'no JS errors');
await browser.close();
