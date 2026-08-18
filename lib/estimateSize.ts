// Pre-check ("精査") of an uploaded file before the full analysis runs:
// estimates the finished size AND extracts quick facts (measured bleed, page
// count, colour tendency, fonts, encryption, image metadata) for the confirm
// screen. Fast because nothing is rendered — only byte-level scanning.
//   Size: PDF/AI TrimBox (best) → MediaBox minus standard bleed → MediaBox
//         Images: pixel dimensions ÷ embedded DPI (JFIF / pHYs)

import { rawScanPdf } from './pdf/rawScan.ts';
import { interpretContent } from './pdf/contentInterp.ts';
import { analyzeJpeg, analyzePng, sniffImage } from './imageAnalyzer.ts';
import { PAPER_PRESETS } from './presets.ts';
import { MM_PER_PT } from './types.ts';

export interface SizeEstimate {
  wMm: number;              // finished-size estimate (portrait/landscape as-is)
  hMm: number;
  presetId: string | null;  // matching preset (null -> custom)
  landscape: boolean;
  sourceLabel: string;      // how it was derived (shown to the user)
}

export interface PrecheckInfo {
  kind: 'pdf' | 'image';
  size: SizeEstimate | null;
  pageCount: number | null;
  hasTrimBox: boolean;
  bleedMm: number | null;          // measured trim→page-edge distance (min side)
  colorHint: 'cmyk' | 'rgb-mixed' | 'gray' | 'unknown';
  encrypted: boolean;
  pdfVersion: string | null;
  fontsNotEmbedded: number;
  spotColors: number;
  image?: {
    format: 'png' | 'jpeg';
    width: number;
    height: number;
    dpi: number | null;
    colorSpace: string;
    hasAlpha: boolean;
  };
}

const TOL_MM = 1.5;
const r1 = (v: number) => Math.round(v * 10) / 10;

function matchPreset(w: number, h: number): { presetId: string; landscape: boolean } | null {
  for (const p of PAPER_PRESETS) {
    if (p.id === 'custom') continue;
    if (Math.abs(w - p.wMm) <= TOL_MM && Math.abs(h - p.hMm) <= TOL_MM) {
      return { presetId: p.id, landscape: false };
    }
    if (Math.abs(w - p.hMm) <= TOL_MM && Math.abs(h - p.wMm) <= TOL_MM) {
      return { presetId: p.id, landscape: true };
    }
  }
  return null;
}

function sizeFromBoxes(
  trim: number[] | undefined, media: number[] | undefined, bleedMm: number,
): SizeEstimate | null {
  if (trim) {
    const w = r1((trim[2] - trim[0]) * MM_PER_PT);
    const h = r1((trim[3] - trim[1]) * MM_PER_PT);
    const m = matchPreset(w, h);
    return {
      wMm: w, hMm: h,
      presetId: m?.presetId ?? null, landscape: m?.landscape ?? false,
      sourceLabel: 'TrimBox (仕上がり線) から算出',
    };
  }
  if (media) {
    const mw = (media[2] - media[0]) * MM_PER_PT;
    const mh = (media[3] - media[1]) * MM_PER_PT;
    const bw = r1(mw - bleedMm * 2), bh = r1(mh - bleedMm * 2);
    const mBleed = matchPreset(bw, bh);
    if (mBleed) {
      return { wMm: bw, hMm: bh, ...mBleed, sourceLabel: `ページサイズ − 塗り足し${bleedMm}mm×2 から算出` };
    }
    const pw = r1(mw), ph = r1(mh);
    const mPlain = matchPreset(pw, ph);
    if (mPlain) {
      return { wMm: pw, hMm: ph, ...mPlain, sourceLabel: 'ページサイズから算出 (塗り足しが無い可能性があります)' };
    }
    return {
      wMm: bw, hMm: bh, presetId: null, landscape: false,
      sourceLabel: `ページサイズ − 塗り足し${bleedMm}mm×2 から算出`,
    };
  }
  return null;
}

