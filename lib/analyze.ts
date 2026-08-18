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
      'このIllustratorファイルはPDF互換形式で保存されていません。' +
      '保存時に「PDF互換ファイルを作成」にチェックを入れて保存し直すか、PDF形式で書き出してください。',
    );
  }

  if (isPdfLike) {
    onProgress?.('PDFを読み込み中…');
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
      findings: [],
      notes: r.notes,
    };
    if (name.endsWith('.ai')) {
      result.notes.push('Illustrator(.ai)ファイルをPDF互換データとして解析しました。');
    }
    result.findings = runChecks(result, settings);
    return result;
  }

  const kind = sniffImage(buf);
  if (!kind) {
    throw new Error('対応していないファイル形式です。PDF / AI (PDF互換) / JPEG / PNG を入稿してください。');
  }

  onProgress?.('画像を解析中…');
  const info = kind === 'png' ? analyzePng(buf) : analyzeJpeg(buf);

  // decode for preview + pixel TAC
  const bitmap = await createImageBitmap(new Blob([buf.buffer as ArrayBuffer]));
  const maxEdge = 1600;
  const sc = Math.min(1, maxEdge / Math.max(bitmap.width, bitmap.height));
  const canvas = document.createElement('canvas');
  canvas.width = Math.round(bitmap.width * sc);
  canvas.height = Math.round(bitmap.height * sc);
  const ctx = canvas.getContext('2d', { willReadFrequently: true })!;
  ctx.fillStyle = '#fff';
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
  bitmap.close();

  onProgress?.('インキ量を推定中…');
  const tac = [analyzeTac(canvas, 1, settings.tacLimit)];

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
    previews: [canvas],
    renderScale: canvas.width / wPt,
    findings: [],
    notes: [],
  };
  result.findings = runChecks(result, settings);
  return result;
}
