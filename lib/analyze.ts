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
      scan: r.scan,
      content: r.content,
      images: r.images,
      tac: r.tac,
      previews: r.previews,
      renderScale: r.renderScale,
      renderScales: r.renderScales,
      aiArtboardMm: r.aiArtboard ?? undefined,
      findings: [],
      notes: r.notes,
      renderPage: r.renderPage,
      ensurePage: r.ensurePage,
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

  // Decode a small preview, pushed as close to the real browser limits as we can:
  //  - CMYK JPEGs can't be decoded by the browser itself → wrap the JPEG in a
  //    one-page PDF (DCTDecode passthrough) and let pdf.js decode it instead.
  //  - Everything else is attempted via resize-on-decode (createImageBitmap with
  //    resizeWidth/Height). For JPEG this uses DCT down-scaling, so even ~500 MP
  //    files decode straight to a small bitmap without hitting GPU-texture /
  //    canvas-area limits or exhausting memory.
  //  - PNG must fully decompress to RGBA, so it's bounded by memory (~1 GB RGBA
  //    ≈ 260 MP); above that we skip to avoid crashing the tab.
  const isCmyk = info.colorSpace === 'cmyk';
  const area = (info.width || 0) * (info.height || 0);
  const pngTooLarge = kind === 'png' && area > 260_000_000;

  const decodePreview = async (): Promise<HTMLCanvasElement | null> => {
    const maxEdge = 2400;
    const w = info.width || 0, h = info.height || 0;
    const long = Math.max(w, h);
    const sc = long > 0 ? Math.min(1, maxEdge / long) : 1;
    const rw = w > 0 ? Math.max(1, Math.round(w * sc)) : 0;
    const rh = h > 0 ? Math.max(1, Math.round(h * sc)) : 0;
    const blob = new Blob([buf.buffer as ArrayBuffer]);
    let bitmap: ImageBitmap | null = null;
    try {
      bitmap = (rw && rh && (rw < w || rh < h))
        ? await createImageBitmap(blob, { resizeWidth: rw, resizeHeight: rh, resizeQuality: 'high' })
        : await createImageBitmap(blob);
    } catch {
      // browser rejected the resize options — try a plain full-size decode
      try { bitmap = await createImageBitmap(blob); } catch { return null; }
    }
    try {
      const tw = rw || bitmap.width, th = rh || bitmap.height;
      const c = document.createElement('canvas');
      c.width = tw; c.height = th;
      const ctx = c.getContext('2d', { willReadFrequently: true })!;
      ctx.fillStyle = '#fff';
      ctx.fillRect(0, 0, tw, th);
      ctx.drawImage(bitmap, 0, 0, tw, th); // downscales if the bitmap is full-size
      bitmap.close();
      return c;
    } catch {
      try { bitmap.close(); } catch { /* noop */ }
      return null;
    }
  };

  // CMYK JPEG: browsers can't decode these, but pdf.js can — wrap the JPEG
  // bytes (unmodified) in a minimal one-page PDF and render that. Adobe CMYK
  // JPEGs store inverted samples, signalled by the APP14 marker → /Decode.
  const decodeCmykJpeg = async (): Promise<HTMLCanvasElement | null> => {
    try {
      const [{ buildJpegPdf }, pdfjs, { ensurePdfWorker }] = await Promise.all([
        import('./minipdf.ts'),
        import('pdfjs-dist'),
        import('./pdf/analyzePdf.ts'),
      ]);
      ensurePdfWorker();
      const w = info.width || 1, h = info.height || 1;
      const long = Math.max(w, h);
      const fit = Math.min(1, 14000 / long); // stay under the 14400pt PDF page cap
      const pdf = buildJpegPdf([{
        jpeg: buf, pxW: w, pxH: h, wPt: w * fit, hPt: h * fit,
        colorSpace: 'DeviceCMYK',
        invertDecode: !!info.hasAdobeMarker,
      }]);
      const doc = await pdfjs.getDocument({ data: pdf }).promise;
      try {
        const page = await doc.getPage(1);
        const targetLong = Math.min(2400, long);
        const viewport = page.getViewport({ scale: targetLong / (long * fit) });
        const c = document.createElement('canvas');
        c.width = Math.max(1, Math.ceil(viewport.width));
        c.height = Math.max(1, Math.ceil(viewport.height));
        const ctx = c.getContext('2d', { willReadFrequently: true })!;
        ctx.fillStyle = '#fff';
        ctx.fillRect(0, 0, c.width, c.height);
        await page.render({ canvasContext: ctx, viewport }).promise;
        return c;
      } finally {
        doc.destroy().catch(() => {});
      }
    } catch {
      return null;
    }
  };

  let rawImg: HTMLCanvasElement | null = null;
  if (isCmyk) {
    onProgress?.('Decoding CMYK JPEG…');
    rawImg = await decodeCmykJpeg();
  } else if (!pngTooLarge) {
    rawImg = await decodePreview();
  }

  let previewUnavailable: string | undefined;
  if (!rawImg) {
    const px = info.width && info.height
      ? `${info.width.toLocaleString()}×${info.height.toLocaleString()}px, ~${Math.round(area / 1e6)} megapixels`
      : '';
    let reason: string;
    if (isCmyk) reason = 'it is a CMYK JPEG this browser could not decode (even via the PDF decode path)';
    else if (pngTooLarge) reason = `it is a very large PNG (${px}) — beyond the memory a browser can use to decompress a PNG`;
    else if (px) reason = `the browser could not decode it at this size (${px}) — beyond this browser/GPU's limit`;
    else reason = 'the browser could not decode it';
    previewUnavailable = `The visual preview and ink-coverage (TAC) estimate were skipped because ${reason}. Size, resolution and color checks below were still run from the file's metadata.`;
  }

  // page geometry: one page at the ordered size + bleed (reflects size/orientation)
  const paper = paperSizeMm(settings.paperId, settings.customWmm, settings.customHmm, settings.landscape);
  const wPt = (paper.wMm + settings.bleedMm * 2) * (72 / 25.4);
  const hPt = (paper.hMm + settings.bleedMm * 2) * (72 / 25.4);
  const trim: [number, number, number, number] = [
    settings.bleedMm * (72 / 25.4), settings.bleedMm * (72 / 25.4),
    wPt - settings.bleedMm * (72 / 25.4), hPt - settings.bleedMm * (72 / 25.4),
  ];

  // Compose the artwork onto an ordered-size (bleed) canvas, preserving the
  // image's own aspect (contain, centered on white). This makes the preview
  // reflect the chosen size/orientation while never stretching the artwork; a
  // letterbox appears when the image aspect differs from the order (flagged by
  // the aspect-ratio check). When rotating the image 90° fits the ordered
  // orientation better (e.g. a landscape photo on a portrait order), it is
  // composited rotated — matching how the resolution check judges it.
  let canvas: HTMLCanvasElement | null = null;
  if (rawImg) {
    const LONG = 2400;
    const pageAspect = wPt / hPt;
    const cw = pageAspect >= 1 ? LONG : Math.max(1, Math.round(LONG * pageAspect));
    const ch = pageAspect >= 1 ? Math.max(1, Math.round(LONG / pageAspect)) : LONG;
    const page = document.createElement('canvas');
    page.width = cw; page.height = ch;
    const pctx = page.getContext('2d', { willReadFrequently: true })!;
    pctx.fillStyle = '#fff';
    pctx.fillRect(0, 0, cw, ch);
    const fitSc = (iw: number, ih: number) => Math.min(cw / iw, ch / ih); // contain
    const rotate = fitSc(rawImg.height, rawImg.width) > fitSc(rawImg.width, rawImg.height);
    pctx.imageSmoothingEnabled = true; pctx.imageSmoothingQuality = 'high';
    if (rotate) {
      const sc = fitSc(rawImg.height, rawImg.width);
      const dw = rawImg.width * sc, dh = rawImg.height * sc; // pre-rotation size
      pctx.save();
      pctx.translate(cw / 2, ch / 2);
      pctx.rotate(Math.PI / 2);
      pctx.drawImage(rawImg, -dw / 2, -dh / 2, dw, dh);
      pctx.restore();
    } else {
      const sc = fitSc(rawImg.width, rawImg.height);
      const dw = rawImg.width * sc, dh = rawImg.height * sc;
      pctx.drawImage(rawImg, (cw - dw) / 2, (ch - dh) / 2, dw, dh);
    }
    canvas = page;
  }

  onProgress?.('Estimating ink coverage…');
  const tac = canvas ? [analyzeTac(canvas, 1, settings.tacLimit)] : [];

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
