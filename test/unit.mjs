// Node-level unit test for the preflight brain (no browser needed).
// Exercises rawScan + contentInterp + imageAnalyzer + checks on the fixtures.
// Uses Node's native TypeScript type-stripping (Node >= 22.6 / 24).
// Run: node test/unit.mjs   (fixtures must exist: node test/gen-fixtures.mjs)
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const fx = (n) => new Uint8Array(readFileSync(join(root, 'test/fixtures', n)));

const { rawScanPdf } = await import('../lib/pdf/rawScan.ts');
const { interpretContent } = await import('../lib/pdf/contentInterp.ts');
const { analyzePng, analyzeJpeg, sniffImage } = await import('../lib/imageAnalyzer.ts');
const { runChecks } = await import('../lib/checks.ts');
const { DEFAULT_SETTINGS, MM_PER_PT } = await import('../lib/types.ts');

let failed = false;
const ok = (m) => console.log('✓ ' + m);
const fail = (m) => { console.error('✗ ' + m); failed = true; };
const expect = (cond, label) => (cond ? ok(label) : fail(label));

// Build an AnalysisResult-shaped object for runChecks without browser parts.
function makeResult(kind, raw, content, pagesGeom, extra = {}) {
  return {
    kind, fileName: 'x', fileSize: 0,
    pageCount: pagesGeom.length, pages: pagesGeom,
    scan: raw?.scan, content,
    images: [], tac: [], previews: [], renderScale: 1,
    findings: [], notes: [],
    markers: content?.markers ?? [],
    ...extra,
  };
}

function geomFromBoxes(raw, wPt, hPt) {
  const media = raw.boxes.media[0] ?? [0, 0, wPt, hPt];
  return [{
    page: 1,
    mediaBoxPt: media,
    trimBoxPt: raw.boxes.trim[0],
    bleedBoxPt: raw.boxes.bleed[0],
    widthPt: media[2] - media[0],
    heightPt: media[3] - media[1],
  }];
}

// ---------------- bad.pdf ----------------
{
  const bytes = fx('bad.pdf');
  const raw = rawScanPdf(bytes);
  const content = interpretContent(raw.contentStreams, raw.scan.overprintTrue);

  expect(raw.contentStreams.length >= 1, 'bad.pdf: コンテンツストリーム抽出');
  expect(raw.scan.overprintTrue, 'bad.pdf: オーバープリント(/OP true)検出');
  expect(content.rgbOps > 0, 'bad.pdf: RGBオペレータ(rg)検出');
  expect(content.cmykFills.some((c) => c.tac >= 399), 'bad.pdf: 400%ベタのCMYK値検出');
  expect(content.cmykFills.some((c) => [c.c, c.m, c.y].filter((v) => v >= 0.9).length >= 3 && c.k === 0),
    'bad.pdf: 3色高濃度検出');
  expect(content.hairlineCount > 0, 'bad.pdf: ヘアライン(0.1pt)検出');
  expect(content.whiteFillWithGs > 0, 'bad.pdf: 白塗り+gs(白ノセ疑い)検出');

  // ---- location markers (該当箇所) ----
  const rgbM = content.markers.filter((m) => m.kind === 'rgb');
  expect(rgbM.length >= 1 &&
    Math.abs(rgbM[0].rectPt.x - 50) < 1 && Math.abs(rgbM[0].rectPt.y - 600) < 1 &&
    Math.abs(rgbM[0].rectPt.w - 200) < 1 && Math.abs(rgbM[0].rectPt.h - 100) < 1,
    `bad.pdf: RGBマーカー位置=(50,600,200,100) (got ${JSON.stringify(rgbM[0]?.rectPt)})`);
  const woM = content.markers.filter((m) => m.kind === 'white-op');
  expect(woM.length >= 1 && Math.abs(woM[0].rectPt.x - 300) < 1 && Math.abs(woM[0].rectPt.y - 600) < 1,
    `bad.pdf: 白ノセマーカー位置=(300,600) (got ${JSON.stringify(woM[0]?.rectPt)})`);
  expect(content.markers.some((m) => m.kind === 'hairline'), 'bad.pdf: 細線マーカーあり');
  const tac400 = content.cmykFills.find((c) => c.tac >= 399);
  expect(!!tac400?.rectPt && Math.abs(tac400.rectPt.x - 50) < 1 && Math.abs(tac400.rectPt.y - 450) < 1,
    `bad.pdf: 400%ベタの位置記録=(50,450) (got ${JSON.stringify(tac400?.rectPt)})`);

  const res = makeResult('pdf', raw, content, geomFromBoxes(raw, 595.28, 841.89));
  const findings = runChecks(res, DEFAULT_SETTINGS);
  const ids = Object.fromEntries(findings.map((x) => [x.id, x.severity]));
  expect(ids['rgb'] === 'error', 'checks: RGB=エラー');
  expect(ids['4c-black'] === 'error', 'checks: 4色ベタ=エラー');
  expect(ids['tac-vector'] === 'error', 'checks: TAC超過=エラー');
  expect(ids['3c-heavy'] === 'warning', 'checks: 3色ベタ=注意');
  expect(ids['white-op'] === 'error', 'checks: 白ノセ疑い=エラー');
  expect(ids['hairline'] === 'warning', 'checks: ヘアライン=注意');
  expect(ids['trim-missing'] === 'error', 'checks: 塗り足しなし(原寸ジャスト)=エラー');
  const byId = Object.fromEntries(findings.map((x) => [x.id, x]));
  expect(byId['rgb'].markerKind === 'rgb', 'checks: RGB→マーカー紐付け');
  expect(byId['white-op'].markerKind === 'white-op', 'checks: 白ノセ→マーカー紐付け');
  expect(byId['hairline'].markerKind === 'hairline', 'checks: 細線→マーカー紐付け');
}

