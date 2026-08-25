// Binary metadata analysis for JPEG / PNG submissions:
// dimensions, color space, embedded DPI, ICC profile, alpha channel.

import type { ImageFileInfo } from './types.ts';

export function analyzePng(bytes: Uint8Array): ImageFileInfo {
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  // signature is 8 bytes; IHDR follows
  let width = 0, height = 0, colorType = 0;
  let dpi: number | null = null;
  let hasIcc = false;
  let iccName: string | null = null;

  let off = 8;
  while (off + 8 <= bytes.length) {
    const len = dv.getUint32(off);
    const type = String.fromCharCode(bytes[off + 4], bytes[off + 5], bytes[off + 6], bytes[off + 7]);
    const dataOff = off + 8;
    if (type === 'IHDR') {
      width = dv.getUint32(dataOff);
      height = dv.getUint32(dataOff + 4);
      colorType = bytes[dataOff + 9];
    } else if (type === 'pHYs') {
      const ppuX = dv.getUint32(dataOff);
      const unit = bytes[dataOff + 8];
      if (unit === 1) dpi = Math.round(ppuX * 0.0254); // pixels per metre -> dpi
    } else if (type === 'iCCP') {
      hasIcc = true;
      let e = dataOff;
      while (e < dataOff + Math.min(len, 79) && bytes[e] !== 0) e++;
      iccName = new TextDecoder().decode(bytes.subarray(dataOff, e));
    } else if (type === 'IDAT' || type === 'IEND') {
      if (width) break;
    }
    off = dataOff + len + 4;
  }

  const hasAlpha = colorType === 4 || colorType === 6;
  const colorSpace: ImageFileInfo['colorSpace'] =
    colorType === 0 || colorType === 4 ? 'gray'
      : colorType === 3 ? 'palette'
        : 'rgb';

  return { format: 'png', width, height, colorSpace, hasAlpha, embeddedDpi: dpi, hasIccProfile: hasIcc, iccName };
}

export function analyzeJpeg(bytes: Uint8Array): ImageFileInfo {
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let width = 0, height = 0, components = 3;
  let dpi: number | null = null;
  let hasIcc = false;
  let hasAdobe = false; // APP14: Adobe CMYK JPEGs store inverted samples

  let off = 2; // skip SOI
  while (off + 4 <= bytes.length) {
    if (bytes[off] !== 0xff) { off++; continue; }
    const marker = bytes[off + 1];
    if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) { off += 2; continue; }
    if (marker === 0xd9 || marker === 0xda) break; // EOI / start of scan
    const segLen = dv.getUint16(off + 2);
    const dataOff = off + 4;

    if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
      // SOFn
      height = dv.getUint16(dataOff + 1);
      width = dv.getUint16(dataOff + 3);
      components = bytes[dataOff + 5];
    } else if (marker === 0xe0) {
      // APP0 JFIF
      const sig = String.fromCharCode(...bytes.subarray(dataOff, dataOff + 4));
      if (sig === 'JFIF') {
        const units = bytes[dataOff + 7];
        const xd = dv.getUint16(dataOff + 8);
        if (units === 1) dpi = xd;
        else if (units === 2) dpi = Math.round(xd * 2.54);
      }
    } else if (marker === 0xe1) {
      // APP1 Exif — look for resolution (simplified: skip; JFIF covers most)
    } else if (marker === 0xe2) {
      const sig = String.fromCharCode(...bytes.subarray(dataOff, dataOff + 11));
      if (sig.startsWith('ICC_PROFILE')) hasIcc = true;
    } else if (marker === 0xee) {
      const sig = String.fromCharCode(...bytes.subarray(dataOff, dataOff + 5));
      if (sig === 'Adobe') hasAdobe = true;
    }
    off = off + 2 + segLen;
  }

  let colorSpace: ImageFileInfo['colorSpace'] = 'unknown';
  if (components === 1) colorSpace = 'gray';
  else if (components === 3) colorSpace = 'rgb';
  else if (components === 4) colorSpace = 'cmyk'; // CMYK or YCCK (both CMYK-based)

  return { format: 'jpeg', width, height, colorSpace, hasAlpha: false, embeddedDpi: dpi, hasIccProfile: hasIcc, iccName: null, hasAdobeMarker: hasAdobe };
}

export function sniffImage(bytes: Uint8Array): 'png' | 'jpeg' | null {
  if (bytes.length > 8 && bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47) return 'png';
  if (bytes.length > 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return 'jpeg';
  return null;
}
