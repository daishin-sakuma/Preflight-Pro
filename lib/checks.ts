// Rule engine: converts raw analysis into user-facing findings,
// evaluated against the selected print settings.

import type { AnalysisResult, Finding, Settings, Severity } from './types.ts';
import { MM_PER_PT } from './types.ts';
import { paperSizeMm } from './presets.ts';

const f = (
  id: string, category: Finding['category'], severity: Severity,
  title: string, detail: string, extra?: Partial<Finding>,
): Finding => ({ id, category, severity, title, detail, ...extra });

const fmt = (n: number, d = 1) => Number(n.toFixed(d)).toLocaleString('en-US');

export function runChecks(a: AnalysisResult, s: Settings): Finding[] {
  const out: Finding[] = [];
  const paper = paperSizeMm(s.paperId, s.customWmm, s.customHmm, s.landscape);

  // marker helpers: link findings to locatable spots on the 2D preview
  const mk = (kind: NonNullable<Finding['markerKind']>) =>
    a.markers?.some((m) => m.kind === kind) ? kind : undefined;
  const mkPages = (kind: string) =>
    [...new Set((a.markers ?? []).filter((m) => m.kind === kind).map((m) => m.page))].sort((x, y) => x - y);

  // =====================================================================
  // 1. Bleed & trim size
  // =====================================================================
  if (a.kind === 'pdf') {
    const pg = a.pages[0];
    if (pg) {
      const media = pg.mediaBoxPt;
      const mediaW = (media[2] - media[0]) * MM_PER_PT;
      const mediaH = (media[3] - media[1]) * MM_PER_PT;

      if (pg.trimBoxPt) {
        const t = pg.trimBoxPt;
        const trimW = (t[2] - t[0]) * MM_PER_PT;
        const trimH = (t[3] - t[1]) * MM_PER_PT;
        // trim vs ordered size
        const okSize =
          (Math.abs(trimW - paper.wMm) < 1 && Math.abs(trimH - paper.hMm) < 1) ||
          (Math.abs(trimW - paper.hMm) < 1 && Math.abs(trimH - paper.wMm) < 1);
        out.push(okSize
          ? f('trim-size', 'bleed', 'ok', 'Finished size matches',
            `TrimBox ${fmt(trimW)}×${fmt(trimH)}mm matches the specified size (${paper.wMm}×${paper.hMm}mm).`)
          : f('trim-size', 'bleed', 'error', 'Finished size mismatch',
            `TrimBox is ${fmt(trimW)}×${fmt(trimH)}mm, but the specified size is ${paper.wMm}×${paper.hMm}mm. Rebuild at the correct size, or verify the ordered size.`));

        // bleed = media (or bleedbox) beyond trim
        const outer = pg.bleedBoxPt ?? media;
        const bl = Math.min(
          (t[0] - outer[0]), (outer[2] - t[2]),
          (t[1] - outer[1]), (outer[3] - t[3]),
        ) * MM_PER_PT;
        if (bl >= s.bleedMm - 0.3) {
          out.push(f('bleed', 'bleed', 'ok', 'Bleed present',
            `About ${fmt(bl)}mm of bleed is present (required: ${s.bleedMm}mm).`));
        } else if (bl > 0.3) {
          out.push(f('bleed', 'bleed', 'warning', 'Insufficient bleed',
            `Only about ${fmt(bl)}mm of bleed (required: ${s.bleedMm}mm). Paper-white edges may appear when trimmed.`));
        } else {
          out.push(f('bleed', 'bleed', 'error', 'No bleed',
            `There is no bleed outside the trim line. Trimming drift will expose paper white. Extend the artwork ${s.bleedMm}mm beyond the trim on all sides.`));
        }
      } else {
        // No TrimBox: compare media to ordered size
        const plain =
          (Math.abs(mediaW - paper.wMm) < 1 && Math.abs(mediaH - paper.hMm) < 1) ||
          (Math.abs(mediaW - paper.hMm) < 1 && Math.abs(mediaH - paper.wMm) < 1);
        const withBleed =
          (Math.abs(mediaW - (paper.wMm + s.bleedMm * 2)) < 1 && Math.abs(mediaH - (paper.hMm + s.bleedMm * 2)) < 1) ||
          (Math.abs(mediaW - (paper.hMm + s.bleedMm * 2)) < 1 && Math.abs(mediaH - (paper.wMm + s.bleedMm * 2)) < 1);
        if (withBleed) {
          out.push(f('trim-missing', 'bleed', 'info', 'No TrimBox (size includes bleed)',
            `Page size ${fmt(mediaW)}×${fmt(mediaH)}mm matches finished + ${s.bleedMm}mm bleed. No TrimBox (trim line) is set, so the print shop will treat it as center trimming.`));
        } else if (plain) {
          out.push(f('trim-missing', 'bleed', 'error', 'No bleed (exact finished size)',
            `Page size is exactly the finished size (${fmt(mediaW)}×${fmt(mediaH)}mm) with no bleed. Add ${s.bleedMm}mm of bleed on all sides.`));
        } else {
          out.push(f('trim-missing', 'bleed', 'warning', 'Size needs review',
            `Page size ${fmt(mediaW)}×${fmt(mediaH)}mm doesn't match the specified size (${paper.wMm}×${paper.hMm}mm / with bleed ${paper.wMm + s.bleedMm * 2}×${paper.hMm + s.bleedMm * 2}mm). If using crop marks, setting a TrimBox is recommended.`));
        }
      }
    }

    // page size consistency
    if (a.pages.length > 1) {
      const w0 = a.pages[0].widthPt, h0 = a.pages[0].heightPt;
      const mixed = a.pages.some((p) => Math.abs(p.widthPt - w0) > 1 || Math.abs(p.heightPt - h0) > 1);
      if (mixed) {
        out.push(f('page-size-mixed', 'bleed', 'warning', 'Mixed page sizes',
          'Page sizes vary within the document. All pages should be the same size for submission.'));
      }
    }
  } else if (a.imageInfo) {
    // raster submission: does pixel size cover trim + bleed at min dpi?
    const info = a.imageInfo;
    const needW = paper.wMm + s.bleedMm * 2;
    const needH = paper.hMm + s.bleedMm * 2;
    const dpiW = info.width / (needW / 25.4);
    const dpiH = info.height / (needH / 25.4);
    const effDpi = Math.min(dpiW, dpiH);
    const dpiTrim = Math.min(
      info.width / (paper.wMm / 25.4),
      info.height / (paper.hMm / 25.4),
    );
    if (effDpi >= s.minDpi) {
      out.push(f('img-bleed', 'bleed', 'ok', 'Size (with bleed) OK',
        `At ${fmt(needW)}×${fmt(needH)}mm including ${s.bleedMm}mm bleed, the effective resolution is ${Math.round(effDpi)}dpi. Lay out with the outer ${s.bleedMm}mm expected to be trimmed off.`));
    } else if (dpiTrim >= s.minDpi) {
      out.push(f('img-bleed', 'bleed', 'warning', 'No room for bleed',
        `At the exact finished size the image is ${Math.round(dpiTrim)}dpi, but including ${s.bleedMm}mm bleed it drops to ${Math.round(effDpi)}dpi. Build with bleed included.`));
    } else {
      out.push(f('img-bleed', 'bleed', 'error', 'Size (resolution) too low',
        `${paper.wMm}×${paper.hMm}mm + bleed needs ${Math.ceil((needW / 25.4) * s.minDpi)}×${Math.ceil((needH / 25.4) * s.minDpi)}px, but this image is only ${info.width}×${info.height}px (effective ${Math.round(effDpi)}dpi).`));
    }
  }

  // =====================================================================
  // 2. Color mode
  // =====================================================================
  if (a.kind === 'pdf' && a.scan && a.content) {
    const rgbHit = a.scan.hasDeviceRGB || a.scan.hasCalRGB || a.content.rgbOps > 0;
    if (rgbHit) {
      const sev: Severity = s.requireCmyk ? 'error' : 'warning';
      const srcs: string[] = [];
      if (a.content.rgbOps > 0) srcs.push(`${a.content.rgbOps} RGB draw op(s)`);
      if (a.scan.hasDeviceRGB) srcs.push('DeviceRGB color space');
      if (a.scan.hasCalRGB) srcs.push('CalRGB color space');
      out.push(f('rgb', 'color', sev, 'RGB color present',
        `Detected ${srcs.join(', ')}. Printing is done in CMYK, so leaving RGB risks large color shifts from the shop's automatic conversion. Convert to CMYK and resubmit.`,
        { markerKind: mk('rgb'), pages: mkPages('rgb').length ? mkPages('rgb') : undefined }));
    } else if (a.scan.hasDeviceCMYK || a.scan.iccCmykLikely || a.content.cmykFills.length > 0) {
      const icc = a.scan.iccCmykLikely ? ' (ICC-based CMYK color space)' : '';
      out.push(f('rgb', 'color', 'ok', 'Built in CMYK',
        `No RGB objects were detected${icc}.`));
    } else {
      out.push(f('rgb', 'color', 'info', 'No color / undetermined',
        'No color-bearing objects were detected (may be grayscale only, or composed solely of special color spaces / gradients).'));
    }

    if (a.scan.hasICCBased && a.scan.iccRgbLikely && s.requireCmyk) {
      out.push(f('icc-rgb', 'color', 'warning', 'Possible ICC-based RGB color space',
        'An ICC-profile (RGB-type) color space may be present. Check that embedded images are not still RGB.'));
    }

    if (a.scan.separationNames.length > 0) {
      out.push(f('spot', 'color', 'warning', 'Spot colors used',
        `Spot colors “${a.scan.separationNames.slice(0, 6).join('”, “')}” are defined. Standard 4-color (CMYK) printing can't use spot colors — convert them to process colors (fine if you ordered spot-color printing).`,
        { count: a.scan.separationNames.length }));
    }

    if (a.scan.pdfxVersion) {
      out.push(f('pdfx', 'color', 'ok', `PDF/X compliant (${a.scan.pdfxVersion})`,
        `Output intent: ${a.scan.outputIntent ?? 'not stated'}. Saved in a standard suited to print production.`));
    }
  } else if (a.imageInfo) {
    const info = a.imageInfo;
    if (info.colorSpace === 'rgb' || info.colorSpace === 'palette') {
      const sev: Severity = s.requireCmyk ? 'warning' : 'info';
      out.push(f('img-rgb', 'color', sev,
        info.format === 'png' ? 'PNG is RGB' : 'RGB image',
        `This image is RGB${info.colorSpace === 'palette' ? ' (indexed color)' : ''}. It will be CMYK-converted at the shop, so vivid RGB colors (especially fluorescents) will print duller. For strict color control, submit CMYK PDF/TIFF.`));
    } else if (info.colorSpace === 'cmyk') {
      out.push(f('img-rgb', 'color', 'ok', 'CMYK image',
        'Detected a CMYK JPEG. The browser preview is an approximation.'));
    } else if (info.colorSpace === 'gray') {
      out.push(f('img-rgb', 'color', 'info', 'Grayscale image',
        'Fine if intended for monochrome printing.'));
    }
    if (info.hasIccProfile) {
      out.push(f('img-icc', 'color', 'info', 'ICC profile embedded',
        `${info.iccName ? `Profile: ${info.iccName}. ` : ''}It may be discarded depending on the shop's workflow. Building to Japan Color 2001 Coated (or equivalent) is common.`));
    }
    if (info.hasAlpha) {
      out.push(f('img-alpha', 'color', 'warning', 'Transparency (alpha) present',
        'Transparent areas print as white or an undefined color. Add a background and flatten.'));
    }
  }

  // =====================================================================
  // 3. Ink (TAC / solids / overprint)
  // =====================================================================
  if (a.kind === 'pdf' && a.content && a.scan) {
    const over = a.content.cmykFills.filter((c) => c.tac > s.tacLimit);
    const reg4 = a.content.cmykFills.filter((c) => c.c >= 0.99 && c.m >= 0.99 && c.y >= 0.99 && c.k >= 0.99);
    const heavy3 = a.content.cmykFills.filter(
      (c) => c.tac <= s.tacLimit && [c.c, c.m, c.y].filter((v) => v >= 0.9).length >= 3,
    );

    if (reg4.length > 0 || a.scan.usesRegistrationAll) {
      out.push(f('4c-black', 'ink', 'error', '4-color solid (C100 M100 Y100 K100)',
        `A 4-color solid${a.scan.usesRegistrationAll ? ' / registration color (a special color for crop marks)' : ''} is used. The ink won't dry, causing set-off and blocking. Change black to K100% or a proper rich black (e.g. C40 M30 Y30 K100).`));
    }
    if (over.length > 0) {
      const worst = over.reduce((x, y) => (x.tac > y.tac ? x : y));
      out.push(f('tac-vector', 'ink', 'error', `Total ink over ${s.tacLimit}%`,
        `${over.length} color(s) exceed the ${s.tacLimit}% limit (max ${Math.round(worst.tac)}%: C${Math.round(worst.c * 100)} M${Math.round(worst.m * 100)} Y${Math.round(worst.y * 100)} K${Math.round(worst.k * 100)}). This causes poor drying and set-off — keep the total at or below ${s.tacLimit}%.`,
        { count: over.length, markerKind: mk('tac'), pages: mkPages('tac').length ? mkPages('tac') : undefined }));
    } else if (a.content.cmykFills.length > 0 && reg4.length === 0) {
      out.push(f('tac-vector', 'ink', 'ok', `Total ink (vector) within ${s.tacLimit}%`,
        `All ${a.content.cmykFills.length} detected CMYK color(s) are within the limit.`));
    }
    if (heavy3.length > 0) {
      out.push(f('3c-heavy', 'ink', 'warning', 'Dense 3-color solid',
        `${heavy3.length} color(s) use 90%+ in all of C, M and Y. This risks misregistration and poor drying — design using the K plate instead.`,
        { count: heavy3.length }));
    }
    if (a.content.richBlackText.length > 0) {
      out.push(f('rich-black-text', 'ink', 'warning', 'Rich black used on text',
        `Text uses black built from 3+ overlapping inks (rich black). Small text will fringe from misregistration. Use K100% only for body text.`,
        { count: a.content.richBlackText.length, markerKind: mk('rich-black') }));
    }

    // pixel-based approximate TAC (photos etc.)
    const worstTac = a.tac.reduce((mx, t) => Math.max(mx, t.maxTac), 0);
    const anyOver = a.tac.some((t) => t.overLimitRatio > 0.0005);
    if (anyOver) {
      out.push(f('tac-raster', 'ink', 'warning', 'High-ink areas present (reference)',
        `Based on the rendered result, areas that may exceed ${s.tacLimit}% total ink were detected (est. max ~${worstTac}%). Use the “Ink” overlay in the preview to see where. Note: this is approximated from RGB rendering — verify exact values against the source CMYK.`,
        { pages: a.tac.filter((t) => t.overLimitRatio > 0.0005).map((t) => t.page) }));
    }

    // overprint
    if (a.content.whiteFillWithGs > 0) {
      out.push(f('white-op', 'ink', 'error', 'Suspected white overprint',
        `In a document with overprint enabled, ${a.content.whiteFillWithGs} white fill object(s) were detected. When white is set to overprint, those areas vanish in print (they still show on screen, which causes frequent accidents). Turn overprint off.`,
        { markerKind: mk('white-op'), pages: mkPages('white-op').length ? mkPages('white-op') : undefined }));
    }
    if (a.scan.overprintTrue) {
      const opCount = (a.markers ?? []).filter((m) => m.kind === 'overprint').length;
      out.push(f('overprint', 'ink', 'warning', 'Overprint set',
        'Overprint settings are present. Fine if intentional (e.g. K100 text overprint), but if not, verify with an overprint preview. Some shops auto-overprint K100 only.',
        {
          count: opCount || undefined,
          markerKind: mk('overprint'),
          pages: mkPages('overprint').length ? mkPages('overprint') : undefined,
        }));
    } else if (a.content.whiteFillWithGs === 0) {
      out.push(f('overprint', 'ink', 'ok', 'No overprint',
        'No dangerous overprint settings were detected (K100 text is commonly auto-overprinted by the shop).'));
    }
  } else if (a.imageInfo) {
    const worstTac = a.tac.reduce((mx, t) => Math.max(mx, t.maxTac), 0);
    const anyOver = a.tac.some((t) => t.overLimitRatio > 0.0005);
    out.push(anyOver
      ? f('tac-raster', 'ink', 'warning', 'High-ink areas present (reference)',
        `Dark areas that may exceed ${s.tacLimit}% total ink after CMYK conversion were detected (est. max ~${worstTac}%). Check with the “Ink” overlay in the preview.`)
      : f('tac-raster', 'ink', 'ok', `Total ink within ${s.tacLimit}% (est.)`,
        `Total ink after CMYK conversion is expected to stay within the limit (est. max ~${worstTac}%).`));
  }

  // =====================================================================
  // 4. Resolution
  // =====================================================================
  if (a.kind === 'pdf') {
    if (a.images.length > 0) {
      const low = a.images.filter((im) => im.effectiveDpi < s.minDpi && im.printWidthMm > 5 && im.printHeightMm > 5);
      const veryLow = low.filter((im) => im.effectiveDpi < Math.min(200, s.minDpi));
      if (low.length === 0) {
        out.push(f('dpi', 'resolution', 'ok', `All placed images ≥ ${s.minDpi}dpi`,
          `Verified the effective resolution of ${a.images.length} placed image(s).`));
      } else {
        const worst = low.reduce((x, y) => (x.effectiveDpi < y.effectiveDpi ? x : y));
        out.push(f('dpi', 'resolution', veryLow.length > 0 ? 'error' : 'warning',
          `${low.length} low-resolution placed image(s)`,
          `Some images are below ${s.minDpi}dpi effective (lowest ${worst.effectiveDpi}dpi, placed at ${fmt(worst.printWidthMm, 0)}×${fmt(worst.printHeightMm, 0)}mm). They will print coarse. Replace with images ≥ ${s.minDpi}dpi at size, or shrink the placement.`,
          { count: low.length, pages: [...new Set(low.map((i) => i.page))] }));
      }
    } else {
      out.push(f('dpi', 'resolution', 'info', 'No placed images',
        'No raster images were detected (vector only).'));
    }
  } else if (a.imageInfo) {
    const info = a.imageInfo;
    if (info.embeddedDpi) {
      out.push(f('img-dpi-meta', 'resolution', 'info', `Image resolution setting: ${info.embeddedDpi}dpi`,
        `This is the resolution in the metadata. Actual print quality depends on the effective resolution at the specified size (see the bleed check).`));
    }
  }

  // =====================================================================
  // 5. Fonts
  // =====================================================================
  if (a.kind === 'pdf' && a.scan) {
    if (a.scan.fontsTotal === 0) {
      out.push(f('fonts', 'font', 'ok', 'No fonts used',
        'No fonts were detected (already outlined, or rasterized).'));
    } else if (a.scan.fontsNotEmbedded.length === 0) {
      out.push(f('fonts', 'font', 'ok', `All fonts embedded (${a.scan.fontsTotal})`,
        'All fonts are embedded in the PDF.'));
    } else {
      out.push(f('fonts', 'font', 'error', 'Fonts not embedded',
        `Some fonts are not embedded: ${a.scan.fontsNotEmbedded.slice(0, 5).join(', ')}${a.scan.fontsNotEmbedded.length > 5 ? ', etc.' : ''}. They may be garbled or substituted at the shop. Embed the fonts or convert to outlines.`,
        { count: a.scan.fontsNotEmbedded.length, markerKind: mk('font'), pages: mkPages('font').length ? mkPages('font') : undefined }));
    }
  }

  // =====================================================================
  // 6. Other
  // =====================================================================
  if (a.kind === 'pdf' && a.scan && a.content) {
    if (a.scan.encrypted) {
      out.push(f('encrypted', 'other', 'error', 'Security (encryption) set',
        'Password- or edit-restricted PDFs cannot be processed by the shop. Export without security.'));
    }
    if (a.scan.transparencyUsed) {
      out.push(f('transparency', 'other', 'info', 'Transparency used',
        'Transparency effects (drop shadows, etc.) are used. Many shops flatten transparency under a PDF/X-1a workflow. Faint white lines (flattening seams) may occasionally show in the preview but usually don\'t print. If concerned, ask the shop whether PDF/X-4 is accepted.'));
    }
    if (a.scan.hasAnnotsOrForms) {
      out.push(f('annots', 'other', 'warning', 'Annotations / form fields present',
        'PDF annotations and forms may not print, or may print unintentionally. Flatten or remove them.'));
    }
    if (a.scan.hasLayers) {
      out.push(f('layers', 'other', 'info', 'Layers (OCG) present',
        'If hidden layers are included, the shop\'s RIP may output them unexpectedly. Flatten layers when exporting.'));
    }
    if (a.content.hairlineCount > 0) {
      out.push(f('hairline', 'other', 'warning', 'Hairlines',
        `Detected ${a.content.hairlineCount} rule(s) thinner than 0.25pt. They may disappear or print faint. Use 0.25pt (about 0.09mm) or thicker.`,
        { count: a.content.hairlineCount, markerKind: mk('hairline') }));
    }
    if (a.scan.pdfVersion) {
      const v = parseFloat(a.scan.pdfVersion);
      out.push(f('pdf-version', 'other', v >= 1.3 ? 'info' : 'warning',
        `PDF version: ${a.scan.pdfVersion}`,
        v >= 1.3 ? 'A version supported by common print workflows.'
          : 'A very old PDF version. Re-exporting is recommended.'));
    }
  }

  for (const n of a.notes) {
    out.push(f(`note-${out.length}`, 'other', 'info', 'Analysis note', n));
  }

  return out;
}