// ---------------- good.pdf ----------------
{
  const bytes = fx('good.pdf');
  const raw = rawScanPdf(bytes);
  const content = interpretContent(raw.contentStreams, raw.scan.overprintTrue);

  expect(raw.boxes.trim.length === 1, 'good.pdf: TrimBox抽出 (Flateストリーム展開込み)');
  expect(content.rgbOps === 0, 'good.pdf: RGBなし');
  expect(content.cmykFills.length >= 2 && content.cmykFills.every((c) => c.tac <= 300),
    'good.pdf: CMYK値すべて300%以内');

  const res = makeResult('pdf', raw, content, geomFromBoxes(raw, 612.29, 858.9));
  const findings = runChecks(res, DEFAULT_SETTINGS);
  const errs = findings.filter((x) => x.severity === 'error');
  expect(errs.length === 0, `good.pdf: エラー0件 ${errs.length ? '(' + errs.map((e) => e.id).join(',') + ')' : ''}`);
  const ids = Object.fromEntries(findings.map((x) => [x.id, x.severity]));
  expect(ids['bleed'] === 'ok', 'checks: 塗り足しOK');
  expect(ids['trim-size'] === 'ok', 'checks: 仕上がりサイズ一致');
  expect(ids['rgb'] === 'ok', 'checks: CMYK判定OK');
}

// ---------------- ai-style.pdf (ICCBased CMYK / gradient) ----------------
{
  const bytes = fx('ai-style.pdf');
  const raw = rawScanPdf(bytes);
  expect(raw.csNames['CS0']?.kind === 'cmyk', 'ai-style: /CS0 → ICCBased CMYK解決');
  expect(raw.scan.iccCmykLikely === true, 'ai-style: iccCmykLikely');
  expect(raw.scan.overprintTrue === false, 'ai-style: /OPMのみ→オーバープリント誤検知なし');
  expect(raw.gradientCmyk.length >= 2, `ai-style: グラデーション色抽出 (got ${raw.gradientCmyk.length})`);

  const content = interpretContent(raw.contentStreams, false, raw.csNames);
  expect(content.cmykFills.some((c) => Math.abs(c.c - 0.9) < 0.01 && Math.abs(c.m - 0.1) < 0.01),
    'ai-style: scn経由のCMYK値 (0.9,0.1,0,0) 記録');
  expect(content.rgbOps === 0, 'ai-style: RGB誤検知なし');

  for (const g of raw.gradientCmyk) {
    content.cmykFills.push({ c: g.c, m: g.m, y: g.y, k: g.k, tac: (g.c + g.m + g.y + g.k) * 100, inText: false, page: 0, isFill: true });
  }
  const res = makeResult('pdf', raw, content, geomFromBoxes(raw, 612.28, 858.89));
  const findings = runChecks(res, DEFAULT_SETTINGS);
  const ids = Object.fromEntries(findings.map((x) => [x.id, x.severity]));
  expect(ids['rgb'] === 'ok', 'ai-style: checks CMYK判定=OK');
  expect(findings.filter((x) => x.severity === 'error').length === 0,
    'ai-style: エラー0件');
}

