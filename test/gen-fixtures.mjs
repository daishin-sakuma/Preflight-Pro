// Generates test PDFs / PNG with known preflight problems (and one clean file).
// PDFs are written by hand with a correct xref table (uncompressed streams).
import { writeFileSync, mkdirSync } from 'node:fs';
import { deflateSync } from 'node:zlib';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const dir = join(dirname(fileURLToPath(import.meta.url)), 'fixtures');
mkdirSync(dir, { recursive: true });

function buildPdf(objects, trailerExtra = '') {
  // objects: array of strings WITHOUT "N 0 obj"/"endobj" wrappers
  let out = '%PDF-1.4\n%\xE2\xE3\xCF\xD3\n';
  const offsets = [0];
  objects.forEach((body, i) => {
    offsets.push(out.length);
    out += `${i + 1} 0 obj\n${body}\nendobj\n`;
  });
  const xrefPos = out.length;
  out += `xref\n0 ${objects.length + 1}\n`;
  out += '0000000000 65535 f \n';
  for (let i = 1; i <= objects.length; i++) {
    out += String(offsets[i]).padStart(10, '0') + ' 00000 n \n';
  }
  out += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R ${trailerExtra} >>\nstartxref\n${xrefPos}\n%%EOF\n`;
  return Buffer.from(out, 'latin1');
}

// ---------------------------------------------------------------------------
// bad.pdf — A4 exact size (no bleed), RGB fill, 400% rich black, 3c heavy,
// hairline stroke, white fill with overprint gs.
// ---------------------------------------------------------------------------
{
  const W = 595.28, H = 841.89;
  const content = [
    '1 0 0 rg', '50 600 200 100 re f',                 // RGB red fill
    '1 1 1 1 k', '50 450 200 100 re f',                // 400% rich black
    '0.95 0.95 0.95 0 k', '50 300 200 100 re f',       // 3-color heavy
    '0 0 0 1 K', '0.1 w', '50 250 m 250 250 l S',      // hairline
    '/GS0 gs', '0 0 0 0 k', '300 600 100 100 re f',    // white fill + overprint gs
    '0 0 0 1 k', '350 450 80 80 re f',                 // K100 fill w/ overprint ON
    'BT /F1 24 Tf 100 700 Td (Hello) Tj ET',           // non-embedded font text
  ].join('\n');

  const objs = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${W} ${H}] /Contents 4 0 R ` +
    '/Resources << /ExtGState << /GS0 5 0 R >> /Font << /F1 6 0 R >> >> >>',
    `<< /Length ${content.length} >>\nstream\n${content}\nendstream`,
    '<< /Type /ExtGState /OP true /op true /OPM 1 >>',
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>', // standard-14: not embedded
  ];
  writeFileSync(join(dir, 'bad.pdf'), buildPdf(objs));
}

