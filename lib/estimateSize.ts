// Estimates the finished (trim) size from an uploaded file, before the full
// check runs, so the user can adopt it as the check target size.
//   PDF/AI : TrimBox (best) → MediaBox minus standard bleed → MediaBox as-is
//   Images : pixel dimensions ÷ embedded DPI (JFIF / pHYs)
// Estimates are matched against paper presets (both orientations).

import { rawScanPdf } from './pdf/rawScan.ts';
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

export function estimateSizeFromBytes(bytes: Uint8Array, bleedMm = 3): SizeEstimate | null {
  const isPdf = bytes.length > 4 &&
    String.fromCharCode(bytes[0], bytes[1], bytes[2], bytes[3]) === '%PDF';

  if (isPdf) {
    if (bytes.length > 120 * 1024 * 1024) return null; // keep the confirm step snappy
    try {
      const raw = rawScanPdf(bytes);
      const trim = raw.boxes.trim[0];
      const media = raw.boxes.media[0];
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
          return {
            wMm: bw, hMm: bh, ...mBleed,
            sourceLabel: `ページサイズ − 塗り足し${bleedMm}mm×2 から算出`,
          };
        }
        const pw = r1(mw), ph = r1(mh);
        const mPlain = matchPreset(pw, ph);
        if (mPlain) {
          return {
            wMm: pw, hMm: ph, ...mPlain,
            sourceLabel: 'ページサイズから算出 (塗り足しが無い可能性があります)',
          };
        }
        return {
          wMm: bw, hMm: bh, presetId: null, landscape: false,
          sourceLabel: `ページサイズ − 塗り足し${bleedMm}mm×2 から算出`,
        };
      }
    } catch {
      return null;
    }
    return null;
  }

  const kind = sniffImage(bytes);
  if (!kind) return null;
  try {
    const info = kind === 'png' ? analyzePng(bytes) : analyzeJpeg(bytes);
    if (!info.embeddedDpi || info.embeddedDpi < 70 || !info.width) return null;
    const dw = (info.width / info.embeddedDpi) * 25.4;
    const dh = (info.height / info.embeddedDpi) * 25.4;
    const bw = r1(dw - bleedMm * 2), bh = r1(dh - bleedMm * 2);
    const mBleed = matchPreset(bw, bh);
    if (mBleed) {
      return {
        wMm: bw, hMm: bh, ...mBleed,
        sourceLabel: `画像サイズ (${info.embeddedDpi}dpi) − 塗り足し${bleedMm}mm×2 から算出`,
      };
    }
    const pw = r1(dw), ph = r1(dh);
    const mPlain = matchPreset(pw, ph);
    if (mPlain) {
      return {
        wMm: pw, hMm: ph, ...mPlain,
        sourceLabel: `画像サイズ (${info.embeddedDpi}dpi) から算出`,
      };
    }
    return {
      wMm: pw, hMm: ph, presetId: null, landscape: false,
      sourceLabel: `画像サイズ (${info.embeddedDpi}dpi) から算出 ※塗り足し込みの可能性あり`,
    };
  } catch {
    return null;
  }
}
