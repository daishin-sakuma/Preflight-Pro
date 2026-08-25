// Paper size presets (finished/trim size, mm) and print-shop criteria presets.

import type { Settings } from './types.ts';

export interface PaperPreset {
  id: string;
  label: string;
  wMm: number;
  hMm: number;
}

export const PAPER_PRESETS: PaperPreset[] = [
  { id: 'a3', label: 'A3 (297×420)', wMm: 297, hMm: 420 },
  { id: 'a4', label: 'A4 (210×297)', wMm: 210, hMm: 297 },
  { id: 'a5', label: 'A5 (148×210)', wMm: 148, hMm: 210 },
  { id: 'a6', label: 'A6 (105×148)', wMm: 105, hMm: 148 },
  { id: 'b4', label: 'B4 (257×364)', wMm: 257, hMm: 364 },
  { id: 'b5', label: 'B5 (182×257)', wMm: 182, hMm: 257 },
  { id: 'b6', label: 'B6 (128×182)', wMm: 128, hMm: 182 },
  { id: 'postcard', label: 'Postcard (100×148)', wMm: 100, hMm: 148 },
  { id: 'meishi', label: 'Business card JP (91×55)', wMm: 91, hMm: 55 },
  { id: 'card', label: 'Business card US (86×54)', wMm: 54, hMm: 86 },
  { id: 'l-flyer', label: 'A4 flyer, landscape (297×210)', wMm: 297, hMm: 210 },
  { id: 'custom', label: 'Custom…', wMm: 210, hMm: 297 },
];

export function paperSizeMm(
  paperId: string, customW: number, customH: number, landscape: boolean,
): { wMm: number; hMm: number } {
  const p = PAPER_PRESETS.find((q) => q.id === paperId) ?? PAPER_PRESETS[1];
  const w = paperId === 'custom' ? customW : p.wMm;
  const h = paperId === 'custom' ? customH : p.hMm;
  // Normalise to absolute orientation regardless of how the preset is defined:
  // portrait = tall (short × long), landscape = wide (long × short).
  const short = Math.min(w, h), long = Math.max(w, h);
  return landscape ? { wMm: long, hMm: short } : { wMm: short, hMm: long };
}

// Print-shop criteria presets: one pick fills bleed / ink limit / resolution /
// RGB policy at once. Values follow the guideline numbers commonly published
// for standard coated offset work — specs change, so the UI reminds the user
// to confirm against the shop's current guide.
export interface ShopPreset {
  id: string;
  label: string;
  apply: Partial<Settings>;
}

export const SHOP_PRESETS: ShopPreset[] = [
  { id: 'graphic', label: 'Graphic — 3mm / 350dpi / TAC 300%', apply: { bleedMm: 3, minDpi: 350, tacLimit: 300, requireCmyk: true } },
  { id: 'printpac', label: 'Printpac — 3mm / 350dpi / TAC 300%', apply: { bleedMm: 3, minDpi: 350, tacLimit: 300, requireCmyk: true } },
  { id: 'raksul', label: 'Raksul — 3mm / 350dpi / TAC 300%', apply: { bleedMm: 3, minDpi: 350, tacLimit: 300, requireCmyk: true } },
  { id: 'jp-uncoated', label: 'Uncoated stock — 3mm / 300dpi / TAC 250%', apply: { bleedMm: 3, minDpi: 300, tacLimit: 250, requireCmyk: true } },
  { id: 'large-format', label: 'Large format / signage — 10mm / 150dpi / TAC 280%', apply: { bleedMm: 10, minDpi: 150, tacLimit: 280, requireCmyk: false } },
];

export const TAC_CHOICES = [250, 260, 280, 300, 310, 320, 350];
export const DPI_CHOICES = [72, 100, 150, 200, 250, 300, 350, 400, 600];
// Design scale factor: real size = file size × factor (1 = 1:1). Common reduced
// scales for large-format work (signage, banners, exhibition booths).
export const SCALE_CHOICES = [1, 2, 5, 10, 20, 50, 100];
