// Approximate total-ink-coverage (TAC) analysis from a rendered RGB canvas.
// Uses a naive RGB→CMYK separation (no ICC), so values are indicative — exact
// TAC for vector fills comes from raw CMYK operators (contentInterp). Raster
// CMYK images cannot be recovered exactly after RGB rendering; results are
// labeled 参考値 in the UI.

import type { TacResult } from './types.ts';

export function analyzeTac(
  canvas: HTMLCanvasElement,
  page: number,
  limit: number,
): TacResult {
  const ctx = canvas.getContext('2d', { willReadFrequently: true })!;
  const { width, height } = canvas;
  const img = ctx.getImageData(0, 0, width, height);
  const d = img.data;

  const heat = new ImageData(width, height);
  const h = heat.data;

  let maxTac = 0;
  let inkPixels = 0;
  let overPixels = 0;

  for (let i = 0; i < d.length; i += 4) {
    const r = d[i] / 255, g = d[i + 1] / 255, b = d[i + 2] / 255;
    const k = 1 - Math.max(r, g, b);
    let tac: number;
    if (k >= 0.999) {
      tac = 100;
    } else {
      const c = (1 - r - k) / (1 - k);
      const m = (1 - g - k) / (1 - k);
      const y = (1 - b - k) / (1 - k);
      tac = (c + m + y + k) * 100;
    }
    if (tac > 1) inkPixels++;
    if (tac > maxTac) maxTac = tac;
    if (tac > limit) {
      overPixels++;
      h[i] = 255; h[i + 1] = 40; h[i + 2] = 40; h[i + 3] = 190;
    }
  }

  return {
    page,
    maxTac: Math.round(maxTac),
    overLimitRatio: inkPixels ? overPixels / inkPixels : 0,
    heat: overPixels > 0 ? heat : undefined,
  };
}
