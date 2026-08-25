// Client-side check report (PDF).
//
// A REAL text PDF: Latin via Standard-14 Helvetica, Japanese via
// runtime-subsetted embedded Zen Kaku Gothic New (CID/Identity-H, see
// lib/fontEmbed.ts) — all text selectable / searchable / sharp at any zoom.
// If the font can't load, non-Latin lines fall back to lossless inline
// images; page previews are images either way.
//
// The report is a document to hand to a print shop, so it always renders as a
// fixed light document independent of the app theme.

import pako from 'pako';
import type { AnalysisResult, Settings, Severity } from './types.ts';
import { CATEGORY_LABELS, CATEGORY_ORDER, pageRenderScale } from './types.ts';
import { renderOverlays } from './overlay.ts';
import { paperSizeMm, PAPER_PRESETS } from './presets.ts';
import { PdfDoc, encodeWinAnsi } from './pdfdoc.ts';
import { SubsetFont } from './fontEmbed.ts';

// Japanese fonts for real-text PDF embedding (fetched lazily, cached).
// Zen Kaku Gothic New — SIL OFL, static glyf TTFs (see public/fonts/OFL.txt).
const JP_FONT_URLS = {
  regular: '/fonts/ZenKakuGothicNew-Regular.ttf',
  bold: '/fonts/ZenKakuGothicNew-Bold.ttf',
};
const jpFontCache = new Map<string, ArrayBuffer | null>();
async function fetchFont(url: string): Promise<ArrayBuffer | null> {
  if (jpFontCache.has(url)) return jpFontCache.get(url)!;
  let buf: ArrayBuffer | null = null;
  try {
    const r = await fetch(url);
    if (r.ok) buf = await r.arrayBuffer();
  } catch { /* offline etc. — raster fallback covers it */ }
  jpFontCache.set(url, buf);
  return buf;
}

// logical layout grid (mapped onto the A4 page)
const W = 1240, H = 1754, M = 96;
const A4_W_PT = 595.28, A4_H_PT = 841.89;

const INK = '#1f232b', MUTED = '#5b6270', SUBTLE = '#8a909c', LINE = '#dcdfe5', WELL = '#f5f6f8';
const SEV_COLOR: Record<Severity, string> = {
  error: '#dc2626', warning: '#b45309', ok: '#15803d', info: '#64748b',
};
const SEV_LABEL: Record<Severity, string> = { error: 'ERROR', warning: 'WARN', ok: 'OK', info: 'INFO' };
const SEV_RANK: Record<Severity, number> = { ok: 0, info: 1, warning: 2, error: 3 };

// Helvetica-first so canvas measurement matches the PDF's Standard-14
// Helvetica (Arial is metric-compatible where Helvetica is absent)
const FONT_STACK = 'Helvetica, Arial, sans-serif';
const fontCss = (size: number, bold: boolean) => `${bold ? 700 : 400} ${size}px ${FONT_STACK}`;

// shared text measurer (identical wrapping for both painters)
let measCtx: CanvasRenderingContext2D | null = null;
function measure(t: string, size: number, bold: boolean): number {
  measCtx ??= document.createElement('canvas').getContext('2d')!;
  measCtx.font = fontCss(size, bold);
  return measCtx.measureText(t).width;
}

// canvas → deflated raw RGB (lossless FlateDecode stream)
const canvasFlateRgb = (c: HTMLCanvasElement): Uint8Array => {
  const { data } = c.getContext('2d')!.getImageData(0, 0, c.width, c.height);
  const rgb = new Uint8Array(c.width * c.height * 3);
  for (let i = 0, o = 0; i < data.length; i += 4) {
    rgb[o++] = data[i]; rgb[o++] = data[i + 1]; rgb[o++] = data[i + 2];
  }
  return pako.deflate(rgb);
};

// ---- PDF painter --------------------------------------------------------------

class PdfPainter {
  doc = new PdfDoc(A4_W_PT, A4_H_PT, W, H);
  private size = 21;
  private bold = false;
  private jpReg: SubsetFont | null = null;
  private jpBold: SubsetFont | null = null;

