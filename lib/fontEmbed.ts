// Runtime TrueType subsetting for CID-keyed PDF font embedding.
//
// Parses a TTF (glyf outlines), maps code points → glyphs via cmap (format 4 /
// 12), and builds a minimal subset font containing exactly the glyphs a report
// used. Glyphs are renumbered in usage order, so the 2-byte strings written to
// the content stream (Identity-H: CID = GID) match the subset directly
// (/CIDToGIDMap /Identity). Composite-glyph components are pulled into the
// subset transitively and their component indices rewritten.
//
// The subset keeps only the tables a PDF viewer needs for a CIDFontType2:
// glyf / loca / head / hhea / hmtx / maxp (+ cvt, fpgm, prep, gasp if present).
// No cmap is required — Identity-H addresses glyphs directly.

export interface CidFontData {
  psName: string;            // subset-prefixed PostScript name, e.g. PFPROA+ZenKakuGothicNew-Regular
  fontFile: Uint8Array;      // subset TTF (uncompressed; deflated by the PDF writer)
  w: string;                 // body of the /W widths array (1000-unit space)
  toUnicode: Uint8Array;     // ToUnicode CMap stream (for text extraction / search)
  ascent: number;            // 1000-unit space
  descent: number;
  capHeight: number;
  bbox: [number, number, number, number];
}

interface TableSpan { off: number; len: number }

class Ttf {
  readonly dv: DataView;
  readonly tables = new Map<string, TableSpan>();
  upm = 1000;
  indexToLocFormat = 0;
  numGlyphs = 0;
  numberOfHMetrics = 0;
  ascender = 800;
  descender = -200;
  capHeight = 720;
  bbox: [number, number, number, number] = [0, -200, 1000, 800];
  private cmapOff = 0;
  private cmapFormat = 0;

  constructor(readonly bytes: Uint8Array) {
    this.dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  }

  static parse(buf: ArrayBuffer): Ttf | null {
    const f = new Ttf(new Uint8Array(buf));
    const dv = f.dv;
    const version = dv.getUint32(0);
    if (version !== 0x00010000 && version !== 0x74727565) return null; // needs glyf outlines (no CFF)
    const numTables = dv.getUint16(4);
    for (let i = 0; i < numTables; i++) {
      const base = 12 + i * 16;
      const tag = String.fromCharCode(
        f.bytes[base], f.bytes[base + 1], f.bytes[base + 2], f.bytes[base + 3],
      );
      f.tables.set(tag, { off: dv.getUint32(base + 8), len: dv.getUint32(base + 12) });
    }
    for (const req of ['head', 'hhea', 'hmtx', 'maxp', 'loca', 'glyf', 'cmap']) {
      if (!f.tables.has(req)) return null;
    }
    const head = f.tables.get('head')!.off;
    f.upm = dv.getUint16(head + 18);
    f.indexToLocFormat = dv.getInt16(head + 50);
    f.bbox = [
      dv.getInt16(head + 36), dv.getInt16(head + 38),
      dv.getInt16(head + 40), dv.getInt16(head + 42),
    ];
    const hhea = f.tables.get('hhea')!.off;
    f.ascender = dv.getInt16(hhea + 4);
    f.descender = dv.getInt16(hhea + 6);
    f.numberOfHMetrics = dv.getUint16(hhea + 34);
    f.numGlyphs = dv.getUint16(f.tables.get('maxp')!.off + 4);
    const os2 = f.tables.get('OS/2');
    if (os2 && os2.len >= 90 && dv.getUint16(os2.off) >= 2) {
      const ch = dv.getInt16(os2.off + 88);
      if (ch > 0) f.capHeight = ch;
    }
    if (!f.pickCmap()) return null;
    return f;
  }

  // choose the best unicode cmap subtable: format 12 (full) > format 4 (BMP)
  private pickCmap(): boolean {
    const { off } = this.tables.get('cmap')!;
    const n = this.dv.getUint16(off + 2);
    let best = 0, bestFmt = 0;
    for (let i = 0; i < n; i++) {
      const rec = off + 4 + i * 8;
      const platform = this.dv.getUint16(rec);
      const encoding = this.dv.getUint16(rec + 2);
      const sub = off + this.dv.getUint32(rec + 4);
      const fmt = this.dv.getUint16(sub);
      const unicode = (platform === 3 && (encoding === 1 || encoding === 10)) || platform === 0;
      if (!unicode) continue;
      if (fmt === 12 && bestFmt !== 12) { best = sub; bestFmt = 12; }
      else if (fmt === 4 && bestFmt === 0) { best = sub; bestFmt = 4; }
    }
    this.cmapOff = best;
    this.cmapFormat = bestFmt;
    return bestFmt !== 0;
  }

