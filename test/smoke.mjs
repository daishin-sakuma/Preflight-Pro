// Smoke test: builds fixtures, boots `next dev`, and drives the app headlessly.
//  bad.pdf  -> expects RGB / 4色ベタ / 塗り足しなし / 白ノセ疑い / ヘアライン errors
//  good.pdf -> expects pass banner (no errors)
//  small.png-> expects RGB warning + サイズ(解像度)不足 error
// Run with: npm test
import { spawn, execSync } from 'node:child_process';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const PORT = 3777;

execSync('node test/gen-fixtures.mjs', { cwd: root, stdio: 'inherit' });

const server = spawn('npx', ['next', 'dev', '-p', String(PORT)], {
  cwd: root, stdio: 'pipe', env: { ...process.env },
});
let serverLog = '';
server.stdout.on('data', (d) => { serverLog += d; });
server.stderr.on('data', (d) => { serverLog += d; });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let failed = false;
const ok = (m) => console.log('✓ ' + m);
const fail = (m) => { console.error('✗ ' + m); failed = true; };

try {
  // wait for dev server
  let up = false;
  for (let i = 0; i < 60; i++) {
    await sleep(1000);
    if (/Ready in|started server|Local:/i.test(serverLog)) { up = true; break; }
  }
  if (!up) throw new Error('dev server did not start:\n' + serverLog.slice(-800));
  ok('dev server up');

  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 1440, height: 950 } });
  const errs = [];
  page.on('pageerror', (e) => errs.push(e.message));

  const upload = async (fixture) => {
    await page.goto(`http://localhost:${PORT}/`, { waitUntil: 'domcontentloaded' });
    await page.waitForSelector('input[type=file]', { timeout: 60000 });
    await page.setInputFiles('input[type=file]', join(root, 'test/fixtures', fixture));
    // confirm step: settings review, then explicit start
    await page.waitForSelector('.confirmActions button', { timeout: 30000 });
    await page.getByRole('button', { name: 'この設定でチェックを開始' }).click();
    await page.waitForSelector('.summaryBanner', { timeout: 90000 });
  };

  const bodyHas = async (text) => (await page.locator('body').innerText()).includes(text);
  const expect = async (label, text) =>
    (await bodyHas(text)) ? ok(`${label}: 「${text}」検出`) : fail(`${label}: 「${text}」が見つからない`);

  // ---- bad.pdf ----
  await upload('bad.pdf');
  await expect('bad.pdf', 'RGBカラーが含まれています');
  await expect('bad.pdf', '4色ベタ');
  await expect('bad.pdf', '塗り足しなし');
  await expect('bad.pdf', '白ノセ');
  await expect('bad.pdf', '極細線');
  await expect('bad.pdf', '総インキ量');
  (await page.locator('.summaryBanner.fail').count()) > 0
    ? ok('bad.pdf: エラー判定バナー表示') : fail('bad.pdf: fail バナーなし');
  // 3D canvas visible
  await sleep(1500);
  (await page.locator('.previewStage canvas').count()) > 0
    ? ok('bad.pdf: 3Dプレビュー canvas あり') : fail('bad.pdf: 3D canvas なし');
  await page.screenshot({ path: 'test/out-bad-3d.png' });
  // 2D tab with guides
  await page.getByRole('button', { name: '2D校正ビュー' }).click();
  await sleep(800);
  await page.screenshot({ path: 'test/out-bad-2d.png' });

  // ---- good.pdf ----
  await upload('good.pdf');
  (await page.locator('.summaryBanner.fail').count()) === 0
    ? ok('good.pdf: エラーなし') : fail('good.pdf: エラーが出ている\n' + (await page.locator('body').innerText()).slice(0, 1200));
  await expect('good.pdf', '塗り足しあり');
  await expect('good.pdf', 'CMYKカラーで作成されています');
  await page.screenshot({ path: 'test/out-good.png' });

  // ---- small.png ----
  await upload('small.png');
  await expect('small.png', 'サイズ (解像度) 不足');
  await expect('small.png', 'RGB');
  await page.screenshot({ path: 'test/out-png.png' });

  errs.length === 0 ? ok('ページエラーなし') : fail('page errors: ' + errs.join(' | '));
  await browser.close();
} catch (e) {
  fail('exception: ' + (e.stack || e));
} finally {
  server.kill('SIGTERM');
}

console.log(failed ? '\nSMOKE TEST FAILED' : '\nSMOKE TEST PASSED');
process.exit(failed ? 1 : 0);
