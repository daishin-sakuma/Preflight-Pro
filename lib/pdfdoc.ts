// Minimal client-side PDF document writer with REAL vector text.
// Latin text uses the Standard-14 Helvetica / Helvetica-Bold fonts (guaranteed
// by every PDF viewer, no embedding needed) with WinAnsi encoding. Japanese /
// other non-Latin text is typeset through embedded subset CID fonts
// (CIDFontType2 + Identity-H, built at runtime by lib/fontEmbed.ts). Vector
// rects/lines and lossless FlateDecode RGB images round it out. All text stays
// selectable, searchable and sharp at any zoom — unlike a rasterized page.
//
// Coordinates: the caller works in a top-down "layout" space (layoutW ×
// layoutH); each page starts with a CTM that maps it onto the PDF page size,
// and y values are flipped internally.

import pako from 'pako';
import type { CidFontData } from './fontEmbed.ts';

const f2 = (v: number) => String(Math.round(v * 100) / 100);

// WinAnsi code points that differ from Latin-1 (the 0x80–0x9F range)
const WIN_ANSI_EXTRA: Record<number, number> = {
  0x20ac: 128, 0x201a: 130, 0x0192: 131, 0x201e: 132, 0x2026: 133, 0x2020: 134,
  0x2021: 135, 0x02c6: 136, 0x2030: 137, 0x0160: 138, 0x2039: 139, 0x0152: 140,
  0x017d: 142, 0x2018: 145, 0x2019: 146, 0x201c: 147, 0x201d: 148, 0x2022: 149,
  0x2013: 150, 0x2014: 151, 0x02dc: 152, 0x2122: 153, 0x0161: 154, 0x203a: 155,
  0x0153: 156, 0x017e: 158, 0x0178: 159,
};
// friendly ASCII downgrades for symbols WinAnsi lacks
const REPLACE: Record<number, string> = {
  0x2265: '>=', 0x2264: '<=', 0x2260: '!=', 0x2192: '->', 0x2190: '<-', 0x2248: '~',
};

// Encode a string to WinAnsi bytes (with PDF string escaping), or null when it
// contains characters WinAnsi can't represent (CJK etc.) — the caller then
// falls back to rasterizing that line.
export function encodeWinAnsi(text: string): Uint8Array | null {
  const out: number[] = [];
  for (const ch of text) {
    const cp = ch.codePointAt(0)!;
    if (cp === 0x28 || cp === 0x29 || cp === 0x5c) { out.push(0x5c, cp); continue; } // escape ( ) \
    if (cp >= 32 && cp <= 126) { out.push(cp); continue; }
    if (cp >= 0xa0 && cp <= 0xff) { out.push(cp); continue; }
    const extra = WIN_ANSI_EXTRA[cp];
    if (extra !== undefined) { out.push(extra); continue; }
    const rep = REPLACE[cp];
    if (rep !== undefined) { for (const c of rep) out.push(c.charCodeAt(0)); continue; }
    return null;
  }
  return new Uint8Array(out);
}

type Chunk = string | Uint8Array;

interface PageBuf {
  chunks: Chunk[];
  images: { name: string; data: Uint8Array; pxW: number; pxH: number }[];
}

export class PdfDoc {
  private pagesBuf: PageBuf[] = [];
  private cur: PageBuf | null = null;
  // embedded subset CID fonts, keyed by their content-stream resource name
  // (/F3, /F4, …). Ops may reference the name during layout; the built font
  // data is attached afterwards via setCidFont().
  private cidFonts = new Map<string, CidFontData>();

  constructor(
    private wPt: number, private hPt: number,
    private layoutW: number, private layoutH: number,
  ) {}

  get pageCount() { return this.pagesBuf.length; }

  addPage() {
    const s = this.wPt / this.layoutW;
    this.cur = { chunks: [`q ${f2(s)} 0 0 ${f2(s)} 0 0 cm\n`], images: [] };
    this.pagesBuf.push(this.cur);
  }

  // switch back to an existing page (footer pass after the total is known)
  usePage(i: number) { this.cur = this.pagesBuf[i]; }

  private y(v: number) { return this.layoutH - v; } // top-down layout → PDF coords
  private push(...cs: Chunk[]) { this.cur!.chunks.push(...cs); }

  private color(hex: string, stroke = false): string {
    const m = /^#?([0-9a-f]{6})$/i.exec(hex);
    const n = m ? parseInt(m[1], 16) : 0;
    const r = ((n >> 16) & 255) / 255, g = ((n >> 8) & 255) / 255, b = (n & 255) / 255;
    return `${f2(r)} ${f2(g)} ${f2(b)} ${stroke ? 'RG' : 'rg'}\n`;
  }

