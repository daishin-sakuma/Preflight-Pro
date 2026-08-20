// Shared types for the preflight engine.

export type Severity = 'ok' | 'info' | 'warning' | 'error';

export interface Finding {
  id: string;            // stable key, e.g. 'rgb-object'
  category: CategoryId;
  severity: Severity;
  title: string;         // short Japanese label
  detail: string;        // explanation + how to fix
  pages?: number[];      // 1-based page numbers involved
  count?: number;        // occurrences
  markerKind?: MarkerKind; // set when the spots are locatable on the 2D preview
}

// A locatable problem spot on a page (PDF coords, origin bottom-left, pt).
export type MarkerKind =
  | 'rgb' | 'white-op' | 'tac' | 'rich-black' | 'hairline' | 'font' | 'overprint'
  | 'lowres' | 'four-color' | 'three-color' | 'spot';

export interface Marker {
  kind: MarkerKind;
  page: number;          // 1-based (best effort inside form XObjects)
  rectPt: { x: number; y: number; w: number; h: number };
  label?: string;        // chip text, e.g. '380%'
  point?: boolean;       // approximate point (text position) rather than exact bounds
}

export type CategoryId =
  | 'color'       // color mode
  | 'ink'         // ink, solids, overprint
  | 'bleed'       // bleed & finished size
  | 'resolution'  // image resolution
  | 'font'        // fonts
  | 'other';      // other (transparency, annotations, version, etc.)

export const CATEGORY_LABELS: Record<CategoryId, string> = {
  color: 'Color mode',
  ink: 'Ink & overprint',
  bleed: 'Bleed & trim size',
  resolution: 'Image resolution',
  font: 'Fonts',
  other: 'Other',
};

export const CATEGORY_ORDER: CategoryId[] = [
  'bleed', 'color', 'ink', 'resolution', 'font', 'other',
];

// ---- Analysis raw results -------------------------------------------------

export interface PlacedImage {
  page: number;
  pxWidth: number;
  pxHeight: number;
  printWidthMm: number;   // placed size on paper
  printHeightMm: number;
  effectiveDpi: number;
  rectPt?: { x: number; y: number; w: number; h: number }; // page coords (pt, PDF origin bottom-left)
}

export interface CmykUsage {
  c: number; m: number; y: number; k: number; // 0..1
  tac: number;        // percent 0..400
  inText: boolean;
  page: number;
  isFill: boolean;
  rectPt?: { x: number; y: number; w: number; h: number }; // first drawn location
}

export interface PageGeom {
  page: number;
  viewBoxPt?: [number, number, number, number]; // pdf.js render basis (crop)
  mediaBoxPt: [number, number, number, number];
  trimBoxPt?: [number, number, number, number];
  bleedBoxPt?: [number, number, number, number];
  cropBoxPt?: [number, number, number, number];
  artBoxPt?: [number, number, number, number];
  widthPt: number;   // effective page width (crop/media)
  heightPt: number;
}

export interface PdfScan {
  pdfVersion: string | null;
  encrypted: boolean;
  hasDeviceRGB: boolean;
  hasCalRGB: boolean;
  hasDeviceCMYK: boolean;
  hasICCBased: boolean;
  iccRgbLikely: boolean;
  iccCmykLikely: boolean;
  separationNames: string[];       // spot colors (excluding All/None)
  usesRegistrationAll: boolean;    // /Separation /All
  overprintTrue: boolean;          // any /OP true, /op true or /OPM 1
  transparencyUsed: boolean;       // /SMask non-None or /S /Transparency group or CA/ca < 1
  hasAnnotsOrForms: boolean;
  hasLayers: boolean;              // OCG
  fontsTotal: number;
  fontsNotEmbedded: string[];      // BaseFont names lacking FontFile
  outputIntent: string | null;     // e.g. GTS_PDFX subtype or ICC name
  pdfxVersion: string | null;      // e.g. PDF/X-1a:2001
}

export interface ContentStats {
  rgbOps: number;                  // rg/RG operator count
  grayOps: number;
  cmykFills: CmykUsage[];          // unique-ish CMYK colors used (fills & strokes)
  richBlackText: CmykUsage[];      // >=3ch heavy in text
  overTacColors: CmykUsage[];      // filled colors exceeding limit (set later by checks)
  whiteFillWithGs: number;         // white fills drawn while an ExtGState is active (potential white overprint)
  minLineWidthPt: number | null;   // thinnest stroke width seen (pt, approx)
  hairlineCount: number;
  markers: Marker[];               // locatable spots (rgb / white-op / rich-black / hairline)
}

export interface TacResult {
  page: number;
  maxTac: number;         // percent (approx, from rendered RGB)
  overLimitRatio: number; // 0..1 fraction of ink-bearing pixels above limit
  heat?: ImageData;       // red overlay mask at render size
}

export interface ImageFileInfo {
  format: 'png' | 'jpeg';
  width: number;
  height: number;
  colorSpace: 'rgb' | 'cmyk' | 'gray' | 'palette' | 'unknown';
  hasAlpha: boolean;
  embeddedDpi: number | null;
  hasIccProfile: boolean;
  iccName?: string | null;
}

export interface AnalysisResult {
  kind: 'pdf' | 'image';
  fileName: string;
  fileSize: number;
  pageCount: number;
  pages: PageGeom[];
  scan?: PdfScan;
  content?: ContentStats;
  images: PlacedImage[];
  tac: TacResult[];
  imageInfo?: ImageFileInfo;
  previews: HTMLCanvasElement[];   // rendered page previews (index = page-1)
  renderScale: number;             // px per pt of previews
  // true finished size from the Illustrator artboard (XMP), used when the PDF
  // page was clamped to the 14400pt (5080mm) ceiling for large-format files
  aiArtboardMm?: { wMm: number; hMm: number };
  findings: Finding[];
  notes: string[];                 // non-blocking analysis notes
  markers: Marker[];               // all locatable problem spots (2D preview)
  // re-render a page at an arbitrary scale (px per pt) for crisp deep zoom (PDF only)
  renderPage?: (pageIdx: number, scale: number) => Promise<HTMLCanvasElement | null>;
  dispose?: () => void;            // release the retained pdf.js document
}

// ---- Settings --------------------------------------------------------------

export interface Settings {
  paperId: string;          // preset id or 'custom'
  customWmm: number;
  customHmm: number;
  landscape: boolean;
  bleedMm: number;          // required bleed (usually 3)
  tacLimit: number;         // 250..350
  minDpi: number;           // e.g. 300 / 350
  safeMarginMm: number;     // text-safe area inside trim (usually 3)
  requireCmyk: boolean;     // treat RGB as error (true) or warning (false)
  scale: number;            // design scale factor: real size = file size × scale
                            // (1 = 1:1 full size, 10 = drawn at 1:10, etc.)
}

export const DEFAULT_SETTINGS: Settings = {
  paperId: 'a4',
  customWmm: 210,
  customHmm: 297,
  landscape: false,
  bleedMm: 3,
  tacLimit: 300,
  minDpi: 300,
  safeMarginMm: 3,
  requireCmyk: true,
  scale: 1,
};

export const MM_PER_PT = 25.4 / 72;
export const PT_PER_MM = 72 / 25.4;