  // fetch + parse the Japanese fonts (no-op when unavailable; text() then
  // falls back to rasterizing non-Latin lines)
  async loadJapaneseFonts(): Promise<void> {
    const [reg, bold] = await Promise.all([
      fetchFont(JP_FONT_URLS.regular), fetchFont(JP_FONT_URLS.bold),
    ]);
    this.jpReg = reg ? SubsetFont.parse(reg) : null;
    this.jpBold = bold ? SubsetFont.parse(bold) : null;
  }

  // attach the built subsets after layout (content ops already reference F3/F4)
  finishFonts(): void {
    if (this.jpReg?.used) this.doc.setCidFont('F3', this.jpReg.build('PFPROA+ZenKakuGothicNew-Regular'));
    if (this.jpBold?.used) this.doc.setCidFont('F4', this.jpBold.build('PFPROB+ZenKakuGothicNew-Bold'));
  }

  private jpFor(bold: boolean): { font: SubsetFont; res: string } | null {
    if (bold && this.jpBold) return { font: this.jpBold, res: 'F4' };
    return this.jpReg ? { font: this.jpReg, res: 'F3' } : null;
  }

  newPage() { this.doc.addPage(); }
  setFont(size: number, bold: boolean) { this.size = size; this.bold = bold; }
  measure(t: string) {
    // non-Latin lines are typeset with the embedded JP font, so measure with
    // its actual advance widths (keeps wrapping exact)
    if (encodeWinAnsi(t) === null) {
      const m = this.jpFor(this.bold)?.font.measure(t, this.size);
      if (m != null) return m;
    }
    return measure(t, this.size, this.bold);
  }
  text(t: string, x: number, yBase: number, color: string) {
    if (this.doc.text(t, x, yBase, this.size, this.bold, color)) return;
    // outside WinAnsi → embedded subset CID font (real, selectable text)
    const jp = this.jpFor(this.bold);
    const gids = jp?.font.encode(t);
    if (jp && gids) {
      this.doc.textCid(jp.res, gids, x, yBase, this.size, color);
      return;
    }
    // last resort (font missing / glyph not covered): rasterize just this
    // line at 3× and place it losslessly at the text position.
    const wLog = Math.max(1, this.measure(t));
    const hLog = this.size * 1.45;
    const RAS = 3;
    const c = document.createElement('canvas');
    c.width = Math.ceil(wLog * RAS);
    c.height = Math.ceil(hLog * RAS);
    const cx = c.getContext('2d')!;
    cx.scale(RAS, RAS);
    cx.fillStyle = '#ffffff';
    cx.fillRect(0, 0, wLog + 1, hLog + 1);
    cx.fillStyle = color;
    cx.font = fontCss(this.size, this.bold);
    cx.fillText(t, 0, this.size * 1.1);
    this.doc.image(canvasFlateRgb(c), c.width, c.height, x, yBase - this.size * 1.1, wLog, hLog);
  }
  fillRect(x: number, yTop: number, w: number, h: number, color: string, radius = 0) {
    this.doc.fillRect(x, yTop, w, h, color, radius);
  }
  strokeRect(x: number, yTop: number, w: number, h: number, color: string, lw: number, radius = 0) {
    this.doc.strokeRect(x, yTop, w, h, color, lw, radius);
  }
  line(x1: number, y1: number, x2: number, y2: number, color: string, lw: number) {
    this.doc.line(x1, y1, x2, y2, color, lw);
  }
  image(src: HTMLCanvasElement, x: number, yTop: number, w: number, h: number, border?: string) {
    this.doc.image(canvasFlateRgb(src), src.width, src.height, x, yTop, w, h);
    if (border) this.doc.strokeRect(x, yTop, w, h, border, 1);
  }
  footers(make: (i: number, total: number) => { left: string; right: string }) {
    const total = this.doc.pageCount;
    for (let i = 0; i < total; i++) {
      this.doc.usePage(i);
      this.setFont(19, false);
      const { left, right } = make(i, total);
      this.text(left, M, H - 48, SUBTLE);
      this.text(right, W - M - this.measure(right), H - 48, SUBTLE);
    }
  }
}

