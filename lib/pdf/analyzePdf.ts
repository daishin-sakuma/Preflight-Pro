// PDF analysis orchestration using pdf.js:
//  - renders page previews (also used for pixel TAC analysis)
//  - walks the operator list to compute effective DPI of every placed image
//    (tracking the CTM through save/restore/transform/form-xobjects)
//  - merges byte-level scan + content-stream interpretation results.

import * as pdfjs from 'pdfjs-dist';
import type { PlacedImage, PageGeom, TacResult } from '../types.ts';
import { MM_PER_PT } from '../types.ts';
import { rawScanPdf, type RawScanResult } from './rawScan.ts';
import { interpretContent } from './contentInterp.ts';
import { analyzeTac } from '../tac.ts';
import type { ContentStats } from '../types.ts';

let workerReady = false;
function ensureWorker() {
  if (!workerReady) {
    pdfjs.GlobalWorkerOptions.workerSrc = '/pdf.worker.min.mjs';
    workerReady = true;
  }
}

type Mat = [number, number, number, number, number, number];
const IDENT: Mat = [1, 0, 0, 1, 0, 0];
function mul(m: Mat, n: Mat): Mat {
  // returns m applied then n (n ∘ m), PDF convention: cm concatenates left
  return [
    m[0] * n[0] + m[1] * n[2],
    m[0] * n[1] + m[1] * n[3],
    m[2] * n[0] + m[3] * n[2],
    m[2] * n[1] + m[3] * n[3],
    m[4] * n[0] + m[5] * n[2] + n[4],
    m[4] * n[1] + m[5] * n[3] + n[5],
  ];
}

export interface PdfAnalysis {
  pageCount: number;
  pages: PageGeom[];
  raw: RawScanResult;
  content: ContentStats;
  images: PlacedImage[];
  tac: TacResult[];
  previews: HTMLCanvasElement[];
  renderScale: number;
  notes: string[];
  renderPage: (pageIdx: number, scale: number) => Promise<HTMLCanvasElement | null>;
  dispose: () => void;
}

function pickBox(list: number[][], pageIdx: number): [number, number, number, number] | undefined {
  if (!list.length) return undefined;
  const b = list.length > pageIdx ? list[pageIdx] : list[0];
  return [b[0], b[1], b[2], b[3]];
}

