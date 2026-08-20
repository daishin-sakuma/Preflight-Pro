// Entry point: dispatches a submitted file (PDF / AI / JPEG / PNG) to the
// appropriate analyzer and assembles the final AnalysisResult with findings.

import type { AnalysisResult, Settings } from './types.ts';
import { analyzePdf } from './pdf/analyzePdf.ts';
import { analyzeJpeg, analyzePng, sniffImage } from './imageAnalyzer.ts';
import { analyzeTac } from './tac.ts';
import { runChecks } from './checks.ts';
import { paperSizeMm } from './presets.ts';

export async function analyzeFile(
  file: File,
  settings: Settings,
  onProgress?: (msg: string) => void,
): Promise<AnalysisResult> {
  const buf = new Uint8Array(await file.arrayBuffer());
  const name = file.name.toLowerCase();

  const isPdfLike = buf.length > 4 &&
    String.fromCharCode(buf[0], buf[1], buf[2], buf[3]) === '%PDF';

  if (name.endsWith('.ai') && !isPdfLike) {
    throw new Error(
      'This Illustrator file was not saved in a PDF-compatible format. ' +
      'Re-save with “Create PDF Compatible File” enabled, or export as PDF.',
    );
  }

  if (isPdfLike) {
    onProgress?.('Loading PDF…');
    const r = await analyzePdf(buf, settings.tacLimit, onProgress);
    const result: AnalysisResult = {
      kind: 'pdf',
      fileName: file.name,
      fileSize: file.size,
      pageCount: r.pageCount,
      pages: r.pages,
      scan: r.raw.scan,
      content: r.content,
      images: r.images,
      tac: r.tac,
      previews: r.previews,
      renderScale: r.renderScale,
      aiArtboardMm: r.raw.aiArtboard ?? undefined,
      findings: [],
      notes: r.notes,
      renderPage: r.renderPage,
      dispose: r.dispose,
      markers: [
        ...r.content.markers,
        // TAC-over vector fills (limit is a setting, so resolved here)
        ...r.content.cmykFills
          .filter((c) => c.rectPt && c.tac > settings.tacLimit + 0.5)
          .map((c) => ({
            kind: 'tac' as const,
            page: c.page || 1,
            rectPt: c.rectPt!,
            label: `${Math.round(c.tac)}%`,
          })),
        // 4-color solid fills (C100 M100 Y100 K100 / registration-like)
        ...r.content.cmykFills
          .filter((c) => c.rectPt && c.c >= 0.99 && c.m >= 0.99 && c.y >= 0.99 && c.k >= 0.99)
          .map((c) => ({
            kind: 'four-color' as const,
            page: c.page || 1,
            rectPt: c.rectPt!,
            label: '4C solid',
          })),
        // dense 3-color fills (90%+ in all of C, M, Y, still within the TAC limit)
        ...r.content.cmykFills
          .filter((c) =>
            c.rectPt && c.tac <= settings.tacLimit &&
            [c.c, c.m, c.y].filter((v) => v >= 0.9).length >= 3)
          .map((c) => ({
            kind: 'three-color' as const,
            page: c.page || 1,
            rectPt: c.rectPt!,
            label: '3C',
          })),
        // low-resolution placed images (min-dpi is a setting, so resolved here).
        // Real dpi drops by the design-scale factor when the file is enlarged.
        ...(() => {
          const sc = settings.scale && settings.scale > 0 ? settings.scale : 1;
          return r.images
            .filter((im) =>
              im.rectPt && im.effectiveDpi / sc < settings.minDpi &&
              im.printWidthMm * sc > 5 && im.printHeightMm * sc > 5)
            .map((im) => ({
              kind: 'lowres' as const,
              page: im.page || 1,
              rectPt: im.rectPt!,
              label: `${Math.round(im.effectiveDpi / sc)}dpi`,
            }));
        })(),
      ],
    };
    if (name.endsWith('.ai')) {
      result.notes.push('Analyzed the Illustrator (.ai) file as PDF-compatible data.');
    }
    result.findings = runChecks(result, settings);
    return result;
  }

  const kind = sniffImage(buf);
  if (!kind) {
    throw new Error('Unsupported file format. Please submit PDF / AI (PDF-compatible) / JPEG / PNG.');
  }

  onProgress?.('Analyzing image…');
  const info = kind === 'png' ? analyzePng(buf) : analyzeJpeg(buf);

  // Browsers can only decode RGB/grayscale images, and canvas/decoder size is
  // capped (~16k px/edge, and a total-area limit). CMYK JPEGs and huge images
  // therefore can't be previewed — but the metadata checks below still run.
  const MAX_EDGE = 16384;
  const isCmyk = info.colorSpace === 'cmyk';
  const tooLarge = info.width > MAX_EDGE || info.height > MAX_EDGE
    || info.width * info.height > 100_000_000; // > ~100 MP

  // decode for preview + pixel TAC (skipped / caught for unsupported images)
  let canvas: HTMLCanvasElement | null = null;
  if (!isCmyk && !tooLarge && info.width > 0 && info.height > 0) {
    try {
      const bitmap = await createImageBitmap(new Blob([buf.buffer as ArrayBuffer]));
      const maxEdge = 2400;
      const sc = Math.min(1, maxEdge / Math.max(bitmap.width, bitmap.height));
      const c = document.createElement('canvas');
      c.width = Math.round(bitmap.width * sc);
      c.height = Math.round(bitmap.height * sc);
      const ctx = c.getContext('2d', { willReadFrequently: true })!;
      ctx.fillStyle = '#fff';
      ctx.fillRect(0, 0, c.width, c.height);
      ctx.drawImage(bitmap, 0, 0, c.width, c.height);
      bitmap.close();
      canvas = c;
    } catch {
      canvas = null; // fall through to metadata-only
    }
  }

  let previewUnavailable: string | undefined;
  if (!canvas) {
    const reasons: string[] = [];
    if (isCmyk) reasons.push('it is a CMYK JPEG (browsers can only decode RGB/grayscale images)');
    if (tooLarge) reasons.push(`it is very large (${info.width.toLocaleString()}×${info.height.toLocaleString()}px, ~${Math.round(info.width * info.height / 1e6)} megapixels — beyond the browser's decode limit)`);
    if (!reasons.length) reasons.push('the browser could not decode it');
    previewUnavailable = `The visual preview and ink-coverage (TAC) estimate were skipped because ${reasons.join(', and ')}. Size, resolution and color checks below were still run from the file's metadata.`;
  }

  onProgress?.('Estimating ink coverage…');
  const tac = canvas ? [analyzeTac(canvas, 1, settings.tacLimit)] : [];

  // page geometry: treat the image as one page at the ordered size + bleed
  const paper = paperSizeMm(settings.paperId, settings.customWmm, settings.customHmm, settings.landscape);
  const wPt = (paper.wMm + settings.bleedMm * 2) * (72 / 25.4);
  const hPt = (paper.hMm + settings.bleedMm * 2) * (72 / 25.4);
  const trim: [number, number, number, number] = [
    settings.bleedMm * (72 / 25.4), settings.bleedMm * (72 / 25.4),
    wPt - settings.bleedMm * (72 / 25.4), hPt - settings.bleedMm * (72 / 25.4),
  ];

  const result: AnalysisResult = {
    kind: 'image',
    fileName: file.name,
    fileSize: file.size,
    pageCount: 1,
    pages: [{
      page: 1,
      mediaBoxPt: [0, 0, wPt, hPt],
      trimBoxPt: trim,
      widthPt: wPt,
      heightPt: hPt,
    }],
    images: [],
    tac,
    imageInfo: info,
    previews: canvas ? [canvas] : [],
    renderScale: canvas ? canvas.width / wPt : 1,
    previewUnavailable,
    findings: [],
    notes: [],
    markers: [],
  };
  result.findings = runChecks(result, settings);
  return result;
}
