// Minimal client-side PDF writer: pages that each contain a single JPEG
// (DCTDecode passthrough — the JPEG bytes are embedded as-is, never re-encoded).
// Used for the downloadable check report (RGB JPEG pages) and to wrap CMYK
// JPEGs in a one-page PDF so pdf.js can decode them for preview (browsers
// can't decode CMYK JPEGs natively).

export interface JpegPdfPage {
  jpeg: Uint8Array;
  pxW: number;
  pxH: number;
  wPt: number;             // page size in points
  hPt: number;
  colorSpace?: 'DeviceRGB' | 'DeviceCMYK' | 'DeviceGray';
  invertDecode?: boolean;  // Adobe CMYK JPEGs store inverted samples → /Decode [1 0 …]
}

const fmt = (v: number) => String(Math.round(v * 100) / 100);

export function buildJpegPdf(pages: JpegPdfPage[]): Uint8Array {
  const enc = new TextEncoder();
  const chunks: Uint8Array[] = [];
  let offset = 0;
  const offsets: number[] = [];  // byte offset per object number (for the xref)
  const push = (part: string | Uint8Array) => {
    const b = typeof part === 'string' ? enc.encode(part) : part;
    chunks.push(b);
    offset += b.length;
  };
  const obj = (n: number, body: string) => {
    offsets[n] = offset;
    push(`${n} 0 obj\n${body}\nendobj\n`);
  };

  push('%PDF-1.4\n%âãÏÓ\n'); // binary-content marker line

  const kids = pages.map((_, i) => `${3 + i * 3} 0 R`).join(' ');
  obj(1, '<< /Type /Catalog /Pages 2 0 R >>');
  obj(2, `<< /Type /Pages /Kids [${kids}] /Count ${pages.length} >>`);

  pages.forEach((p, i) => {
    const pageN = 3 + i * 3, imgN = pageN + 1, contN = pageN + 2;
    const cs = p.colorSpace ?? 'DeviceRGB';
    const comps = cs === 'DeviceCMYK' ? 4 : cs === 'DeviceGray' ? 1 : 3;
    obj(pageN,
      `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${fmt(p.wPt)} ${fmt(p.hPt)}] ` +
      `/Resources << /XObject << /Im0 ${imgN} 0 R >> >> /Contents ${contN} 0 R >>`);

    const decode = p.invertDecode ? ` /Decode [${Array(comps).fill('1 0').join(' ')}]` : '';
    offsets[imgN] = offset;
    push(`${imgN} 0 obj\n<< /Type /XObject /Subtype /Image /Width ${p.pxW} /Height ${p.pxH} ` +
      `/ColorSpace /${cs} /BitsPerComponent 8 /Filter /DCTDecode${decode} /Length ${p.jpeg.length} >>\nstream\n`);
    push(p.jpeg);
    push('\nendstream\nendobj\n');

    const content = `q ${fmt(p.wPt)} 0 0 ${fmt(p.hPt)} 0 0 cm /Im0 Do Q`;
    obj(contN, `<< /Length ${content.length} >>\nstream\n${content}\nendstream`);
  });

  const xref = offset;
  const count = 2 + pages.length * 3;
  let table = `xref\n0 ${count + 1}\n0000000000 65535 f \n`;
  for (let n = 1; n <= count; n++) table += `${String(offsets[n]).padStart(10, '0')} 00000 n \n`;
  push(table);
  push(`trailer\n<< /Size ${count + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`);

  const out = new Uint8Array(offset);
  let o = 0;
  for (const c of chunks) { out.set(c, o); o += c.length; }
  return out;
}
