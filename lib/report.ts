// Client-side check report: renders the summary, criteria, findings and
// annotated page previews onto A4 canvases, downloadable as a PDF (via the
// minimal JPEG-page writer) or as a single stitched PNG. The report is a
// document to hand to a print shop, so it always renders as a fixed light
// document independent of the app theme.

import type { AnalysisResult, Finding, Settings, Severity } from './types.ts';
import { CATEGORY_LABELS, CATEGORY_ORDER, pageRenderScale } from './types.ts';
import { renderOverlays } from './overlay.ts';
import { paperSizeMm, PAPER_PRESETS } from './presets.ts';
import { buildJpegPdf } from './minipdf.ts';

const W = 1240, H = 1754, M = 96;   // A4 @ ~150dpi with page margins
const A4_W_PT = 595.28, A4_H_PT = 841.89;

const INK = '#1f232b', MUTED = '#5b6270', SUBTLE = '#8a909c', LINE = '#dcdfe5', WELL = '#f5f6f8';
const SEV_COLOR: Record<Severity, string> = {
  error: '#dc2626', warning: '#b45309', ok: '#15803d', info: '#64748b',
};
const SEV_LABEL: Record<Severity, string> = { error: 'ERROR', warning: 'WARN', ok: 'OK', info: 'INFO' };
const SEV_RANK: Record<Severity, number> = { ok: 0, info: 1, warning: 2, error: 3 };

const FONT = 'sans-serif';

function wrapText(ctx: CanvasRenderingContext2D, text: string, maxW: number): string[] {
  const words = text.split(/\s+/);
  const lines: string[] = [];
  let line = '';
  for (const word of words) {
    const probe = line ? `${line} ${word}` : word;
    if (ctx.measureText(probe).width <= maxW) { line = probe; continue; }
    if (line) lines.push(line);
    // hard-split an over-long single word (rare: long names / values)
    if (ctx.measureText(word).width > maxW) {
      let part = '';
      for (const ch of word) {
        if (ctx.measureText(part + ch).width > maxW) { lines.push(part); part = ch; }
        else part += ch;
      }
      line = part;
    } else {
      line = word;
    }
  }
  if (line) lines.push(line);
  return lines;
}