// ---- shared layout ------------------------------------------------------------

function wrap(p: PdfPainter, text: string, maxW: number): string[] {
  const words = text.split(/\s+/);
  const lines: string[] = [];
  let line = '';
  for (const word of words) {
    const probe = line ? `${line} ${word}` : word;
    if (p.measure(probe) <= maxW) { line = probe; continue; }
    if (line) lines.push(line);
    if (p.measure(word) > maxW) {
      // hard-split an over-long single word (long names / values)
      let part = '';
      for (const ch of word) {
        if (p.measure(part + ch) > maxW) { lines.push(part); part = ch; }
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

// page preview composited with guides/dims/bleed, capped for embedding
function previewComposite(result: AnalysisResult, settings: Settings, pageIdx: number): HTMLCanvasElement {
  const src = result.previews[pageIdx];
  const comp = document.createElement('canvas');
  comp.width = src.width; comp.height = src.height;
  const cc = comp.getContext('2d')!;
  cc.drawImage(src, 0, 0);
  renderOverlays(comp, {
    result, settings, pageIdx,
    showTac: false, showGuides: true, showDims: true, showBleed: true,
    markerKind: null, scaleOverride: pageRenderScale(result, pageIdx),
  });
  const long = Math.max(comp.width, comp.height);
  if (long <= 1800) return comp;
  const k = 1800 / long;
  const capped = document.createElement('canvas');
  capped.width = Math.round(comp.width * k);
  capped.height = Math.round(comp.height * k);
  const kc = capped.getContext('2d')!;
  kc.imageSmoothingEnabled = true;
  kc.imageSmoothingQuality = 'high';
  kc.drawImage(comp, 0, 0, capped.width, capped.height);
  return capped;
}

function paintReport(p: PdfPainter, result: AnalysisResult, settings: Settings): void {
  let y = 0;
  const CW = W - M * 2;
  const newPage = () => { p.newPage(); y = M; };
  const ensure = (need: number) => { if (y + need > H - M - 40) newPage(); };

  newPage();

  // ---- title block ----
  p.setFont(44, true);
  p.text('Preflight report', M, y + 40, INK);
  p.setFont(22, false);
  const gen = `Generated ${new Date().toLocaleString('en-US')} · Preflight Pro`;
  p.text(gen, W - M - p.measure(gen), y + 40, SUBTLE);
  y += 72;
  p.line(M, y, W - M, y, LINE, 2);
  y += 34;

  // file + criteria facts
  const paper = paperSizeMm(settings.paperId, settings.customWmm, settings.customHmm, settings.landscape);
  const preset = PAPER_PRESETS.find((q) => q.id === settings.paperId);
  const facts: [string, string][] = [
    ['File', `${result.fileName} (${(result.fileSize / 1024 / 1024).toFixed(2)}MB · ${result.kind === 'pdf' ? `PDF · ${result.pageCount} page${result.pageCount > 1 ? 's' : ''}` : `${result.imageInfo?.format.toUpperCase() ?? 'image'}`})`],
    ['Finished size', `${paper.wMm}×${paper.hMm}mm${preset && preset.id !== 'custom' ? ` (${preset.label})` : ''}${settings.landscape ? ' · landscape' : ''}${settings.scale !== 1 ? ` · design scale 1:${settings.scale}` : ''}`],
    ['Criteria', `Bleed ${settings.bleedMm}mm · Ink limit ${settings.tacLimit}% · Min resolution ${settings.minDpi}dpi · RGB: ${settings.requireCmyk ? 'error (CMYK required)' : 'warning only'}`],
  ];
  for (const [label, value] of facts) {
    p.setFont(20, true);
    p.text(label.toUpperCase(), M, y, SUBTLE);
    p.setFont(23, false);
    for (const line of wrap(p, value, CW - 220)) {
      p.text(line, M + 220, y, INK);
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
  p.fillRect(M, y, CW, 76, WELL, 10);
  p.strokeRect(M, y, CW, 76, verdictColor, 2, 10);
  p.setFont(27, true);
  p.text(verdictText, M + 28, y + 47, verdictColor);
  p.setFont(23, false);
  const tally = `Errors ${errs} · Warnings ${warns} · OK ${oks}`;
  p.text(tally, W - M - 28 - p.measure(tally), y + 47, MUTED);
  y += 76 + 44;

  // ---- findings by category ----
  const catIndex = CATEGORY_ORDER.filter((cat) => result.findings.some((f) => f.category === cat));
  catIndex.forEach((cat, ci) => {
    const items = result.findings
      .filter((f) => f.category === cat)
      .sort((a, b) => SEV_RANK[b.severity] - SEV_RANK[a.severity]);
    ensure(70);
    p.setFont(26, true);
    p.text(`${ci + 1}. ${CATEGORY_LABELS[cat]}`, M, y, INK);
    y += 14;
    p.line(M, y, W - M, y, LINE, 1);
    y += 30;

    for (const f of items) {
      p.setFont(21, false);
      const detailLines = wrap(p, f.detail, CW - 40);
      const blockH = 34 + detailLines.length * 27 + (f.pages?.length ? 26 : 0) + 18;
      ensure(blockH);

      // severity tag
      p.setFont(17, true);
      const tag = SEV_LABEL[f.severity];
      const tagW = p.measure(tag) + 18;
      p.fillRect(M, y - 17, tagW, 24, SEV_COLOR[f.severity], 4);
      p.text(tag, M + 9, y + 1, '#ffffff');
      // title
      p.setFont(23, true);
      p.text(`${f.title}${f.count ? ` (${f.count})` : ''}`, M + tagW + 14, y + 1, INK);
      y += 32;
      // detail
      p.setFont(21, false);
      for (const line of detailLines) {
        p.text(line, M + 40, y, MUTED);
        y += 27;
      }
      if (f.pages?.length) {
        p.setFont(19, false);
        p.text(`Pages: ${f.pages.join(', ')}`, M + 40, y, SUBTLE);
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
    p.setFont(26, true);
    p.text(`${catIndex.length + 1}. Page previews (guides / dimensions / bleed)`, M, y, INK);
    y += 14;
    p.line(M, y, W - M, y, LINE, 1);
    y += 34;

    for (const i of previewIdxs) {
      const comp = previewComposite(result, settings, i);
      const k = Math.min(CW / comp.width, 620 / comp.height);
      const dw = Math.round(comp.width * k), dh = Math.round(comp.height * k);
      ensure(dh + 64);
      const dx = M + Math.round((CW - dw) / 2);
      p.image(comp, dx, y, dw, dh, LINE);
      y += dh + 8;
      p.setFont(19, false);
      const cap = result.pageCount > 1 ? `Page ${i + 1}` : result.fileName;
      p.text(cap, M + Math.round((CW - p.measure(cap)) / 2), y + 12, SUBTLE);
      y += 44;
    }
  }

  p.footers((i, total) => ({
    left: 'Preflight Pro — pre-submission self-check (does not replace the shop\'s inspection)',
    right: `${i + 1} / ${total}`,
  }));
}

// ---- downloads ------------------------------------------------------------

function saveBlob(blob: Blob, name: string) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 5000);
}

const baseName = (n: string) => n.replace(/\.[^.]+$/, '');

// does any dynamic report text need a non-Latin (CJK) font?
function reportNeedsCjk(result: AnalysisResult): boolean {
  const texts = [
    result.fileName,
    ...result.findings.flatMap((f) => [f.title, f.detail]),
    ...result.notes,
  ];
  return texts.some((t) => encodeWinAnsi(t) === null);
}

export async function downloadReportPdf(result: AnalysisResult, settings: Settings): Promise<void> {
  const p = new PdfPainter();
  if (reportNeedsCjk(result)) await p.loadJapaneseFonts();
  paintReport(p, result, settings);
  p.finishFonts();
  const pdf = p.doc.build();
  saveBlob(new Blob([pdf as BlobPart], { type: 'application/pdf' }), `${baseName(result.fileName)}-preflight-report.pdf`);
}