  lookup(cp: number): number {
    const dv = this.dv, off = this.cmapOff;
    if (this.cmapFormat === 12) {
      const nGroups = dv.getUint32(off + 12);
      let lo = 0, hi = nGroups - 1;
      while (lo <= hi) {
        const mid = (lo + hi) >> 1;
        const g = off + 16 + mid * 12;
        const start = dv.getUint32(g), end = dv.getUint32(g + 4);
        if (cp < start) hi = mid - 1;
        else if (cp > end) lo = mid + 1;
        else return dv.getUint32(g + 8) + (cp - start);
      }
      return 0;
    }
    // format 4 (BMP only)
    if (cp > 0xffff) return 0;
    const segCountX2 = dv.getUint16(off + 6);
    const segCount = segCountX2 >> 1;
    const endBase = off + 14;
    const startBase = endBase + segCountX2 + 2;
    const deltaBase = startBase + segCountX2;
    const rangeBase = deltaBase + segCountX2;
    let lo = 0, hi = segCount - 1, seg = -1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if (dv.getUint16(endBase + mid * 2) >= cp) { seg = mid; hi = mid - 1; }
      else lo = mid + 1;
    }
    if (seg < 0 || dv.getUint16(startBase + seg * 2) > cp) return 0;
    const delta = dv.getInt16(deltaBase + seg * 2);
    const ro = dv.getUint16(rangeBase + seg * 2);
    if (ro === 0) return (cp + delta) & 0xffff;
    const addr = rangeBase + seg * 2 + ro + (cp - dv.getUint16(startBase + seg * 2)) * 2;
    const g = dv.getUint16(addr);
    return g === 0 ? 0 : (g + delta) & 0xffff;
  }

  glyphSpan(gid: number): [number, number] {
    const loca = this.tables.get('loca')!.off;
    const glyf = this.tables.get('glyf')!.off;
    if (this.indexToLocFormat === 1) {
      return [glyf + this.dv.getUint32(loca + gid * 4), glyf + this.dv.getUint32(loca + gid * 4 + 4)];
    }
    return [glyf + this.dv.getUint16(loca + gid * 2) * 2, glyf + this.dv.getUint16(loca + gid * 2 + 2) * 2];
  }

  advance(gid: number): number {
    const hmtx = this.tables.get('hmtx')!.off;
    const n = this.numberOfHMetrics;
    return this.dv.getUint16(hmtx + Math.min(gid, n - 1) * 4);
  }

  lsb(gid: number): number {
    const hmtx = this.tables.get('hmtx')!.off;
    const n = this.numberOfHMetrics;
    if (gid < n) return this.dv.getInt16(hmtx + gid * 4 + 2);
    return this.dv.getInt16(hmtx + n * 4 + (gid - n) * 2);
  }

  tableBytes(tag: string): Uint8Array | null {
    const t = this.tables.get(tag);
    return t ? this.bytes.slice(t.off, t.off + t.len) : null;
  }
}

// ---- subset assembly helpers ----

const pad4 = (n: number) => (n + 3) & ~3;

const tableChecksum = (b: Uint8Array): number => {
  let s = 0;
  for (let i = 0; i < b.length; i += 4) {
    s = (s + (((b[i] << 24) | ((b[i + 1] ?? 0) << 16) | ((b[i + 2] ?? 0) << 8) | (b[i + 3] ?? 0)) >>> 0)) >>> 0;
  }
  return s;
};

// rewrite composite-glyph component indices to subset GIDs
function remapGlyph(data: Uint8Array, map: Map<number, number>): Uint8Array {
  if (data.length < 10) return data;
  const dv = new DataView(data.buffer, data.byteOffset, data.byteLength);
  if (dv.getInt16(0) >= 0) return data; // simple glyph
  const out = data.slice();
  const odv = new DataView(out.buffer);
  let off = 10;
  for (;;) {
    const flags = odv.getUint16(off);
    const gi = odv.getUint16(off + 2);
    odv.setUint16(off + 2, map.get(gi) ?? 0);
    off += 4;
    off += (flags & 0x0001) ? 4 : 2;       // ARG_1_AND_2_ARE_WORDS
    if (flags & 0x0008) off += 2;          // WE_HAVE_A_SCALE
    else if (flags & 0x0040) off += 4;     // X_AND_Y_SCALE
    else if (flags & 0x0080) off += 8;     // TWO_BY_TWO
    if (!(flags & 0x0020)) break;          // MORE_COMPONENTS
  }
  return out;
}

