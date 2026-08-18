// Byte-level PDF scanner.
// Inflates every FlateDecode stream (incl. object streams) and regex-scans the
// combined text corpus for preflight-relevant features that pdf.js does not
// expose (raw color operators live in content streams; TrimBox etc. live in
// page dicts that may sit inside compressed object streams).

import pako from 'pako';
import type { PdfScan } from '../types.ts';

const td = new TextDecoder('latin1');

export interface CsInfo { kind: 'cmyk' | 'rgb' | 'gray' | 'sep' | 'other' }

export interface RawScanResult {
  scan: PdfScan;
  // decoded text of likely content streams, with best-effort page attribution
  // (via the owning object number matched against page /Contents refs)
  contentStreams: { text: string; page: number }[];
  corpus: string;             // raw text + all inflated stream text
  csNames: Record<string, CsInfo>; // colorspace resource name (e.g. CS0) -> kind
  gradientCmyk: { c: number; m: number; y: number; k: number }[]; // Type-2 fn stops
  // font resource name (e.g. F1, C2_0) -> embedded? (resolved via descriptor chain)
  fontNames: Record<string, { embedded: boolean; baseFont: string | null }>;
  // ExtGState resource name (e.g. GS0) -> does it switch overprint ON?
  gsNames: Record<string, { overprint: boolean }>;
  boxes: {
    media: number[][]; trim: number[][]; bleed: number[][];
    crop: number[][]; art: number[][];
  };
}

function printableRatio(s: string): number {
  if (!s.length) return 0;
  let p = 0;
  const n = Math.min(s.length, 2000);
  for (let i = 0; i < n; i++) {
    const c = s.charCodeAt(i);
    if (c === 9 || c === 10 || c === 13 || (c >= 32 && c < 127)) p++;
  }
  return p / n;
}

const CONTENT_RE = /(^|[\s>])(q|Q|BT|ET|re|cm|Do|Tj|TJ|gs|scn?|k|K|rg|RG|w)(\s|$)/;

function parseBoxes(corpus: string, key: string): number[][] {
  const out: number[][] = [];
  const re = new RegExp(`/${key}\\s*\\[\\s*([-\\d.]+)\\s+([-\\d.]+)\\s+([-\\d.]+)\\s+([-\\d.]+)\\s*\\]`, 'g');
  let m: RegExpExecArray | null;
  while ((m = re.exec(corpus)) !== null) {
    out.push([+m[1], +m[2], +m[3], +m[4]]);
  }
  return out;
}

