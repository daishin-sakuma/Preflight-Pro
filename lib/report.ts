// Client-side check report (PDF).
//
// A REAL text PDF with runtime-subsetted embedded fonts (CID/Identity-H, see
// lib/fontEmbed.ts): Latin in Figtree (the app's brand face), Japanese in
// Zen Kaku Gothic New — all text selectable / searchable / sharp at any zoom.
// Fallback chain per line: Figtree → Zen Kaku → Standard-14 Helvetica
// (WinAnsi) → lossless inline image; page previews are images either way.
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

// Embedded report fonts (fetched lazily, cached). Both SIL OFL, static glyf
// TTFs (licenses in public/fonts/): Figtree for Latin (matches the app UI),
// Zen Kaku Gothic New for Japanese.
const FONT_URLS = {
  ltRegular: '/fonts/Figtree-Regular.ttf',
  ltBold: '/fonts/Figtree-Bold.ttf',
  jpRegular: '/fonts/ZenKakuGothicNew-Regular.ttf',
  jpBold: '/fonts/ZenKakuGothicNew-Bold.ttf',
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

// App icon for the report header, composited onto white with the same rounded
// corners the UI uses (radius = 25% of the box). Cached; null when unavailable
// (the header simply renders without it).
let logoCache: HTMLCanvasElement | null | undefined;
async function loadLogoCanvas(): Promise<HTMLCanvasElement | null> {
  if (logoCache !== undefined) return logoCache;
  try {
    const r = await fetch('/logo.png');
    if (!r.ok) throw new Error(String(r.status));
    const bmp = await createImageBitmap(await r.blob());
    const px = 144; // 46 logical units at ~3× for print sharpness
    const c = document.createElement('canvas');
    c.width = px; c.height = px;
    const ctx = c.getContext('2d')!;
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, px, px);
    ctx.beginPath();
    ctx.roundRect(0, 0, px, px, px * 0.25);
    ctx.clip();
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(bmp, 0, 0, px, px);
    bmp.close();
    logoCache = c;
  } catch {
    logoCache = null;
  }
  return logoCache;
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
  private ltReg: SubsetFont | null = null;   // Figtree (Latin, brand face)
  private ltBold: SubsetFont | null = null;
  private jpReg: SubsetFont | null = null;   // Zen Kaku Gothic New (Japanese)
  private jpBold: SubsetFont | null = null;

  // fetch + parse the embedded fonts (Figtree always; JP weights only when the
  // report contains CJK). Failures are fine — text() falls back per line.
  async loadFonts(needsCjk: boolean): Promise<void> {
    const [ltR, ltB, jpR, jpB] = await Promise.all([
      fetchFont(FONT_URLS.ltRegular),
      fetchFont(FONT_URLS.ltBold),
      needsCjk ? fetchFont(FONT_URLS.jpRegular) : Promise.resolve(null),
      needsCjk ? fetchFont(FONT_URLS.jpBold) : Promise.resolve(null),
    ]);
    this.ltReg = ltR ? SubsetFont.parse(ltR) : null;
    this.ltBold = ltB ? SubsetFont.parse(ltB) : null;
    this.jpReg = jpR ? SubsetFont.parse(jpR) : null;
    this.jpBold = jpB ? SubsetFont.parse(jpB) : null;
  }

  // attach the built subsets after layout (content ops already reference F3–F6)
  finishFonts(): void {
    if (this.jpReg?.used) this.doc.setCidFont('F3', this.jpReg.build('PFPROA+ZenKakuGothicNew-Regular'));
    if (this.jpBold?.used) this.doc.setCidFont('F4', this.jpBold.build('PFPROB+ZenKakuGothicNew-Bold'));
    if (this.ltReg?.used) this.doc.setCidFont('F5', this.ltReg.build('PFPROC+Figtree-Regular'));
    if (this.ltBold?.used) this.doc.setCidFont('F6', this.ltBold.build('PFPROD+Figtree-Bold'));
  }

  // per-line font resolution: Figtree → Zen Kaku → Helvetica → raster (null)
  private pickFont(t: string): { font: SubsetFont; res: string } | 'helvetica' | null {
    const lt = this.bold ? this.ltBold ?? this.ltReg : this.ltReg;
    if (lt?.covers(t)) return { font: lt, res: lt === this.ltBold ? 'F6' : 'F5' };
    const jp = this.bold ? this.jpBold ?? this.jpReg : this.jpReg;
    if (jp?.covers(t)) return { font: jp, res: jp === this.jpBold ? 'F4' : 'F3' };
    if (encodeWinAnsi(t) !== null) return 'helvetica';
    return null;
  }

  newPage() { this.doc.addPage(); }
  setFont(size: number, bold: boolean) { this.size = size; this.bold = bold; }
  measure(t: string) {
    // measure with the exact font the line will be typeset in, so wrapping
    // and right-alignment stay pixel-accurate
    const pick = this.pickFont(t);
    if (pick && pick !== 'helvetica') {
      const m = pick.font.measure(t, this.size);
      if (m != null) return m;
    }
    return measure(t, this.size, this.bold);
  }
  text(t: string, x: number, yBase: number, color: string) {
    const pick = this.pickFont(t);
    if (pick && pick !== 'helvetica') {
      const gids = pick.font.encode(t);
      if (gids) {
        this.doc.textCid(pick.res, gids, x, yBase, this.size, color);
        return;
      }
    }
    if (pick === 'helvetica' && this.doc.text(t, x, yBase, this.size, this.bold, color)) return;
    // last resort (fonts missing / glyph not covered anywhere): rasterize just
    // this line at 3× and place it losslessly at the text position.
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

function paintReport(
  p: PdfPainter, result: AnalysisResult, settings: Settings,
  logo: HTMLCanvasElement | null,
): void {
  let y = 0;
  const CW = W - M * 2;
  const newPage = () => { p.newPage(); y = M; };
  const ensure = (need: number) => { if (y + need > H - M - 40) newPage(); };

  newPage();

  // ---- title block (app icon + title, generation info at the right) ----
  if (logo) p.image(logo, M, y + 1, 46, 46);
  p.setFont(44, true);
  p.text('Preflight report', logo ? M + 62 : M, y + 40, INK);
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
  const [logo] = await Promise.all([loadLogoCanvas(), p.loadFonts(reportNeedsCjk(result))]);
  paintReport(p, result, settings, logo);
  p.finishFonts();
  const pdf = p.doc.build();
  saveBlob(new Blob([pdf as BlobPart], { type: 'application/pdf' }), `${baseName(result.fileName)}-preflight-report.pdf`);
}