export async function analyzePdf(
  bytes: Uint8Array,
  tacLimit: number,
  onProgress?: (msg: string) => void,
): Promise<PdfAnalysis> {
  ensureWorker();
  const notes: string[] = [];

  onProgress?.('Analyzing PDF structure…');
  const raw = rawScanPdf(bytes);

  onProgress?.('Analyzing color & overprint…');
  const content = interpretContent(raw.contentStreams, raw.scan.overprintTrue, raw.csNames, raw.fontNames, raw.gsNames);

  // merge gradient (shading) endpoint colors — they carry real ink values but
  // never appear as fill operators in the content stream.
  for (const g of raw.gradientCmyk) {
    content.cmykFills.push({
      c: g.c, m: g.m, y: g.y, k: g.k,
      tac: (g.c + g.m + g.y + g.k) * 100,
      inText: false, page: 0, isFill: true,
    });
  }

  const doc = await pdfjs.getDocument({ data: bytes.slice() }).promise;
  const pageCount = doc.numPages;

  const pages: PageGeom[] = [];
  const images: PlacedImage[] = [];
  const tac: TacResult[] = [];
  const previews: HTMLCanvasElement[] = [];
  let renderScale = 1;

  const maxAnalyzePages = Math.min(pageCount, 8);
  if (pageCount > maxAnalyzePages) {
    notes.push(`Many pages: preview/image analysis was limited to the first ${maxAnalyzePages} pages.`);
  }

  for (let p = 1; p <= maxAnalyzePages; p++) {
    onProgress?.(`Rendering page ${p}/${maxAnalyzePages}…`);
    const page = await doc.getPage(p);
    const view = page.view as number[]; // crop box
    const media = pickBox(raw.boxes.media, p - 1) ?? [view[0], view[1], view[2], view[3]];
    const geom: PageGeom = {
      page: p,
      viewBoxPt: [view[0], view[1], view[2], view[3]],
      mediaBoxPt: media as [number, number, number, number],
      trimBoxPt: pickBox(raw.boxes.trim, p - 1),
      bleedBoxPt: pickBox(raw.boxes.bleed, p - 1),
      cropBoxPt: pickBox(raw.boxes.crop, p - 1),
      artBoxPt: pickBox(raw.boxes.art, p - 1),
      widthPt: view[2] - view[0],
      heightPt: view[3] - view[1],
    };
    pages.push(geom);

    // ---- render preview ----
    // Target ~2200px on the long edge regardless of page size, so small pages
    // (business cards etc.) render at high scale and stay sharp when the
    // preview stage displays them large / zoomed. Cap at 10x for tiny pages.
    const longEdge = Math.max(geom.widthPt, geom.heightPt);
    const scale = Math.min(10, Math.max(0.5, 2200 / longEdge));
    renderScale = scale;
    const viewport = page.getViewport({ scale });
    const canvas = document.createElement('canvas');
    canvas.width = Math.ceil(viewport.width);
    canvas.height = Math.ceil(viewport.height);
    const ctx = canvas.getContext('2d', { willReadFrequently: true })!;
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    await page.render({ canvasContext: ctx, viewport }).promise;
    previews.push(canvas);

    // ---- pixel TAC (approximate) ----
    tac.push(analyzeTac(canvas, p, tacLimit));

    // ---- effective DPI of placed images via operator list ----
    try {
      const ops = await page.getOperatorList();
      let ctm: Mat = IDENT;
      const stack: Mat[] = [];
      for (let i = 0; i < ops.fnArray.length; i++) {
        const fn = ops.fnArray[i];
        const args = ops.argsArray[i];
        switch (fn) {
          case pdfjs.OPS.save: stack.push(ctm); break;
          case pdfjs.OPS.restore: ctm = stack.pop() ?? IDENT; break;
          case pdfjs.OPS.transform:
            ctm = mul(args as Mat, ctm);
            break;
          case pdfjs.OPS.paintFormXObjectBegin: {
            stack.push(ctm);
            const m = (args?.[0] ?? null) as Mat | null;
            if (m) ctm = mul(m, ctm);
            break;
          }
          case pdfjs.OPS.paintFormXObjectEnd:
            ctm = stack.pop() ?? IDENT;
            break;
          case pdfjs.OPS.paintImageXObject:
          case pdfjs.OPS.paintInlineImageXObject:
          case pdfjs.OPS.paintImageMaskXObject: {
            let pw = 0, ph = 0;
            if (fn === pdfjs.OPS.paintImageXObject) {
              const id = args[0] as string;
              try {
                const obj: any = page.objs.has(id) ? page.objs.get(id) : null;
                if (obj) { pw = obj.width; ph = obj.height; }
              } catch { /* unresolved */ }
              if (!pw && typeof args[1] === 'number') { pw = args[1]; ph = args[2]; }
            } else {
              const obj: any = args[0];
              if (obj) { pw = obj.width ?? 0; ph = obj.height ?? 0; }
            }
            if (!pw || !ph) break;
            // image unit square -> page space
            const wPt = Math.hypot(ctm[0], ctm[1]);
            const hPt = Math.hypot(ctm[2], ctm[3]);
            if (wPt < 1 || hPt < 1) break;
            const dpiX = pw / (wPt / 72);
            const dpiY = ph / (hPt / 72);
            const xs = [ctm[4], ctm[0] + ctm[4], ctm[2] + ctm[4], ctm[0] + ctm[2] + ctm[4]];
            const ys = [ctm[5], ctm[1] + ctm[5], ctm[3] + ctm[5], ctm[1] + ctm[3] + ctm[5]];
            images.push({
              page: p,
              pxWidth: pw,
              pxHeight: ph,
              printWidthMm: wPt * MM_PER_PT,
              printHeightMm: hPt * MM_PER_PT,
              effectiveDpi: Math.round(Math.min(dpiX, dpiY)),
              rectPt: {
                x: Math.min(...xs), y: Math.min(...ys),
                w: Math.max(...xs) - Math.min(...xs),
                h: Math.max(...ys) - Math.min(...ys),
              },
            });
            break;
          }
          default: break;
        }
      }
    } catch (e) {
      notes.push(`Skipped image analysis on page ${p} (${String(e).slice(0, 80)})`);
    }
  }

  // page geometry for remaining pages (no render)
  for (let p = maxAnalyzePages + 1; p <= pageCount; p++) {
    const page = await doc.getPage(p);
    const view = page.view as number[];
    pages.push({
      page: p,
      mediaBoxPt: pickBox(raw.boxes.media, p - 1) ?? [view[0], view[1], view[2], view[3]],
      trimBoxPt: pickBox(raw.boxes.trim, p - 1),
      bleedBoxPt: pickBox(raw.boxes.bleed, p - 1),
      cropBoxPt: pickBox(raw.boxes.crop, p - 1),
      artBoxPt: pickBox(raw.boxes.art, p - 1),
      widthPt: view[2] - view[0],
      heightPt: view[3] - view[1],
    });
  }

  // keep `doc` alive so the 2D view can re-render the current page at higher
  // resolution on deep zoom (avoids upscaling a fixed bitmap = jagged/blurry).
  const renderPage = async (pageIdx: number, scale: number): Promise<HTMLCanvasElement | null> => {
    if (pageIdx < 0 || pageIdx >= pageCount) return null;
    try {
      const page = await doc.getPage(pageIdx + 1);
      const viewport = page.getViewport({ scale });
      const canvas = document.createElement('canvas');
      canvas.width = Math.ceil(viewport.width);
      canvas.height = Math.ceil(viewport.height);
      const ctx = canvas.getContext('2d')!;
      ctx.fillStyle = '#ffffff';
      ctx.fillRect(0, 0, canvas.width, canvas.height);
      await page.render({ canvasContext: ctx, viewport }).promise;
      return canvas;
    } catch {
      return null;
    }
  };
  const dispose = () => { doc.destroy().catch(() => {}); };

  return {
    pageCount, pages, raw, content, images, tac, previews, renderScale, notes,
    renderPage, dispose,
  };
}