export function rawScanPdf(bytes: Uint8Array): RawScanResult {
  const raw = td.decode(bytes);
  const inflatedParts: string[] = [];
  const rawStreams: { text: string; objNum: number }[] = [];

  // Walk every stream ... endstream span.
  let idx = 0;
  while (true) {
    const s = raw.indexOf('stream', idx);
    if (s === -1) break;
    // stream keyword must be followed by EOL
    let dataStart = s + 6;
    if (raw[dataStart] === '\r') dataStart++;
    if (raw[dataStart] === '\n') dataStart++;
    const e = raw.indexOf('endstream', dataStart);
    if (e === -1) break;
    idx = e + 9;
    // owning object number: nearest `N 0 obj` before the stream keyword
    let objNum = 0;
    {
      const win = raw.slice(Math.max(0, s - 400), s);
      const ms = [...win.matchAll(/(\d+)\s+\d+\s+obj\b/g)];
      if (ms.length) objNum = +ms[ms.length - 1][1];
    }
    // trim the EOL between stream data and `endstream` (pako rejects trailing bytes)
    let dataEnd = e;
    while (dataEnd > dataStart && '\r\n \t'.includes(raw[dataEnd - 1])) dataEnd--;
    const span = bytes.subarray(dataStart, dataEnd);
    let text: string | null = null;
    try {
      const out = pako.inflate(span);
      text = td.decode(out);
    } catch {
      // not Flate (or other filter) — treat raw span as text if it looks textual
      const t = td.decode(span);
      if (printableRatio(t) > 0.85) text = t;
    }
    if (text && printableRatio(text) > 0.7) {
      inflatedParts.push(text);
      if (CONTENT_RE.test(text.slice(0, 4000)) || CONTENT_RE.test(text)) {
        rawStreams.push({ text, objNum });
      }
    }
  }

  const corpus = raw + '\n' + inflatedParts.join('\n');

  // ---- page attribution: /Contents refs in page-dict order -> obj -> page ----
  const objToPage = new Map<number, number>();
  {
    let pageNo = 0;
    const re = /\/Type\s*\/Page\b(?!s)/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(corpus)) !== null) {
      pageNo++;
      const win = corpus.slice(m.index, m.index + 900);
      const single = win.match(/\/Contents\s+(\d+)\s+\d+\s+R/);
      if (single) {
        if (!objToPage.has(+single[1])) objToPage.set(+single[1], pageNo);
        continue;
      }
      const arr = win.match(/\/Contents\s*\[([^\]]*)\]/);
      if (arr) {
        for (const r of arr[1].matchAll(/(\d+)\s+\d+\s+R/g)) {
          if (!objToPage.has(+r[1])) objToPage.set(+r[1], pageNo);
        }
      }
    }
  }
  const contentStreams = rawStreams.map((s) => ({
    text: s.text,
    page: objToPage.get(s.objNum) ?? 1,
  }));

  // ---- object map (top-level `N 0 obj ... endobj`, incl. inflated ObjStm-less
  // bodies present in corpus) for resolving indirect colorspace references ----
  const objMap = new Map<number, string>();
  {
    const re = /(\d+)\s+0\s+obj\b/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(corpus)) !== null) {
      const start = m.index + m[0].length;
      const end = corpus.indexOf('endobj', start);
      if (end === -1 || objMap.has(+m[1])) continue;
      // keep only the head — enough for the dict (/N etc.); large stream
      // bodies (ICC profiles etc.) would bloat memory and aren't needed
      objMap.set(+m[1], corpus.slice(start, Math.min(end, start + 2500)));
    }
  }

  const classifyCs = (body: string, depth = 0): CsInfo => {
    if (/\/DeviceCMYK/.test(body)) return { kind: 'cmyk' };
    if (/\/DeviceRGB|\/CalRGB/.test(body)) return { kind: 'rgb' };
    if (/\/DeviceGray|\/CalGray/.test(body)) return { kind: 'gray' };
    if (/\/Separation|\/DeviceN/.test(body)) return { kind: 'sep' };
    const icc = body.match(/\/ICCBased\s+(\d+)\s+\d+\s+R/);
    if (icc && depth < 3) {
      const t = objMap.get(+icc[1]) ?? '';
      const n = t.match(/\/N\s+(\d)/);
      if (n) return { kind: n[1] === '4' ? 'cmyk' : n[1] === '3' ? 'rgb' : 'gray' };
    }
    const ref = body.match(/^\s*(\d+)\s+\d+\s+R\s*$/);
    if (ref && depth < 3) return classifyCs(objMap.get(+ref[1]) ?? '', depth + 1);
    return { kind: 'other' };
  };

  // colorspace resource names: /CS0 12 0 R (indirect) or /CS0 [/ICCBased 5 0 R]
  const csNames: Record<string, CsInfo> = {};
  let iccCmyk = false, iccRgb = false;
  {
    const re = /\/([A-Za-z][\w]{0,24})\s+(\d+)\s+\d+\s+R/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(corpus)) !== null) {
      const body = objMap.get(+m[2]);
      if (!body) continue;
      if (/\/ICCBased|\/Separation|\/DeviceN|\/Device(?:CMYK|RGB|Gray)|\/CalRGB|\/Indexed/.test(body)) {
        const info = classifyCs(body);
        if (info.kind !== 'other') csNames[m[1]] = info;
        if (info.kind === 'cmyk' && /\/ICCBased/.test(body)) iccCmyk = true;
        if (info.kind === 'rgb' && /\/ICCBased/.test(body)) iccRgb = true;
      }
    }
    const inline = /\/([A-Za-z][\w]{0,24})\s*\[\s*\/ICCBased\s+(\d+)\s+\d+\s+R\s*\]/g;
    while ((m = inline.exec(corpus)) !== null) {
      const n = (objMap.get(+m[2]) ?? '').match(/\/N\s+(\d)/);
      if (n) {
        const kind = n[1] === '4' ? 'cmyk' : n[1] === '3' ? 'rgb' : 'gray';
        csNames[m[1]] = { kind };
        if (kind === 'cmyk') iccCmyk = true;
        if (kind === 'rgb') iccRgb = true;
      }
    }
  }

  // gradient (shading) endpoint colors from Type-2 functions with 4 components
  const gradientCmyk: { c: number; m: number; y: number; k: number }[] = [];
  {
    const re = /\/C[01]\s*\[\s*([\d.]+)\s+([\d.]+)\s+([\d.]+)\s+([\d.]+)\s*\]/g;
    let m: RegExpExecArray | null;
    const seen = new Set<string>();
    while ((m = re.exec(corpus)) !== null) {
      const key = m.slice(1, 5).join(',');
      if (seen.has(key)) continue;
      seen.add(key);
      gradientCmyk.push({ c: +m[1], m: +m[2], y: +m[3], k: +m[4] });
    }
  }

  // ---- feature detection ----
  const has = (re: RegExp) => re.test(corpus);

  const sepNames = new Set<string>();
  let usesRegistrationAll = false;
  {
    const re = /\/Separation\s*\/([^\s/\]<>()]+)/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(corpus)) !== null) {
      const name = decodeURIComponent(m[1].replace(/#([0-9a-fA-F]{2})/g, '%$1'));
      if (name === 'All') usesRegistrationAll = true;
      else if (name !== 'None') sepNames.add(name);
    }
    // DeviceN can also carry spot names — record presence generically
    if (/\/DeviceN\s*\[/.test(corpus)) {
      const dn = /\/DeviceN\s*\[((?:\s*\/[^\s/\]]+)+)\s*\]/g;
      while ((m = dn.exec(corpus)) !== null) {
        for (const nm of m[1].match(/\/[^\s/\]]+/g) ?? []) {
          const n = nm.slice(1);
          if (!['Cyan', 'Magenta', 'Yellow', 'Black', 'None', 'All'].includes(n)) sepNames.add(n);
        }
      }
    }
  }

  // Fonts (1): FontName + nearby FontFile within same descriptor dict (heuristic).
  const fontsNotEmbedded: string[] = [];
  let fontsTotal = 0;
  {
    const fn = /\/FontName\s*\/([^\s/\]<>()]+)/g;
    let m: RegExpExecArray | null;
    const seen = new Set<string>();
    while ((m = fn.exec(corpus)) !== null) {
      const name = m[1].replace(/^[A-Z]{6}\+/, ''); // strip subset prefix
      if (seen.has(name)) continue;
      seen.add(name);
      fontsTotal++;
      const window = corpus.slice(m.index, m.index + 1200);
      if (!/\/FontFile[23]?[\s/]/.test(window)) fontsNotEmbedded.push(name);
    }
  }

  // Fonts (2): resolve font RESOURCE names (/F1 etc.) through the object graph
  // so text-show locations can be attributed to non-embedded fonts. Also catches
  // standard-14 fonts (no descriptor at all = not embedded).
  const fontNames: Record<string, { embedded: boolean; baseFont: string | null }> = {};
  {
    const resolveFont = (body: string, depth = 0): { embedded: boolean; baseFont: string | null } | null => {
      if (depth > 3 || !/\/Type\s*\/Font|\/BaseFont/.test(body)) return null;
      const bf = body.match(/\/BaseFont\s*\/([^\s/\]<>()]+)/);
      const baseFont = bf ? bf[1].replace(/^[A-Z]{6}\+/, '') : null;
      const fd = body.match(/\/FontDescriptor\s+(\d+)\s+\d+\s+R/);
      if (fd) {
        const d = objMap.get(+fd[1]) ?? '';
        return { embedded: /\/FontFile[23]?[\s/]/.test(d), baseFont };
      }
      const df = body.match(/\/DescendantFonts\s*\[?\s*(\d+)\s+\d+\s+R/);
      if (df) {
        const child = resolveFont(objMap.get(+df[1]) ?? '', depth + 1);
        if (child) return { embedded: child.embedded, baseFont: baseFont ?? child.baseFont };
      }
      // no descriptor (standard-14 etc.) and no embedded file in the dict itself
      return { embedded: /\/FontFile[23]?[\s/]/.test(body), baseFont };
    };
    const re = /\/([A-Za-z][\w]{0,40})\s+(\d+)\s+\d+\s+R/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(corpus)) !== null) {
      if (fontNames[m[1]]) continue;
      const body = objMap.get(+m[2]);
      if (!body || !/\/Type\s*\/Font/.test(body)) continue;
      const r = resolveFont(body);
      if (r) fontNames[m[1]] = r;
    }
    // merge into the not-embedded list (unique base names)
    for (const f of Object.values(fontNames)) {
      if (!f.embedded) {
        const name = f.baseFont ?? '(unnamed font)';
        if (!fontsNotEmbedded.includes(name)) fontsNotEmbedded.push(name);
      }
    }
    fontsTotal = Math.max(fontsTotal, Object.keys(fontNames).length);
  }

  // ExtGState resource names -> overprint on/off (so `gs` ops in content can be
  // located; also makes white-overprint detection precise).
  const gsNames: Record<string, { overprint: boolean }> = {};
  {
    const re = /\/([A-Za-z][\w]{0,40})\s+(\d+)\s+\d+\s+R/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(corpus)) !== null) {
      if (gsNames[m[1]] !== undefined) continue;
      const body = objMap.get(+m[2]);
      if (!body) continue;
      if (/\/Type\s*\/ExtGState/.test(body) || /\/(?:OP|op)\s+(?:true|false)/.test(body)) {
        gsNames[m[1]] = { overprint: /\/(?:OP|op)\s+true/.test(body) };
      }
    }
    // inline dicts: /GS0 << /Type /ExtGState /OP true ... >>
    const inline = /\/([A-Za-z][\w]{0,40})\s*<<([^<>]{0,400})>>/g;
    while ((m = inline.exec(corpus)) !== null) {
      if (gsNames[m[1]] !== undefined) continue;
      if (/\/Type\s*\/ExtGState/.test(m[2]) || /\/(?:OP|op)\s+(?:true|false)/.test(m[2])) {
        gsNames[m[1]] = { overprint: /\/(?:OP|op)\s+true/.test(m[2]) };
      }
    }
  }

  // PDF/X output intent
  let pdfxVersion: string | null = null;
  let outputIntent: string | null = null;
  {
    const gx = corpus.match(/\/GTS_PDFXVersion\s*\(([^)]*)\)/);
    if (gx) pdfxVersion = gx[1];
    const oi = corpus.match(/\/OutputConditionIdentifier\s*\(([^)]*)\)/);
    if (oi) outputIntent = oi[1];
  }

  const header = raw.slice(0, 32).match(/%PDF-(\d\.\d)/);

  // Transparency: soft masks, transparency groups, or constant alpha < 1
  let transparencyUsed =
    /\/SMask\s+\d+\s+\d+\s+R/.test(corpus) ||
    /\/S\s*\/Transparency/.test(corpus);
  if (!transparencyUsed) {
    const caRe = /\/(?:CA|ca)\s+([\d.]+)/g;
    let m: RegExpExecArray | null;
    while ((m = caRe.exec(corpus)) !== null) {
      if (parseFloat(m[1]) < 1) { transparencyUsed = true; break; }
    }
  }

  const scan: PdfScan = {
    pdfVersion: header ? header[1] : null,
    encrypted: /\/Encrypt\s+\d+\s+\d+\s+R/.test(raw),
    hasDeviceRGB: has(/\/DeviceRGB/),
    hasCalRGB: has(/\/CalRGB/),
    hasDeviceCMYK: has(/\/DeviceCMYK/),
    hasICCBased: has(/\/ICCBased/),
    iccRgbLikely: iccRgb || /\/Alternate\s*\/DeviceRGB/.test(corpus),
    iccCmykLikely: iccCmyk || /\/Alternate\s*\/DeviceCMYK/.test(corpus),
    separationNames: [...sepNames],
    usesRegistrationAll,
    // /OPM 1 alone (Illustrator default) does NOT overprint — require OP/op true.
    overprintTrue: /\/(?:OP|op)\s+true/.test(corpus),
    transparencyUsed,
    hasAnnotsOrForms:
      /\/Subtype\s*\/(?:Widget|FreeText|Square|Circle|Line|Ink|Stamp|Highlight|Underline|StrikeOut|Squiggly)/.test(corpus) ||
      /\/AcroForm/.test(raw),
    hasLayers: /\/OCGs?[\s\[]/.test(corpus) || /\/Type\s*\/OCG/.test(corpus),
    fontsTotal,
    fontsNotEmbedded,
    outputIntent,
    pdfxVersion,
  };

  return {
    scan,
    contentStreams,
    corpus,
    csNames,
    gradientCmyk,
    fontNames,
    gsNames,
    boxes: {
      media: parseBoxes(corpus, 'MediaBox'),
      trim: parseBoxes(corpus, 'TrimBox'),
      bleed: parseBoxes(corpus, 'BleedBox'),
      crop: parseBoxes(corpus, 'CropBox'),
      art: parseBoxes(corpus, 'ArtBox'),
    },
  };
}