  // Typeset a line (baseline at yBase in layout units). Returns false when the
  // text falls outside WinAnsi — the caller rasterizes that line instead.
  text(t: string, x: number, yBase: number, size: number, bold: boolean, colorHex: string): boolean {
    const bytes = encodeWinAnsi(t);
    if (!bytes) return false;
    this.push(
      this.color(colorHex),
      `BT /${bold ? 'F2' : 'F1'} ${f2(size)} Tf 1 0 0 1 ${f2(x)} ${f2(this.y(yBase))} Tm (`,
      bytes,
      ') Tj ET\n',
    );
    return true;
  }

  // Typeset a line with an embedded CID font (2-byte subset-GID string,
  // written as a hex string — no escaping concerns).
  textCid(res: string, gids: Uint8Array, x: number, yBase: number, size: number, colorHex: string) {
    let hex = '';
    for (const b of gids) hex += b.toString(16).padStart(2, '0');
    this.push(
      this.color(colorHex),
      `BT /${res} ${f2(size)} Tf 1 0 0 1 ${f2(x)} ${f2(this.y(yBase))} Tm <${hex}> Tj ET\n`,
    );
  }

  setCidFont(res: string, data: CidFontData) { this.cidFonts.set(res, data); }

  private roundRectPath(x: number, yTop: number, w: number, h: number, r: number) {
    const y0 = this.y(yTop + h), y1 = y0 + h; // bottom / top in PDF coords
    if (r <= 0) {
      this.push(`${f2(x)} ${f2(y0)} ${f2(w)} ${f2(h)} re\n`);
      return;
    }
    const k = r * 0.5523;
    const x0 = x, x1 = x + w;
    this.push(
      `${f2(x0 + r)} ${f2(y0)} m\n`,
      `${f2(x1 - r)} ${f2(y0)} l\n`,
      `${f2(x1 - r + k)} ${f2(y0)} ${f2(x1)} ${f2(y0 + r - k)} ${f2(x1)} ${f2(y0 + r)} c\n`,
      `${f2(x1)} ${f2(y1 - r)} l\n`,
      `${f2(x1)} ${f2(y1 - r + k)} ${f2(x1 - r + k)} ${f2(y1)} ${f2(x1 - r)} ${f2(y1)} c\n`,
      `${f2(x0 + r)} ${f2(y1)} l\n`,
      `${f2(x0 + r - k)} ${f2(y1)} ${f2(x0)} ${f2(y1 - r + k)} ${f2(x0)} ${f2(y1 - r)} c\n`,
      `${f2(x0)} ${f2(y0 + r)} l\n`,
      `${f2(x0)} ${f2(y0 + r - k)} ${f2(x0 + r - k)} ${f2(y0)} ${f2(x0 + r)} ${f2(y0)} c\n`,
      'h\n',
    );
  }

  fillRect(x: number, yTop: number, w: number, h: number, colorHex: string, radius = 0) {
    this.push(this.color(colorHex));
    this.roundRectPath(x, yTop, w, h, radius);
    this.push('f\n');
  }

  strokeRect(x: number, yTop: number, w: number, h: number, colorHex: string, lw: number, radius = 0) {
    this.push(this.color(colorHex, true), `${f2(lw)} w\n`);
    this.roundRectPath(x, yTop, w, h, radius);
    this.push('S\n');
  }

  line(x1: number, yT1: number, x2: number, yT2: number, colorHex: string, lw: number) {
    this.push(
      this.color(colorHex, true),
      `${f2(lw)} w ${f2(x1)} ${f2(this.y(yT1))} m ${f2(x2)} ${f2(this.y(yT2))} l S\n`,
    );
  }

  // deflated raw RGB image placed at (x, yTop) with layout size w × h
  image(deflatedRgb: Uint8Array, pxW: number, pxH: number, x: number, yTop: number, w: number, h: number) {
    const name = `Im${this.cur!.images.length}`;
    this.cur!.images.push({ name, data: deflatedRgb, pxW, pxH });
    this.push(`q ${f2(w)} 0 0 ${f2(h)} ${f2(x)} ${f2(this.y(yTop + h))} cm /${name} Do Q\n`);
  }

