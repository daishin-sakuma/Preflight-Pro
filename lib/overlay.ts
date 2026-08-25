// Shared overlay renderer: guides (bleed / trim / safe area), dimension
// annotations, TAC heat, low-dpi image markers, and problem-spot callouts.
// Used by the 2D proof view (transparent overlay canvas) AND the 3D preview
// (composited on top of the artwork before texturing the paper mesh).

import type { AnalysisResult, MarkerKind, Settings } from './types.ts';
import { PT_PER_MM, pageRenderScale } from './types.ts';
import { paperSizeMm } from './presets.ts';

export const MARKER_STYLE: Record<MarkerKind, { color: string; label: string }> = {
  rgb: { color: '#ff9f43', label: 'RGB' },
  'white-op': { color: '#ff4fd8', label: 'White overprint' },
  tac: { color: '#a78bfa', label: 'Ink over limit' },
  'rich-black': { color: '#facc15', label: 'Rich-black text' },
  hairline: { color: '#38bdf8', label: 'Hairline' },
  font: { color: '#ff6161', label: 'Unembedded font' },
  overprint: { color: '#2dd4bf', label: 'Overprint' },
  lowres: { color: '#dc2626', label: 'Low-resolution image' },
  'four-color': { color: '#84cc16', label: '4-color solid' },
  'three-color': { color: '#f59e0b', label: 'Dense 3-color' },
  spot: { color: '#22d3ee', label: 'Spot color' },
};

export interface OverlayArgs {
  result: AnalysisResult;
  settings: Settings;
  pageIdx: number;
  showTac: boolean;
  showGuides: boolean;
  showDims: boolean;
  showBleed: boolean;       // bleed-zone shading + bleed dimension chips
  markerKind: MarkerKind | null;
  scaleOverride?: number;   // px-per-pt of the target canvas (for hi-res re-renders)
}