// ---------------- small.png ----------------
{
  const bytes = fx('small.png');
  expect(sniffImage(bytes) === 'png', 'small.png: フォーマット判定');
  const info = analyzePng(bytes);
  expect(info.width === 120 && info.height === 120, 'small.png: サイズ 120×120');
  expect(info.colorSpace === 'rgb', 'small.png: RGB判定');
  expect(info.embeddedDpi === 72, `small.png: 72dpi判定 (got ${info.embeddedDpi})`);

  const wPt = (210 + 6) / MM_PER_PT, hPt = (297 + 6) / MM_PER_PT;
  const res = makeResult('image', null, null, [{
    page: 1, mediaBoxPt: [0, 0, wPt, hPt], widthPt: wPt, heightPt: hPt,
  }], { imageInfo: info });
  const findings = runChecks(res, DEFAULT_SETTINGS);
  const ids = Object.fromEntries(findings.map((x) => [x.id, x.severity]));
  expect(ids['img-bleed'] === 'error', 'checks: 解像度不足=エラー');
  expect(ids['img-rgb'] === 'warning', 'checks: RGB画像=注意');
}

// ---------------- size estimation ----------------
{
  const { estimateSizeFromBytes } = await import('../lib/estimateSize.ts');

  const eGood = estimateSizeFromBytes(fx('good.pdf'), 3);
  expect(eGood?.presetId === 'a4' && !eGood.landscape,
    `estimate: good.pdf → A4縦 (TrimBoxから) (got ${JSON.stringify(eGood)})`);
  expect(!!eGood?.sourceLabel.includes('TrimBox'), 'estimate: good.pdf 由来=TrimBox');

  const eBad = estimateSizeFromBytes(fx('bad.pdf'), 3);
  expect(eBad?.presetId === 'a4',
    `estimate: bad.pdf → A4 (原寸ページから) (got ${JSON.stringify(eBad)})`);
  expect(!!eBad?.sourceLabel.includes('塗り足しが無い'), 'estimate: bad.pdf 塗り足しなし注記');

  const eAi = estimateSizeFromBytes(fx('ai-style.pdf'), 3);
  expect(eAi?.presetId === 'a4', `estimate: ai-style.pdf → A4 (got ${JSON.stringify(eAi)})`);

  const ePng = estimateSizeFromBytes(fx('small.png'), 3);
  expect(ePng !== null && ePng.presetId === null &&
    Math.abs(ePng.wMm - 42.3) < 0.2 && Math.abs(ePng.hMm - 42.3) < 0.2,
    `estimate: small.png → 42.3mm カスタム (72dpiから) (got ${JSON.stringify(ePng)})`);
}

// ---------------- jpeg marker parser (tiny inline CMYK-less jpeg) ----------
{
  // minimal JFIF header JPEG (SOI, APP0 JFIF 300dpi, SOF0 3comp 10x10, EOI)
  const b = [];
  const push16 = (v) => { b.push((v >> 8) & 0xff, v & 0xff); };
  b.push(0xff, 0xd8);                       // SOI
  b.push(0xff, 0xe0); push16(16);           // APP0 len16
  b.push(...[..."JFIF\0"].map((c) => c.charCodeAt(0)), 1, 1, 1);
  push16(300); push16(300); b.push(0, 0);
  b.push(0xff, 0xc0); push16(17);           // SOF0
  b.push(8); push16(10); push16(10); b.push(3, 1, 0x11, 0, 2, 0x11, 1, 3, 0x11, 1);
  b.push(0xff, 0xd9);                       // EOI
  const info = analyzeJpeg(new Uint8Array(b));
  expect(info.width === 10 && info.height === 10, 'jpeg: SOF0サイズ解析');
  expect(info.colorSpace === 'rgb', 'jpeg: 3成分=RGB判定');
  expect(info.embeddedDpi === 300, `jpeg: JFIF 300dpi判定 (got ${info.embeddedDpi})`);
}

console.log(failed ? '\nUNIT TEST FAILED' : '\nUNIT TEST PASSED');
process.exit(failed ? 1 : 0);