  build(): Uint8Array {
    const enc = new TextEncoder();
    const parts: Uint8Array[] = [];
    let offset = 0;
    const offsets: number[] = [];
    const push = (c: Chunk) => {
      const b = typeof c === 'string' ? enc.encode(c) : c;
      parts.push(b);
      offset += b.length;
    };
    const obj = (n: number, body: string) => {
      offsets[n] = offset;
      push(`${n} 0 obj\n${body}\nendobj\n`);
    };

    push('%PDF-1.4\n%âãÏÓ\n');

    // 1 catalog, 2 pages, 3/4 standard fonts, 5 objects per embedded CID font,
    // then per page: page dict, content, images
    let next = 5;
    const cidLayout = [...this.cidFonts.entries()].map(([res, data]) => {
      const type0N = next++, cidfN = next++, descN = next++, fileN = next++, touN = next++;
      return { res, data, type0N, cidfN, descN, fileN, touN };
    });
    const layout = this.pagesBuf.map((pg) => {
      const pageN = next++;
      const contentN = next++;
      const imgNs = pg.images.map(() => next++);
      return { pg, pageN, contentN, imgNs };
    });

    obj(1, '<< /Type /Catalog /Pages 2 0 R >>');
    obj(2, `<< /Type /Pages /Kids [${layout.map((l) => `${l.pageN} 0 R`).join(' ')}] /Count ${layout.length} >>`);
    obj(3, '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>');
    obj(4, '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold /Encoding /WinAnsiEncoding >>');

    for (const { res: _res, data, type0N, cidfN, descN, fileN, touN } of cidLayout) {
      void _res;
      obj(type0N,
        `<< /Type /Font /Subtype /Type0 /BaseFont /${data.psName} /Encoding /Identity-H ` +
        `/DescendantFonts [${cidfN} 0 R] /ToUnicode ${touN} 0 R >>`);
      obj(cidfN,
        `<< /Type /Font /Subtype /CIDFontType2 /BaseFont /${data.psName} ` +
        '/CIDSystemInfo << /Registry (Adobe) /Ordering (Identity) /Supplement 0 >> ' +
        `/FontDescriptor ${descN} 0 R /DW 1000 /W [${data.w}] /CIDToGIDMap /Identity >>`);
      obj(descN,
        `<< /Type /FontDescriptor /FontName /${data.psName} /Flags 4 ` +
        `/FontBBox [${data.bbox.join(' ')}] /ItalicAngle 0 /Ascent ${data.ascent} ` +
        `/Descent ${data.descent} /CapHeight ${data.capHeight} /StemV 80 /FontFile2 ${fileN} 0 R >>`);
      const deflated = pako.deflate(data.fontFile);
      offsets[fileN] = offset;
      push(`${fileN} 0 obj\n<< /Filter /FlateDecode /Length ${deflated.length} /Length1 ${data.fontFile.length} >>\nstream\n`);
      push(deflated);
      push('\nendstream\nendobj\n');
      offsets[touN] = offset;
      push(`${touN} 0 obj\n<< /Length ${data.toUnicode.length} >>\nstream\n`);
      push(data.toUnicode);
      push('\nendstream\nendobj\n');
    }

    const cidRes = cidLayout.map((c) => ` /${c.res} ${c.type0N} 0 R`).join('');
    for (const { pg, pageN, contentN, imgNs } of layout) {
      const xobj = pg.images.length
        ? ` /XObject << ${pg.images.map((im, i) => `/${im.name} ${imgNs[i]} 0 R`).join(' ')} >>`
        : '';
      obj(pageN,
        `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${f2(this.wPt)} ${f2(this.hPt)}] ` +
        `/Resources << /Font << /F1 3 0 R /F2 4 0 R${cidRes} >>${xobj} >> /Contents ${contentN} 0 R >>`);

      const contentLen = pg.chunks.reduce<number>(
        (s, c) => s + (typeof c === 'string' ? enc.encode(c).length : c.length), 0,
      );
      offsets[contentN] = offset;
      push(`${contentN} 0 obj\n<< /Length ${contentLen} >>\nstream\n`);
      for (const c of pg.chunks) push(c);
      push('\nendstream\nendobj\n');

      pg.images.forEach((im, i) => {
        offsets[imgNs[i]] = offset;
        push(`${imgNs[i]} 0 obj\n<< /Type /XObject /Subtype /Image /Width ${im.pxW} /Height ${im.pxH} ` +
          `/ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /FlateDecode /Length ${im.data.length} >>\nstream\n`);
        push(im.data);
        push('\nendstream\nendobj\n');
      });
    }

    const xref = offset;
    const count = next - 1;
    let table = `xref\n0 ${count + 1}\n0000000000 65535 f \n`;
    for (let n = 1; n <= count; n++) table += `${String(offsets[n]).padStart(10, '0')} 00000 n \n`;
    push(table);
    push(`trailer\n<< /Size ${count + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`);

    const total = new Uint8Array(offset);
    let o = 0;
    for (const b of parts) { total.set(b, o); o += b.length; }
    return total;
  }
}