function buildReportPages(result: AnalysisResult, settings: Settings): HTMLCanvasElement[] {
  const pages: HTMLCanvasElement[] = [];
  let ctx: CanvasRenderingContext2D = null!;
  let y = 0;
  const CW = W - M * 2;

  const newPage = () => {
    const c = document.createElement('canvas');
    c.width = W; c.height = H;
    ctx = c.getContext('2d')!;
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, W, H);
    pages.push(c);
    y = M;
  };
  const ensure = (need: number) => { if (y + need > H - M - 40) newPage(); };

  newPage();

  // ---- title block ----
  ctx.fillStyle = INK;
  ctx.font = `700 44px ${FONT}`;
  ctx.fillText('Preflight report', M, y + 40);
  ctx.fillStyle = SUBTLE;
  ctx.font = `22px ${FONT}`;
  const gen = `Generated ${new Date().toLocaleString('en-US')} · Preflight Pro`;
  ctx.fillText(gen, W - M - ctx.measureText(gen).width, y + 40);
  y += 72;
  ctx.strokeStyle = LINE;
  ctx.lineWidth = 2;
  ctx.beginPath(); ctx.moveTo(M, y); ctx.lineTo(W - M, y); ctx.stroke();
  y += 34;

  // file + criteria facts
  const paper = paperSizeMm(settings.paperId, settings.customWmm, settings.customHmm, settings.landscape);
  const preset = PAPER_PRESETS.find((p) => p.id === settings.paperId);
  const facts: [string, string][] = [
    ['File', `${result.fileName} (${(result.fileSize / 1024 / 1024).toFixed(2)}MB · ${result.kind === 'pdf' ? `PDF · ${result.pageCount} page${result.pageCount > 1 ? 's' : ''}` : `${result.imageInfo?.format.toUpperCase() ?? 'image'}`})`],
    ['Finished size', `${paper.wMm}×${paper.hMm}mm${preset && preset.id !== 'custom' ? ` (${preset.label})` : ''}${settings.landscape ? ' · landscape' : ''}${settings.scale !== 1 ? ` · design scale 1:${settings.scale}` : ''}`],
    ['Criteria', `Bleed ${settings.bleedMm}mm · Ink limit ${settings.tacLimit}% · Min resolution ${settings.minDpi}dpi · RGB: ${settings.requireCmyk ? 'error (CMYK required)' : 'warning only'}`],
  ];
  for (const [label, value] of facts) {
    ctx.fillStyle = SUBTLE;
    ctx.font = `700 20px ${FONT}`;
    ctx.fillText(label.toUpperCase(), M, y);
    ctx.fillStyle = INK;
    ctx.font = `23px ${FONT}`;
    for (const line of wrapText(ctx, value, CW - 220)) {
      ctx.fillText(line, M + 220, y);
      y += 30;
    }
    y += 8;
  }
  y += 10;

  // ---- verdict banner ----
  const errs = result.findings.filter((x) => x.severity === 'error').length;
  const warns = result.findings.filter((x) => x.severity === 'warning').length;
  const oks = result.findings.filter((x) => x.severity === 'ok').length;
  const verdictColor = errs ? SEV_COLOR.error : warns ? SEV_COLOR.warning : SEV_COLOR.ok;
  const verdictText = errs
    ? 'Problems were found that need fixing'
    : warns ? 'Ready to submit, but some items are worth reviewing' : 'All checks passed';
  ensure(96);
  ctx.fillStyle = WELL;
  ctx.strokeStyle = verdictColor;
  ctx.lineWidth = 2;
  ctx.beginPath(); ctx.roundRect(M, y, CW, 76, 10); ctx.fill(); ctx.stroke();
  ctx.fillStyle = verdictColor;
  ctx.font = `700 27px ${FONT}`;
  ctx.fillText(verdictText, M + 28, y + 47);
  ctx.fillStyle = MUTED;
  ctx.font = `23px ${FONT}`;
  const tally = `Errors ${errs} · Warnings ${warns} · OK ${oks}`;
  ctx.fillText(tally, W - M - 28 - ctx.measureText(tally).width, y + 47);
  y += 76 + 44;

  // ---- findings by category ----
  const catIndex = CATEGORY_ORDER.filter((cat) => result.findings.some((f) => f.category === cat));
  catIndex.forEach((cat, ci) => {
    const items = result.findings
      .filter((f) => f.category === cat)
      .sort((a, b) => SEV_RANK[b.severity] - SEV_RANK[a.severity]);
    ensure(70);
    ctx.fillStyle = INK;
    ctx.font = `700 26px ${FONT}`;
    ctx.fillText(`${ci + 1}. ${CATEGORY_LABELS[cat]}`, M, y);
    y += 14;
    ctx.strokeStyle = LINE;
    ctx.lineWidth = 1;
    ctx.beginPath(); ctx.moveTo(M, y); ctx.lineTo(W - M, y); ctx.stroke();
    y += 30;

    for (const f of items) {
      ctx.font = `21px ${FONT}`;
      const detailLines = wrapText(ctx, f.detail, CW - 40);
      const blockH = 34 + detailLines.length * 27 + (f.pages?.length ? 26 : 0) + 18;
      ensure(blockH);

      // severity tag
      ctx.font = `700 17px ${FONT}`;
      const tag = SEV_LABEL[f.severity];
      const tagW = ctx.measureText(tag).width + 18;
      ctx.fillStyle = SEV_COLOR[f.severity];
      ctx.beginPath(); ctx.roundRect(M, y - 17, tagW, 24, 4); ctx.fill();
      ctx.fillStyle = '#ffffff';
      ctx.fillText(tag, M + 9, y + 1);
      // title
      ctx.fillStyle = INK;
      ctx.font = `700 23px ${FONT}`;
      ctx.fillText(`${f.title}${f.count ? ` (${f.count})` : ''}`, M + tagW + 14, y + 1);
      y += 32;
      // detail
      ctx.fillStyle = MUTED;
      ctx.font = `21px ${FONT}`;
      for (const line of detailLines) {
        ctx.fillText(line, M + 40, y);
        y += 27;
      }
      if (f.pages?.length) {
        ctx.fillStyle = SUBTLE;
        ctx.font = `19px ${FONT}`;
        ctx.fillText(`Pages: ${f.pages.join(', ')}`, M + 40, y);
        y += 26;
      }
      y += 18;
    }
    y += 16;
  });

  // ---- annotated page previews ----
  const previewIdxs: number[] = [];
  for (let i = 0; i < result.previews.length && previewIdxs.length < 6; i++) {
    if (result.previews[i]) previewIdxs.push(i);
  }
  if (previewIdxs.length) {
    ensure(120);
    ctx.fillStyle = INK;
    ctx.font = `700 26px ${FONT}`;
    ctx.fillText(`${catIndex.length + 1}. Page previews (guides / dimensions / bleed)`, M, y);
    y += 14;
    ctx.strokeStyle = LINE;
    ctx.lineWidth = 1;
    ctx.beginPath(); ctx.moveTo(M, y); ctx.lineTo(W - M, y); ctx.stroke();
    y += 34;

    for (const i of previewIdxs) {
      const src = result.previews[i];
      const comp = document.createElement('canvas');
      comp.width = src.width; comp.height = src.height;
      const cc = comp.getContext('2d')!;
      cc.drawImage(src, 0, 0);
      renderOverlays(comp, {
        result, settings, pageIdx: i,
        showTac: false, showGuides: true, showDims: true, showBleed: true,
        markerKind: null, scaleOverride: pageRenderScale(result, i),
      });
      const maxW = CW, maxH = 620;
      const k = Math.min(maxW / comp.width, maxH / comp.height);
      const dw = Math.round(comp.width * k), dh = Math.round(comp.height * k);
      ensure(dh + 64);
      const dx = M + Math.round((CW - dw) / 2);
      ctx.drawImage(comp, dx, y, dw, dh);
      ctx.strokeStyle = LINE;
      ctx.lineWidth = 1;
      ctx.strokeRect(dx - 0.5, y - 0.5, dw + 1, dh + 1);
      y += dh + 8;
      ctx.fillStyle = SUBTLE;
      ctx.font = `19px ${FONT}`;
      const cap = result.pageCount > 1 ? `Page ${i + 1}` : result.fileName;
      ctx.fillText(cap, M + Math.round((CW - ctx.measureText(cap).width) / 2), y + 12);
      y += 44;
    }
  }

  // footers (drawn last so the page total is known)
  pages.forEach((c, i) => {
    const fx = c.getContext('2d')!;
    fx.fillStyle = SUBTLE;
    fx.font = `19px ${FONT}`;
    fx.fillText(`Preflight Pro — pre-submission self-check (does not replace the shop's inspection)`, M, H - 48);
    const num = `${i + 1} / ${pages.length}`;
    fx.fillText(num, W - M - fx.measureText(num).width, H - 48);
  });

  return pages;
}

