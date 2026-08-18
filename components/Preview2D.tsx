'use client';

// 2D proof view with zoom/pan. Overlay drawing (guides / dims / TAC heat /
// markers) lives in lib/overlay.ts, shared with the 3D preview compositor.

import { useCallback, useEffect, useRef, useState } from 'react';
import type { AnalysisResult, MarkerKind, Settings } from '@/lib/types';
import { renderOverlays, MARKER_STYLE } from '@/lib/overlay';

export { MARKER_STYLE };

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
  const viewportRef = useRef<HTMLDivElement>(null);
  const layerRef = useRef<HTMLDivElement>(null);

  // zoom/pan state (imperative for smooth wheel handling; % mirrored to React)
  const view = useRef({ z: 1, fitZ: 1, tx: 0, ty: 0 });
  const [pct, setPct] = useState(100);
  const drag = useRef<{ x: number; y: number } | null>(null);

  const apply = useCallback(() => {
    const l = layerRef.current;
    if (!l) return;
    const v = view.current;
    l.style.transform = `translate(${v.tx}px, ${v.ty}px) scale(${v.z})`;
    setPct(Math.round((v.z / (v.fitZ || 1)) * 100));
  }, []);

  // fit the page into the viewport (= 100%)
  const fit = useCallback(() => {
    const vp = viewportRef.current, base = baseRef.current, l = layerRef.current;
    if (!vp || !base || !l) return;
    const vw = vp.clientWidth, vh = vp.clientHeight;
    const cw = base.width, ch = base.height;
    if (!vw || !vh || !cw || !ch) return;
    const z = Math.min(vw / cw, vh / ch) * 0.92;
    view.current = { z, fitZ: z, tx: (vw - cw * z) / 2, ty: (vh - ch * z) / 2 };
    l.style.width = `${cw}px`;
    l.style.height = `${ch}px`;
    apply();
  }, [apply]);

  // zoom keeping the given viewport point fixed (cursor-centered for wheel)
  const zoomAt = useCallback((px: number, py: number, factor: number) => {
    const v = view.current;
    const nz = Math.min(v.fitZ * 12, Math.max(v.fitZ * 0.15, v.z * factor));
    const cx = (px - v.tx) / v.z;
    const cy = (py - v.ty) / v.z;
    v.tx = px - cx * nz;
    v.ty = py - cy * nz;
    v.z = nz;
    apply();
  }, [apply]);

  const zoomButtons = useCallback((factor: number) => {
    const vp = viewportRef.current;
    if (!vp) return;
    zoomAt(vp.clientWidth / 2, vp.clientHeight / 2, factor);
  }, [zoomAt]);

  // wheel: native non-passive listener (React's onWheel can't preventDefault)
  useEffect(() => {
    const vp = viewportRef.current;
    if (!vp) return;
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      const r = vp.getBoundingClientRect();
      const factor = Math.exp(-e.deltaY * (e.deltaMode === 1 ? 0.045 : 0.0016));
      zoomAt(e.clientX - r.left, e.clientY - r.top, factor);
    };
    vp.addEventListener('wheel', onWheel, { passive: false });
    return () => vp.removeEventListener('wheel', onWheel);
  }, [zoomAt]);

  // refit when the viewport resizes (page-change refit happens in the draw
  // effect below, after the canvases have been resized)
  useEffect(() => {
    const vp = viewportRef.current;
    if (!vp || typeof ResizeObserver === 'undefined') return;
    const ro = new ResizeObserver(() => fit());
    ro.observe(vp);
    return () => ro.disconnect();
  }, [fit]);

  const lastPageKey = useRef('');

  useEffect(() => {
    const src = result.previews[pageIdx];
    const base = baseRef.current, over = overRef.current;
    if (!src || !base || !over) return;

    base.width = src.width; base.height = src.height;
    over.width = src.width; over.height = src.height;
    base.getContext('2d')!.drawImage(src, 0, 0);

    // refit only when a different page/file is shown (keeps zoom across toggles)
    const pageKey = `${result.fileName}:${pageIdx}:${src.width}x${src.height}`;
    if (pageKey !== lastPageKey.current) {
      lastPageKey.current = pageKey;
      fit();
    }

    over.getContext('2d')!.clearRect(0, 0, over.width, over.height);
    renderOverlays(over, { result, settings, pageIdx, showTac, showGuides, showDims, markerKind });
  }, [result, settings, pageIdx, showTac, showGuides, showDims, markerKind, fit]);


  return (
    <div
      className="stage2d zoomable"
      ref={viewportRef}
      onPointerDown={(e) => {
        if (e.button !== 0) return;
        drag.current = { x: e.clientX, y: e.clientY };
        (e.currentTarget as HTMLDivElement).setPointerCapture(e.pointerId);
      }}
      onPointerMove={(e) => {
        if (!drag.current) return;
        view.current.tx += e.clientX - drag.current.x;
        view.current.ty += e.clientY - drag.current.y;
        drag.current = { x: e.clientX, y: e.clientY };
        apply();
      }}
      onPointerUp={() => { drag.current = null; }}
      onPointerCancel={() => { drag.current = null; }}
    >
      <div className="zoomLayer" ref={layerRef}>
        <canvas ref={baseRef} style={{ display: 'block', background: '#fff' }} />
        <canvas
          ref={overRef}
          className="overlayBox"
          style={{ inset: 0, width: '100%', height: '100%' }}
        />
      </div>
      <div className="zoomCtl" onPointerDown={(e) => e.stopPropagation()}>
        <button title="ズームアウト" onClick={() => zoomButtons(1 / 1.3)}>−</button>
        <span className="zoomPct">{pct}%</span>
        <button title="ズームイン" onClick={() => zoomButtons(1.3)}>＋</button>
        <button title="全体表示に戻す" onClick={fit}>全体</button>
      </div>
    </div>
  );
}