// component GIDs of a composite glyph (empty for simple glyphs)
function componentGids(font: Ttf, gid: number): number[] {
  const [s, e] = font.glyphSpan(gid);
  if (e - s < 10 || font.dv.getInt16(s) >= 0) return [];
  const out: number[] = [];
  let off = s + 10;
  for (;;) {
    const flags = font.dv.getUint16(off);
    out.push(font.dv.getUint16(off + 2));
    off += 4;
    off += (flags & 0x0001) ? 4 : 2;
    if (flags & 0x0008) off += 2;
    else if (flags & 0x0040) off += 4;
    else if (flags & 0x0080) off += 8;
    if (!(flags & 0x0020)) break;
  }
  return out;
}

const cpToUtf16BeHex = (cp: number): string => {
  if (cp <= 0xffff) return cp.toString(16).padStart(4, '0');
  const v = cp - 0x10000;
  const hi = 0xd800 + (v >> 10), lo = 0xdc00 + (v & 0x3ff);
  return hi.toString(16).padStart(4, '0') + lo.toString(16).padStart(4, '0');
};

// ---- public API -------------------------------------------------------------

export class SubsetFont {
  private oldToNew = new Map<number, number>([[0, 0]]);
  private newToOld: number[] = [0];              // index = subset GID
  private newToCp = new Map<number, number>();   // for ToUnicode

  private constructor(private font: Ttf) {}

  static parse(buf: ArrayBuffer): SubsetFont | null {
    const font = Ttf.parse(buf);
    return font ? new SubsetFont(font) : null;
  }

  get used(): boolean { return this.newToOld.length > 1; }

  // text → 2-byte subset-GID string; null when any glyph is missing
  encode(text: string): Uint8Array | null {
    const gids: number[] = [];
    for (const ch of text) {
      const cp = ch.codePointAt(0)!;
      const old = this.font.lookup(cp);
      if (old === 0) return null;
      let nw = this.oldToNew.get(old);
      if (nw === undefined) {
        nw = this.newToOld.length;
        this.oldToNew.set(old, nw);
        this.newToOld.push(old);
      }
      if (!this.newToCp.has(nw)) this.newToCp.set(nw, cp);
      gids.push(nw);
    }
    const out = new Uint8Array(gids.length * 2);
    gids.forEach((g, i) => { out[i * 2] = g >> 8; out[i * 2 + 1] = g & 0xff; });
    return out;
  }

  // can every character of the text be typeset with this font?
  covers(text: string): boolean {
    for (const ch of text) {
      if (this.font.lookup(ch.codePointAt(0)!) === 0) return false;
    }
    return true;
  }

  // text width in layout units at the given size; null when a glyph is missing
  measure(text: string, size: number): number | null {
    let units = 0;
    for (const ch of text) {
      const gid = this.font.lookup(ch.codePointAt(0)!);
      if (gid === 0) return null;
      units += this.font.advance(gid);
    }
    return (units * size) / this.font.upm;
  }

