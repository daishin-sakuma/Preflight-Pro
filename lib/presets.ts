// Paper size presets (finished/trim size, mm).

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
  let w = paperId === 'custom' ? customW : p.wMm;
  let h = paperId === 'custom' ? customH : p.hMm;
  if (landscape) [w, h] = [h, w];
  return { wMm: w, hMm: h };
}

export const TAC_CHOICES = [250, 260, 280, 300, 310, 320, 350];
export const DPI_CHOICES = [72, 100, 150, 200, 250, 300, 350, 400, 600];
