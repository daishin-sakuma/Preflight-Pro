'use client';

// 2D proof view: rendered page + guide overlays (bleed / trim / text-safe),
// TAC heat map, and low-resolution image markers.

import { useEffect, useRef } from 'react';
import type { AnalysisResult, Settings } from '@/lib/types';
import { PT_PER_MM } from '@/lib/types';
import { paperSizeMm } from '@/lib/presets';

interface Props {
  result: AnalysisResult;
  settings: Settings;
  pageIdx: number;
  showTac: boolean;
  showGuides: boolean;
}

export default function Preview2D({ result, settings, pageIdx, showTac, showGuides }: Props) {
  const baseRef = useRef<HTMLCanvasElement>(null);
  const overRef = useRef<HTMLCanvasElement>(null);
  const wrapRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const src = result.previews[pageIdx];
    const base = baseRef.current, over = overRef.current;
    if (!src || !base || !over) return;

    base.width = src.width; base.height = src.height;
    over.width = src.width; over.height = src.height;
    base.getContext('2d')!.drawImage(src, 0, 0);

    const ctx = over.getContext('2d')!;
    ctx.clearRect(0, 0, over.width, over.height);

    const geom = result.pages[pageIdx];
    if (!geom) return;
    const s = result.renderScale;
    const vb = geom.viewBoxPt ?? geom.mediaBoxPt;

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

    if (showGuides) {
      // trim box: explicit, or assumed centered ordered-size
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

      if (trim) {
        const t = rectPx(trim);
        // bleed zone shading (outside trim)
        ctx.save();
        ctx.fillStyle = 'rgba(40, 110, 240, 0.18)';
        ctx.beginPath();
        ctx.rect(0, 0, over.width, over.height);
        ctx.rect(t.x, t.y, t.w, t.h);
        ctx.fill('evenodd');
        ctx.restore();

        // trim line (finished cut)
        ctx.strokeStyle = '#e11d48';
        ctx.setLineDash([8, 5]);
        ctx.lineWidth = 2;
        ctx.strokeRect(t.x, t.y, t.w, t.h);

        // text-safe area
        const inset = settings.safeMarginMm * PT_PER_MM * s;
        ctx.strokeStyle = '#0d9488';
        ctx.setLineDash([3, 5]);
        ctx.lineWidth = 1.5;
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
        ctx.lineWidth = 2.5;
        ctx.strokeRect(x, y, wpx, hpx);
        const label = `${im.effectiveDpi}dpi`;
        ctx.font = 'bold 13px sans-serif';
        const tw = ctx.measureText(label).width + 10;
        ctx.fillStyle = '#dc2626';
        ctx.fillRect(x, Math.max(0, y - 19), tw, 19);
        ctx.fillStyle = '#fff';
        ctx.fillText(label, x + 5, Math.max(13, y - 5));
      }
    }
  }, [result, settings, pageIdx, showTac, showGuides]);

  return (
    <div className="stage2d" ref={wrapRef}>
      <div style={{ position: 'relative', maxWidth: '92%', maxHeight: '92%', display: 'flex' }}>
        <canvas
          ref={baseRef}
          className="flat"
          style={{ maxWidth: '100%', maxHeight: '520px', width: 'auto', height: 'auto' }}
        />
        <canvas
          ref={overRef}
          className="overlayBox"
          style={{ inset: 0, width: '100%', height: '100%' }}
        />
      </div>
    </div>
  );
}