// Draws overlays onto `over` (does NOT clear it — the 2D view clears its
// transparent overlay first; the 3D compositor draws on top of the artwork).
export function renderOverlays(over: HTMLCanvasElement, args: OverlayArgs): void {
  const { result, settings, pageIdx, showTac, showGuides, showDims, showBleed, markerKind } = args;
  const ctx = over.getContext('2d')!;
    const geom = result.pages[pageIdx];
    if (!geom) return;
    const s = args.scaleOverride ?? pageRenderScale(result, pageIdx);
    const vb = geom.viewBoxPt ?? geom.mediaBoxPt;

    // UI scale for overlay text/lines: canvases now render at ~2200px long edge
    // (page-size independent), so annotation sizes are normalized to a 1500px
    // baseline to keep them readable at fit view.
    const ui = Math.max(1, Math.max(over.width, over.height) / 1500);

    const toPx = (xPt: number, yPt: number): [number, number] => [
      (xPt - vb[0]) * s,
      over.height - (yPt - vb[1]) * s,
    ];
    const rectPx = (b: [number, number, number, number]) => {
      const [x0, y1] = toPx(b[0], b[1]);
      const [x1, y0] = toPx(b[2], b[3]);
      return { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
    };

    // ---- TAC heat ----
    if (showTac) {
      const heat = result.tac[pageIdx]?.heat;
      if (heat) {
        const tmp = document.createElement('canvas');
        tmp.width = heat.width; tmp.height = heat.height;
        tmp.getContext('2d')!.putImageData(heat, 0, 0);
        ctx.drawImage(tmp, 0, 0, over.width, over.height);
      }
    }

    // trim box: explicit, or assumed centered ordered-size (shared by guides & dims)
    let trim = geom.trimBoxPt as [number, number, number, number] | undefined;
    if (!trim) {
      const paper = paperSizeMm(settings.paperId, settings.customWmm, settings.customHmm, settings.landscape);
      const wPt = paper.wMm * PT_PER_MM, hPt = paper.hMm * PT_PER_MM;
      const pw = vb[2] - vb[0], ph = vb[3] - vb[1];
      const fits = (pw - wPt) >= -1 && (ph - hPt) >= -1 && (pw - wPt) < 30 * PT_PER_MM;
      if (fits) {
        const mx = (pw - wPt) / 2, my = (ph - hPt) / 2;
        trim = [vb[0] + mx, vb[1] + my, vb[2] - mx, vb[3] - my];
      }
    }

    // bleed zone shading (outside trim) — its own toggle
    if (showBleed && trim) {
      const t = rectPx(trim);
      ctx.save();
      ctx.fillStyle = 'rgba(40, 110, 240, 0.18)';
      ctx.beginPath();
      ctx.rect(0, 0, over.width, over.height);
      ctx.rect(t.x, t.y, t.w, t.h);
      ctx.fill('evenodd');
      ctx.restore();
    }

    if (showGuides) {
      if (trim) {
        const t = rectPx(trim);
        // trim line (finished cut)
        ctx.strokeStyle = '#e11d48';
        ctx.setLineDash([8 * ui, 5 * ui]);
        ctx.lineWidth = 2 * ui;
        ctx.strokeRect(t.x, t.y, t.w, t.h);

        // text-safe area
        const inset = settings.safeMarginMm * PT_PER_MM * s;
        ctx.strokeStyle = '#0d9488';
        ctx.setLineDash([3 * ui, 5 * ui]);
        ctx.lineWidth = 1.5 * ui;
        ctx.strokeRect(t.x + inset, t.y + inset, t.w - inset * 2, t.h - inset * 2);
        ctx.setLineDash([]);
      }

      // low-dpi image markers
      for (const im of result.images) {
        if (im.page !== pageIdx + 1 || !im.rectPt) continue;
        if (im.effectiveDpi >= settings.minDpi) continue;
        if (im.printWidthMm <= 5 || im.printHeightMm <= 5) continue;
        const [x, yBottom] = toPx(im.rectPt.x, im.rectPt.y);
        const wpx = im.rectPt.w * s, hpx = im.rectPt.h * s;
        const y = yBottom - hpx;
        ctx.strokeStyle = '#dc2626';
        ctx.lineWidth = 2.5 * ui;
        ctx.strokeRect(x, y, wpx, hpx);
        const label = `${im.effectiveDpi}dpi`;
        ctx.font = `bold ${13 * ui}px sans-serif`;
        const tw = ctx.measureText(label).width + 10 * ui;
        ctx.fillStyle = '#dc2626';
        ctx.fillRect(x, Math.max(0, y - 19 * ui), tw, 19 * ui);
        ctx.fillStyle = '#fff';
        ctx.fillText(label, x + 5 * ui, Math.max(13 * ui, y - 5 * ui));
      }
    }

    // ---- dimension annotations (寸法表示) ----
    if (showDims || showBleed) {
      const mm = (pt: number) => {
        const v = pt * (25.4 / 72);
        return (Math.round(v * 10) / 10).toLocaleString('en-US');
      };
      const chip = (x: number, y: number, text: string, color: string) => {
        ctx.font = `bold ${14 * ui}px sans-serif`;
        const w = ctx.measureText(text).width + 12 * ui, h = 21 * ui;
        const bx = Math.max(2, Math.min(x - w / 2, over.width - w - 2));
        const by = Math.max(2, Math.min(y - h / 2, over.height - h - 2));
        ctx.fillStyle = color;
        ctx.beginPath();
        ctx.roundRect(bx, by, w, h, 4 * ui);
        ctx.fill();
        ctx.fillStyle = '#fff';
        ctx.textBaseline = 'middle';
        ctx.fillText(text, bx + 6 * ui, by + h / 2 + 0.5);
        ctx.textBaseline = 'alphabetic';
      };
      const dimLine = (x1: number, y1: number, x2: number, y2: number, color: string) => {
        ctx.strokeStyle = color; ctx.fillStyle = color; ctx.lineWidth = 1.5 * ui;
        ctx.beginPath(); ctx.moveTo(x1, y1); ctx.lineTo(x2, y2); ctx.stroke();
        const head = (x: number, y: number, dx: number, dy: number) => {
          const l = Math.hypot(dx, dy) || 1; dx /= l; dy /= l;
          ctx.beginPath();
          ctx.moveTo(x, y);
          ctx.lineTo(x + dx * 9 * ui - dy * 3.5 * ui, y + dy * 9 * ui + dx * 3.5 * ui);
          ctx.lineTo(x + dx * 9 * ui + dy * 3.5 * ui, y + dy * 9 * ui - dx * 3.5 * ui);
          ctx.closePath(); ctx.fill();
        };
        head(x1, y1, x2 - x1, y2 - y1);
        head(x2, y2, x1 - x2, y1 - y2);
      };

      const TRIM_C = '#e11d48', BLEED_C = '#2f6fd6', SAFE_C = '#0d9488', DATA_C = '#3f434d';

      if (trim) {
        const t = rectPx(trim);
        if (showDims) {
          const trimWpt = trim[2] - trim[0];
          const trimHpt = trim[3] - trim[1];
          // trim width (top, inside the trim)
          const wy = t.y + 26 * ui;
          dimLine(t.x, wy, t.x + t.w, wy, TRIM_C);
          chip(t.x + t.w / 2, wy, `Trim ${mm(trimWpt)}mm`, TRIM_C);
          // trim height (left, inside the trim)
          const hx = t.x + 26 * ui;
          dimLine(hx, t.y, hx, t.y + t.h, TRIM_C);
          chip(hx + 6 * ui, t.y + t.h / 2, `${mm(trimHpt)}mm`, TRIM_C);

          // safe-area label (on the safe-area line)
          const inset = settings.safeMarginMm * PT_PER_MM * s;
          chip(t.x + t.w / 2, t.y + inset + 14 * ui, `Safe area (${settings.safeMarginMm}mm inside trim)`, SAFE_C);
        }

        // bleed widths (actual measured distances trim -> page edge) — own toggle
        if (showBleed) {
          const bTopPt = vb[3] - trim[3];
          const bLeftPt = trim[0] - vb[0];
          if (bTopPt * (25.4 / 72) > 0.3) {
            const bx = t.x + t.w - 60 * ui;
            dimLine(bx, 0, bx, t.y, BLEED_C);
            chip(bx, t.y + 16 * ui, `Bleed ${mm(bTopPt)}mm`, BLEED_C);
          }
          if (bLeftPt * (25.4 / 72) > 0.3) {
            const by = t.y + t.h - 60 * ui;
            dimLine(0, by, t.x, by, BLEED_C);
            chip(t.x + 40 * ui, by, `${mm(bLeftPt)}mm`, BLEED_C);
          }
        }
      }

      // full data size (bottom center)
      if (showDims) {
        chip(over.width / 2, over.height - 16 * ui,
          `Data size ${mm(vb[2] - vb[0])}×${mm(vb[3] - vb[1])}mm${trim ? ' (incl. bleed)' : ''}`, DATA_C);
      }
    }

    // ---- problem-spot markers: callout chips with leader arrows (該当箇所) ----
    if (markerKind) {
      const style = MARKER_STYLE[markerKind];
      const spots = (result.markers ?? []).filter(
        (m) => m.kind === markerKind && m.page === pageIdx + 1,
      );
      const drawArrow = (fx: number, fy: number, txx: number, tyy: number) => {
        const dx = txx - fx, dy = tyy - fy;
        const len = Math.hypot(dx, dy) || 1;
        const ux = dx / len, uy = dy / len;
        // shorten so the head tip lands exactly on the target
        const ex = txx - ux * 4 * ui, ey = tyy - uy * 4 * ui;
        ctx.strokeStyle = style.color;
        ctx.lineWidth = 2.5 * ui;
        ctx.beginPath(); ctx.moveTo(fx, fy); ctx.lineTo(ex, ey); ctx.stroke();
        ctx.fillStyle = style.color;
        ctx.beginPath();
        ctx.moveTo(txx, tyy);
        ctx.lineTo(txx - ux * 13 * ui - uy * 5.5 * ui, tyy - uy * 13 * ui + ux * 5.5 * ui);
        ctx.lineTo(txx - ux * 13 * ui + uy * 5.5 * ui, tyy - uy * 13 * ui - ux * 5.5 * ui);
        ctx.closePath(); ctx.fill();
      };

      for (const m of spots) {
        const [x, yBottom] = toPx(m.rectPt.x, m.rectPt.y);
        const wpx = Math.max(m.rectPt.w * s, 6 * ui);
        const hpx = Math.max(m.rectPt.h * s, 6 * ui);
        const y = yBottom - hpx;
        ctx.save();

        // outline the spot (dashed = approximate text position)
        ctx.strokeStyle = style.color;
        ctx.lineWidth = 3 * ui;
        ctx.setLineDash(m.point ? [5 * ui, 4 * ui] : []);
        ctx.strokeRect(x, y, wpx, hpx);
        ctx.setLineDash([]);

        // label chip placed away from the spot, with an arrow pointing at it
        const label = m.label ?? style.label;
        ctx.font = `bold ${13 * ui}px sans-serif`;
        const tw = ctx.measureText(label).width + 12 * ui, th = 20 * ui;
        let cxp = x - tw - 26 * ui;                       // prefer upper-left
        let cyp = y - th - 20 * ui;
        if (cxp < 4) cxp = Math.min(x + wpx + 26 * ui, over.width - tw - 4); // flip right
        if (cyp < 4) cyp = Math.min(y + hpx + 20 * ui, over.height - th - 4); // flip below
        // leader: from the chip edge to the nearest point on the spot rect
        const chipCx = cxp + tw / 2, chipCy = cyp + th / 2;
        const ax = Math.max(x, Math.min(chipCx, x + wpx));
        const ay = Math.max(y, Math.min(chipCy, y + hpx));
        const sx = Math.max(cxp, Math.min(ax, cxp + tw));
        const sy = chipCy < ay ? cyp + th : cyp;
        drawArrow(sx, sy, ax, ay);

        ctx.fillStyle = style.color;
        ctx.beginPath();
        ctx.roundRect(cxp, cyp, tw, th, 4 * ui);
        ctx.fill();
        ctx.fillStyle = '#141414';
        ctx.textBaseline = 'middle';
        ctx.fillText(label, cxp + 6 * ui, cyp + th / 2 + 0.5);
        ctx.textBaseline = 'alphabetic';
        ctx.restore();
      }
    }
}