const canvasJpeg = (c: HTMLCanvasElement, quality = 0.88) =>
  new Promise<Uint8Array>((resolve, reject) => {
    c.toBlob((b) => {
      if (!b) { reject(new Error('toBlob failed')); return; }
      b.arrayBuffer().then((a) => resolve(new Uint8Array(a)), reject);
    }, 'image/jpeg', quality);
  });

function saveBlob(blob: Blob, name: string) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 5000);
}

const baseName = (n: string) => n.replace(/\.[^.]+$/, '');

export async function downloadReportPdf(result: AnalysisResult, settings: Settings): Promise<void> {
  const pages = buildReportPages(result, settings);
  const jpegs = await Promise.all(pages.map((c) => canvasJpeg(c)));
  const pdf = buildJpegPdf(jpegs.map((jpeg, i) => ({
    jpeg, pxW: pages[i].width, pxH: pages[i].height, wPt: A4_W_PT, hPt: A4_H_PT,
  })));
  saveBlob(new Blob([pdf as BlobPart], { type: 'application/pdf' }), `${baseName(result.fileName)}-preflight-report.pdf`);
}

export async function downloadReportPng(result: AnalysisResult, settings: Settings): Promise<void> {
  const pages = buildReportPages(result, settings);
  const GAP = 24;
  const out = document.createElement('canvas');
  out.width = W;
  out.height = pages.length * H + (pages.length - 1) * GAP;
  const ctx = out.getContext('2d')!;
  ctx.fillStyle = '#9aa0a8';
  ctx.fillRect(0, 0, out.width, out.height);
  pages.forEach((c, i) => ctx.drawImage(c, 0, i * (H + GAP)));
  const blob = await new Promise<Blob | null>((resolve) => out.toBlob(resolve, 'image/png'));
  if (blob) saveBlob(blob, `${baseName(result.fileName)}-preflight-report.png`);
}