// ---------------------------------------------------------------------------
// good.pdf — A4 + 3mm bleed, TrimBox set, CMYK-only under 300%, flate stream.
// ---------------------------------------------------------------------------
{
  const B = 3 * 72 / 25.4; // 3mm in pt
  const W = 595.28 + B * 2, H = 841.89 + B * 2;
  const trim = [B, B, W - B, H - B].map((v) => v.toFixed(2)).join(' ');
  const content = [
    '0.1 0.05 0 0 k', `0 0 ${W.toFixed(2)} ${H.toFixed(2)} re f`, // pale bg to full bleed
    '0 0 0 1 k', '100 400 200 120 re f',                          // K100
    '0.6 0.5 0.4 0.2 k', '100 200 150 100 re f',                  // 170%
    '1 w', '100 150 m 300 150 l S',
  ].join('\n');
  const flate = deflateSync(Buffer.from(content, 'latin1'));

  const objs = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${W.toFixed(2)} ${H.toFixed(2)}] ` +
    `/TrimBox [${trim}] /BleedBox [0 0 ${W.toFixed(2)} ${H.toFixed(2)}] /Contents 4 0 R /Resources << >> >>`,
  ];
  // stream object with binary body needs manual assembly
  let out = '%PDF-1.4\n';
  const offsets = [0];
  const push = (body) => { offsets.push(out.length); out += body; };
  objs.forEach((body, i) => push(`${i + 1} 0 obj\n${body}\nendobj\n`));
  push(`4 0 obj\n<< /Length ${flate.length} /Filter /FlateDecode >>\nstream\n`);
  const head = Buffer.from(out, 'latin1');
  const tail1 = Buffer.from('\nendstream\nendobj\n', 'latin1');
  let pos = head.length + flate.length + tail1.length;
  const xrefPos = pos;
  let xref = `xref\n0 5\n0000000000 65535 f \n`;
  for (let i = 1; i <= 4; i++) xref += String(offsets[i]).padStart(10, '0') + ' 00000 n \n';
  xref += `trailer\n<< /Size 5 /Root 1 0 R >>\nstartxref\n${xrefPos}\n%%EOF\n`;
  writeFileSync(join(dir, 'good.pdf'), Buffer.concat([head, flate, tail1, Buffer.from(xref, 'latin1')]));
}

// ---------------------------------------------------------------------------
// ai-style.pdf — Illustrator-like: ICCBased CMYK via /CS0 + scn, and a Type-2
// gradient function carrying ink values. No Device* names anywhere.
// ---------------------------------------------------------------------------
{
  const W = 612.28, H = 858.89; // A4 + 3mm bleed
  const B = 3 * 72 / 25.4;
  const trim = [B, B, W - B, H - B].map((v) => v.toFixed(2)).join(' ');
  const content = [
    '/CS0 cs 0.9 0.1 0 0 scn', `0 0 ${W} ${H} re f`,
    '0.2 0.3 0.4 0.1 scn', '100 100 200 200 re f',
  ].join('\n');
  const objs = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${W} ${H}] /TrimBox [${trim}] /Contents 4 0 R ` +
    '/Resources << /ColorSpace << /CS0 6 0 R >> >> >>',
    `<< /Length ${content.length} >>\nstream\n${content}\nendstream`,
    '<< /N 4 /Length 4 >>\nstream\nFAKE\nendstream',
    '[/ICCBased 5 0 R]',
    // gradient function (endpoint inks 140% / 100%K)
    '<< /FunctionType 2 /Domain [0 1] /C0 [0.5 0.4 0.3 0.2] /C1 [0 0 0 1] /N 1 >>',
  ];
  writeFileSync(join(dir, 'ai-style.pdf'), buildPdf(objs));
}

// ---------------------------------------------------------------------------
// small.png — 120x120 red RGB PNG @72dpi (too small for A4 print)
// ---------------------------------------------------------------------------
{
  const W = 120, H = 120;
  const crcTable = [...Array(256)].map((_, n) => {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    return c >>> 0;
  });
  const crc32 = (buf) => {
    let c = 0xffffffff;
    for (const b of buf) c = crcTable[(c ^ b) & 0xff] ^ (c >>> 8);
    return (c ^ 0xffffffff) >>> 0;
  };
  const chunk = (type, data) => {
    const t = Buffer.from(type, 'latin1');
    const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
    const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(Buffer.concat([t, data])));
    return Buffer.concat([len, t, data, crc]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(W, 0); ihdr.writeUInt32BE(H, 4);
  ihdr[8] = 8; ihdr[9] = 2; // 8-bit RGB
  const phys = Buffer.alloc(9);
  phys.writeUInt32BE(2835, 0); phys.writeUInt32BE(2835, 4); phys[8] = 1; // 72dpi
  const raw = Buffer.alloc(H * (1 + W * 3));
  for (let y = 0; y < H; y++) {
    const row = y * (1 + W * 3);
    for (let x = 0; x < W; x++) {
      raw[row + 1 + x * 3] = 220; raw[row + 2 + x * 3] = 30; raw[row + 3 + x * 3] = 40;
    }
  }
  const png = Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('pHYs', phys),
    chunk('IDAT', deflateSync(raw)),
    chunk('IEND', Buffer.alloc(0)),
  ]);
  writeFileSync(join(dir, 'small.png'), png);
}

console.log('fixtures written to', dir);
