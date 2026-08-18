'use client';

// 2D proof view: rendered page + guide overlays (bleed / trim / text-safe),
// TAC heat map, low-resolution image markers, and problem-spot markers
// (RGB / white-overprint / TAC-over / rich-black text / hairline).

import { useEffect, useRef } from 'react';
import type { AnalysisResult, MarkerKind, Settings } from '@/lib/types';
import { PT_PER_MM } from '@/lib/types';
import { paperSizeMm } from '@/lib/presets';

export const MARKER_STYLE: Record<MarkerKind, { color: string; label: string }> = {
  rgb: { color: '#ff9f43', label: 'RGB' },
  'white-op': { color: '#ff4fd8', label: '白ノセ疑い' },
  tac: { color: '#a78bfa', label: 'インキ量超過' },
  'rich-black': { color: '#facc15', label: 'リッチブラック文字' },
  hairline: { color: '#38bdf8', label: '極細線' },
};

interface Props {
  result: AnalysisResult;
  settings: Settings;
  pageIdx: number;
  showTac: boolean;
  showGuides: boolean;
  showDims: boolean;               // dimension annotations (寸法表示)
  markerKind: MarkerKind | null;   // active problem-spot overlay
}

export default function Preview2D({ result, settings, pageIdx, showTac, showGuides, showDims, markerKind }: Props) {
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

    if (showGuides) {
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

    // ---- dimension annotations (寸法表示) ----
    if (showDims) {
      const mm = (pt: number) => {
        const v = pt * (25.4 / 72);
        return (Math.round(v * 10) / 10).toLocaleString('ja-JP');
      };
      const chip = (x: number, y: number, text: string, color: string) => {
        ctx.font = 'bold 14px sans-serif';
        const w = ctx.measureText(text).width + 12, h = 21;
        const bx = Math.max(2, Math.min(x - w / 2, over.width - w - 2));
        const by = Math.max(2, Math.min(y - h / 2, over.height - h - 2));
        ctx.fillStyle = color;
        ctx.beginPath();
        ctx.roundRect(bx, by, w, h, 4);
        ctx.fill();
        ctx.fillStyle = '#fff';
        ctx.textBaseline = 'middle';
        ctx.fillText(text, bx + 6, by + h / 2 + 0.5);
        ctx.textBaseline = 'alphabetic';
      };
      const dimLine = (x1: number, y1: number, x2: number, y2: number, color: string) => {
        ctx.strokeStyle = color; ctx.fillStyle = color; ctx.lineWidth = 1.5;
        ctx.beginPath(); ctx.moveTo(x1, y1); ctx.lineTo(x2, y2); ctx.stroke();
        const head = (x: number, y: number, dx: number, dy: number) => {
          const l = Math.hypot(dx, dy) || 1; dx /= l; dy /= l;
          ctx.beginPath();
          ctx.moveTo(x, y);
          ctx.lineTo(x + dx * 9 - dy * 3.5, y + dy * 9 + dx * 3.5);
          ctx.lineTo(x + dx * 9 + dy * 3.5, y + dy * 9 - dx * 3.5);
          ctx.closePath(); ctx.fill();
        };
        head(x1, y1, x2 - x1, y2 - y1);
        head(x2, y2, x1 - x2, y1 - y2);
      };

      const TRIM_C = '#e11d48', BLEED_C = '#2f6fd6', SAFE_C = '#0d9488', DATA_C = '#3f434d';

      if (trim) {
        const t = rectPx(trim);
        const trimWpt = trim[2] - trim[0];
        const trimHpt = trim[3] - trim[1];
        // 仕上がり width (top, inside the trim)
        const wy = t.y + 26;
        dimLine(t.x, wy, t.x + t.w, wy, TRIM_C);
        chip(t.x + t.w / 2, wy, `仕上がり ${mm(trimWpt)}mm`, TRIM_C);
        // 仕上がり height (left, inside the trim)
        const hx = t.x + 26;
        dimLine(hx, t.y, hx, t.y + t.h, TRIM_C);
        chip(hx + 6, t.y + t.h / 2, `${mm(trimHpt)}mm`, TRIM_C);

        // 塗り足し widths (actual measured distances trim -> page edge)
        const bTopPt = vb[3] - trim[3];
        const bLeftPt = trim[0] - vb[0];
        if (bTopPt * (25.4 / 72) > 0.3) {
          const bx = t.x + t.w - 60;
          dimLine(bx, 0, bx, t.y, BLEED_C);
          chip(bx, t.y + 16, `塗り足し ${mm(bTopPt)}mm`, BLEED_C);
        }
        if (bLeftPt * (25.4 / 72) > 0.3) {
          const by = t.y + t.h - 60;
          dimLine(0, by, t.x, by, BLEED_C);
          chip(t.x + 40, by, `${mm(bLeftPt)}mm`, BLEED_C);
        }

        // 安全域 label (on the safe-area line)
        const inset = settings.safeMarginMm * PT_PER_MM * s;
        chip(t.x + t.w / 2, t.y + inset + 14, `文字安全域 (仕上がりから${settings.safeMarginMm}mm内側)`, SAFE_C);
      }

      // データ全体サイズ (bottom center)
      chip(over.width / 2, over.height - 16,
        `データサイズ ${mm(vb[2] - vb[0])}×${mm(vb[3] - vb[1])}mm${trim ? ' (塗り足し込み)' : ''}`, DATA_C);
    }

    // ---- problem-spot markers (該当箇所の表示) ----
    if (markerKind) {
      const style = MARKER_STYLE[markerKind];
      const spots = (result.markers ?? []).filter(
        (m) => m.kind === markerKind && m.page === pageIdx + 1,
      );
      for (const m of spots) {
        const [x, yBottom] = toPx(m.rectPt.x, m.rectPt.y);
        const wpx = Math.max(m.rectPt.w * s, 6);
        const hpx = Math.max(m.rectPt.h * s, 6);
        const y = yBottom - hpx;
        // dim everything except a halo? keep simple: strong outlined rect + label
        ctx.save();
        ctx.strokeStyle = style.color;
        ctx.lineWidth = 3;
        ctx.setLineDash(m.point ? [4, 4] : []);
        ctx.strokeRect(x, y, wpx, hpx);
        ctx.setLineDash([]);
        // corner tick for visibility on busy artwork
        ctx.fillStyle = style.color;
        ctx.beginPath();
        ctx.arc(x, y, 4.5, 0, Math.PI * 2);
        ctx.fill();
        const label = m.label ?? style.label;
        ctx.font = 'bold 12px sans-serif';
        const tw = ctx.measureText(label).width + 10;
        ctx.fillRect(x, Math.max(0, y - 18), tw, 18);
        ctx.fillStyle = '#1a1a1a';
        ctx.fillText(label, x + 5, Math.max(13, y - 5));
        ctx.restore();
      }
    }
  }, [result, settings, pageIdx, showTac, showGuides, showDims, markerKind]);

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