export function precheckFile(bytes: Uint8Array, bleedMm = 3): PrecheckInfo | null {
  const isPdf = bytes.length > 4 &&
    String.fromCharCode(bytes[0], bytes[1], bytes[2], bytes[3]) === '%PDF';

  if (isPdf) {
    if (bytes.length > 120 * 1024 * 1024) return null; // keep the confirm step snappy
    try {
      const raw = rawScanPdf(bytes);
      const trim = raw.boxes.trim[0];
      const media = raw.boxes.media[0];

      // measured bleed: min distance from trim to the outer box on any side
      let measuredBleed: number | null = null;
      const outer = raw.boxes.bleed[0] ?? media;
      if (trim && outer) {
        measuredBleed = r1(Math.max(0, Math.min(
          trim[0] - outer[0], outer[2] - trim[2],
          trim[1] - outer[1], outer[3] - trim[3],
        ) * MM_PER_PT));
      }

      const pageCount = (raw.corpus.match(/\/Type\s*\/Page\b(?!s)/g) ?? []).length || 1;

      // colour tendency (operator-level, no rendering)
      const content = interpretContent(raw.contentStreams, false, raw.csNames);
      const rgb = content.rgbOps > 0 || raw.scan.hasDeviceRGB || raw.scan.hasCalRGB;
      const cmyk = content.cmykFills.length > 0 || raw.scan.hasDeviceCMYK || raw.scan.iccCmykLikely;
      const colorHint: PrecheckInfo['colorHint'] =
        rgb ? 'rgb-mixed' : cmyk ? 'cmyk' : content.grayOps > 0 ? 'gray' : 'unknown';

      return {
        kind: 'pdf',
        size: sizeFromBoxes(trim, media, bleedMm),
        pageCount,
        hasTrimBox: !!trim,
        bleedMm: measuredBleed,
        colorHint,
        encrypted: raw.scan.encrypted,
        pdfVersion: raw.scan.pdfVersion,
        fontsNotEmbedded: raw.scan.fontsNotEmbedded.length,
        spotColors: raw.scan.separationNames.length,
      };
    } catch {
      return null;
    }
  }

  const kind = sniffImage(bytes);
  if (!kind) return null;
  try {
    const info = kind === 'png' ? analyzePng(bytes) : analyzeJpeg(bytes);

    let size: SizeEstimate | null = null;
    if (info.embeddedDpi && info.embeddedDpi >= 70 && info.width) {
      const dw = (info.width / info.embeddedDpi) * 25.4;
      const dh = (info.height / info.embeddedDpi) * 25.4;
      const bw = r1(dw - bleedMm * 2), bh = r1(dh - bleedMm * 2);
      const mBleed = matchPreset(bw, bh);
      if (mBleed) {
        size = { wMm: bw, hMm: bh, ...mBleed, sourceLabel: `画像サイズ (${info.embeddedDpi}dpi) − 塗り足し${bleedMm}mm×2 から算出` };
      } else {
        const pw = r1(dw), ph = r1(dh);
        const mPlain = matchPreset(pw, ph);
        size = mPlain
          ? { wMm: pw, hMm: ph, ...mPlain, sourceLabel: `画像サイズ (${info.embeddedDpi}dpi) から算出` }
          : { wMm: pw, hMm: ph, presetId: null, landscape: false, sourceLabel: `画像サイズ (${info.embeddedDpi}dpi) から算出 ※塗り足し込みの可能性あり` };
      }
    }

    return {
      kind: 'image',
      size,
      pageCount: 1,
      hasTrimBox: false,
      bleedMm: null,
      colorHint: info.colorSpace === 'cmyk' ? 'cmyk'
        : info.colorSpace === 'gray' ? 'gray'
          : info.colorSpace === 'unknown' ? 'unknown' : 'rgb-mixed',
      encrypted: false,
      pdfVersion: null,
      fontsNotEmbedded: 0,
      spotColors: 0,
      image: {
        format: info.format,
        width: info.width,
        height: info.height,
        dpi: info.embeddedDpi,
        colorSpace: info.colorSpace.toUpperCase(),
        hasAlpha: info.hasAlpha,
      },
    };
  } catch {
    return null;
  }
}

// Backward-compatible helper (also used by unit tests).
export function estimateSizeFromBytes(bytes: Uint8Array, bleedMm = 3): SizeEstimate | null {
  return precheckFile(bytes, bleedMm)?.size ?? null;
}