  build(psName: string): CidFontData {
    const font = this.font;
    // transitively pull composite components into the subset (they get GIDs
    // after all text-referenced glyphs; the content stream never cites them)
    for (let n = 0; n < this.newToOld.length; n++) {
      for (const comp of componentGids(font, this.newToOld[n])) {
        if (!this.oldToNew.has(comp)) {
          this.oldToNew.set(comp, this.newToOld.length);
          this.newToOld.push(comp);
        }
      }
    }
    const n = this.newToOld.length;

    // glyf + loca (long format)
    const blobs = this.newToOld.map((old) => {
      const [s, e] = font.glyphSpan(old);
      return remapGlyph(font.bytes.slice(s, e), this.oldToNew);
    });
    const loca = new Uint8Array((n + 1) * 4);
    const ldv = new DataView(loca.buffer);
    let glyfLen = 0;
    blobs.forEach((b, i) => { ldv.setUint32(i * 4, glyfLen); glyfLen += pad4(b.length); });
    ldv.setUint32(n * 4, glyfLen);
    const glyf = new Uint8Array(glyfLen);
    let go = 0;
    for (const b of blobs) { glyf.set(b, go); go += pad4(b.length); }

    // hmtx (full metrics for every subset glyph)
    const hmtx = new Uint8Array(n * 4);
    const hdv = new DataView(hmtx.buffer);
    this.newToOld.forEach((old, i) => {
      hdv.setUint16(i * 4, font.advance(old));
      hdv.setInt16(i * 4 + 2, font.lsb(old));
    });

    // patched copies of head / hhea / maxp
    const head = font.tableBytes('head')!;
    const headDv = new DataView(head.buffer, head.byteOffset);
    headDv.setUint32(8, 0);       // checkSumAdjustment — recomputed below
    headDv.setInt16(50, 1);       // long loca
    const hhea = font.tableBytes('hhea')!;
    new DataView(hhea.buffer, hhea.byteOffset).setUint16(34, n);
    const maxp = font.tableBytes('maxp')!;
    new DataView(maxp.buffer, maxp.byteOffset).setUint16(4, n);

    const tabs: [string, Uint8Array][] = [
      ['glyf', glyf], ['head', head], ['hhea', hhea],
      ['hmtx', hmtx], ['loca', loca], ['maxp', maxp],
    ];
    for (const opt of ['cvt ', 'fpgm', 'prep', 'gasp']) {
      const t = font.tableBytes(opt);
      if (t) tabs.push([opt, t]);
    }
    tabs.sort((a, b) => (a[0] < b[0] ? -1 : 1));

    // sfnt assembly
    const numTables = tabs.length;
    const headerLen = 12 + numTables * 16;
    let total = headerLen;
    const offsets = tabs.map(([, data]) => { const o = total; total += pad4(data.length); return o; });
    const out = new Uint8Array(total);
    const odv = new DataView(out.buffer);
    odv.setUint32(0, 0x00010000);
    odv.setUint16(4, numTables);
    const pow2 = 1 << Math.floor(Math.log2(numTables));
    odv.setUint16(6, pow2 * 16);
    odv.setUint16(8, Math.floor(Math.log2(numTables)));
    odv.setUint16(10, numTables * 16 - pow2 * 16);
    tabs.forEach(([tag, data], i) => {
      const rec = 12 + i * 16;
      for (let c = 0; c < 4; c++) out[rec + c] = tag.charCodeAt(c);
      out.set(data, offsets[i]);
      odv.setUint32(rec + 4, tableChecksum(out.subarray(offsets[i], offsets[i] + pad4(data.length))));
      odv.setUint32(rec + 8, offsets[i]);
      odv.setUint32(rec + 12, data.length);
    });
    const headIdx = tabs.findIndex(([tag]) => tag === 'head');
    const adjust = (0xb1b0afba - tableChecksum(out)) >>> 0;
    odv.setUint32(offsets[headIdx] + 8, adjust);

    // /W widths — subset GIDs are consecutive from 1, so a single run covers all
    const k = 1000 / font.upm;
    const widths = this.newToOld.slice(1).map((old) => Math.round(font.advance(old) * k));
    const w = widths.length ? `1 [${widths.join(' ')}]` : '';

    // ToUnicode CMap (text-used GIDs only; ≤100 mappings per bfchar block)
    const entries = [...this.newToCp.entries()].sort((a, b) => a[0] - b[0]);
    let cmap = '/CIDInit /ProcSet findresource begin\n12 dict begin\nbegincmap\n' +
      '/CIDSystemInfo << /Registry (Adobe) /Ordering (UCS) /Supplement 0 >> def\n' +
      '/CMapName /Adobe-Identity-UCS def\n/CMapType 2 def\n' +
      '1 begincodespacerange\n<0000> <FFFF>\nendcodespacerange\n';
    for (let i = 0; i < entries.length; i += 100) {
      const chunk = entries.slice(i, i + 100);
      cmap += `${chunk.length} beginbfchar\n`;
      for (const [gid, cp] of chunk) {
        cmap += `<${gid.toString(16).padStart(4, '0')}> <${cpToUtf16BeHex(cp)}>\n`;
      }
      cmap += 'endbfchar\n';
    }
    cmap += 'endcmap\nCMapName currentdict /CMap defineresource pop\nend\nend\n';

    return {
      psName,
      fontFile: out,
      w,
      toUnicode: new TextEncoder().encode(cmap),
      ascent: Math.round(font.ascender * k),
      descent: Math.round(font.descender * k),
      capHeight: Math.round(font.capHeight * k),
      bbox: font.bbox.map((v) => Math.round(v * k)) as [number, number, number, number],
    };
  }
}
