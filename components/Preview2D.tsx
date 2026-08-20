'use client';

// 2D proof view with zoom/pan. Overlay drawing (guides / dims / TAC heat /
// markers) lives in lib/overlay.ts, shared with the 3D preview compositor.
//
// Deep zoom stays crisp: instead of upscaling a fixed bitmap (jagged/blurry),
// the current PDF page is re-rendered at a higher resolution on demand, bounded
// by a pixel budget. On-screen geometry is preserved across resolution swaps.
//
// `finished` mode (all overlays off) crops to the trim box so the 2D view shows
// the trimmed finished piece — matching the 3D preview's behaviour.

import { forwardRef, useCallback, useEffect, useImperativeHandle, useRef, useState } from 'react';
import type { AnalysisResult, MarkerKind, PageGeom, Settings } from '@/lib/types';
import { renderOverlays, MARKER_STYLE } from '@/lib/overlay';

export { MARKER_STYLE };

export interface Preview2DHandle {
  zoomIn(): void;
  zoomOut(): void;
  fit(): void;
}

interface Props {
  result: AnalysisResult;
  settings: Settings;
  pageIdx: number;
  showTac: boolean;
  showGuides: boolean;
  showDims: boolean;               // dimension annotations (寸法表示)
  markerKind: MarkerKind | null;   // active problem-spot overlay
  finished: boolean;               // all overlays off → show the trimmed finished piece
}

// max pixels a re-rendered page canvas may use (~96MB at 4 bytes/px)
const PIXEL_BUDGET = 24_000_000;

// crop a full-page canvas (rendered at `scale` px/pt) to its trim box
function cropToTrim(src: HTMLCanvasElement, geom: PageGeom, scale: number): HTMLCanvasElement {
  const trim = geom.trimBoxPt;
  if (!trim) return src;
  const vb = geom.viewBoxPt ?? geom.mediaBoxPt;
  const x = (trim[0] - vb[0]) * scale;
  const w = (trim[2] - trim[0]) * scale;
  const h = (trim[3] - trim[1]) * scale;
  const y = src.height - (trim[3] - vb[1]) * scale;
  const out = document.createElement('canvas');
  out.width = Math.max(2, Math.round(w));
  out.height = Math.max(2, Math.round(h));
  out.getContext('2d')!.drawImage(src, x, y, w, h, 0, 0, out.width, out.height);
  return out;
}

const Preview2D = forwardRef<Preview2DHandle, Props>(function Preview2D(
  { result, settings, pageIdx, showTac, showGuides, showDims, markerKind, finished }, ref,
) {
  const baseRef = useRef<HTMLCanvasElement>(null);
  const overRef = useRef<HTMLCanvasElement>(null);
  const viewportRef = useRef<HTMLDivElement>(null);
  const layerRef = useRef<HTMLDivElement>(null);

  // zoom/pan state (imperative for smooth wheel handling; % mirrored to React)
  const view = useRef({ z: 1, fitZ: 1, tx: 0, ty: 0 });
  const [pct, setPct] = useState(100);
  const drag = useRef<{ x: number; y: number } | null>(null);

  // current displayed resolution (px per pt). Mirrored to state so the draw
  // effect redraws at the right scale after a re-render swaps the base bitmap.
  const srcScale = useRef(result.renderScale);
  const [loadedScale, setLoadedScale] = useState(result.renderScale);
  const hiResCanvas = useRef<HTMLCanvasElement | null>(null); // current full-page hi-res render (or null = base preview)
  const hiResToken = useRef(0);                               // cancels stale async renders
  const hiResTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const smoothTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  // toggle a CSS transition on the zoom layer so button-driven zoom/fit eases
  // over the standard duration, while wheel/drag stay instant.
  const setSmooth = useCallback((on: boolean) => {
    const l = layerRef.current;
    if (l) l.style.transition = on ? 'transform var(--dur) ease' : 'none';
  }, []);

  const apply = useCallback(() => {
    const l = layerRef.current;
    if (!l) return;
    const v = view.current;
    l.style.transform = `translate(${v.tx}px, ${v.ty}px) scale(${v.z})`;
    setPct(Math.round((v.z / (v.fitZ || 1)) * 100));
  }, []);

  // fit the currently displayed canvas into the viewport (= 100%)
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

  // highest scale (px per pt) allowed for this page within the pixel budget
  const maxScale = useCallback(() => {
    const g = result.pages[pageIdx];
    const wPt = g?.widthPt || 600, hPt = g?.heightPt || 600;
    return Math.max(result.renderScale, Math.min(60, Math.sqrt(PIXEL_BUDGET / (wPt * hPt))));
  }, [result, pageIdx]);

  // after zoom settles, re-render the page sharper (or drop back to the base
  // preview when zoomed out) so what's on screen is never an upscaled bitmap.
  const scheduleHiRes = useCallback(() => {
    if (!result.renderPage) return; // images / no re-render available
    if (hiResTimer.current) clearTimeout(hiResTimer.current);
    hiResTimer.current = setTimeout(async () => {
      const dpr = typeof window !== 'undefined' ? window.devicePixelRatio || 1 : 1;
      const onScreenPxPerPt = view.current.z * srcScale.current; // invariant across swaps
      const target = Math.max(result.renderScale, Math.min(maxScale(), onScreenPxPerPt * dpr));
      const cur = srcScale.current;
      const wantUp = target > cur * 1.25;
      const wantDown = target < result.renderScale * 1.05 && cur > result.renderScale * 1.05;
      if (!wantUp && !wantDown) return;
      const token = ++hiResToken.current;
      if (wantDown) {
        const f = result.renderScale / srcScale.current;
        view.current.z /= f; view.current.fitZ /= f;
        srcScale.current = result.renderScale;
        hiResCanvas.current = null;
        setLoadedScale(result.renderScale);
        return;
      }
      const canvas = await result.renderPage!(pageIdx, target);
      if (!canvas || token !== hiResToken.current) return; // stale (zoomed again / changed page)
      const f = target / srcScale.current;
      view.current.z /= f; view.current.fitZ /= f;
      srcScale.current = target;
      hiResCanvas.current = canvas;
      setLoadedScale(target);
    }, 160);
  }, [result, pageIdx, maxScale]);

  // zoom keeping the given viewport point fixed (cursor-centered for wheel)
  const zoomAt = useCallback((px: number, py: number, factor: number, smooth = false) => {
    const v = view.current;
    const nz = Math.min(v.fitZ * 12, Math.max(v.fitZ * 0.15, v.z * factor));
    const cx = (px - v.tx) / v.z;
    const cy = (py - v.ty) / v.z;
    v.tx = px - cx * nz;
    v.ty = py - cy * nz;
    v.z = nz;
    setSmooth(smooth);
    apply();
    if (smooth) {
      if (smoothTimer.current) clearTimeout(smoothTimer.current);
      smoothTimer.current = setTimeout(() => { setSmooth(false); scheduleHiRes(); }, 320);
    } else {
      scheduleHiRes();
    }
  }, [apply, scheduleHiRes, setSmooth]);

  // Button zoom: snap onto a 10% grid (relative to fit = 100%) and move exactly
  // one 10-point step, so repeated presses read 100 → 110 → 120 … with no drift
  // (a multiplicative factor would compound: 110 → 121 → 133 …).
  const zoomStep = useCallback((dir: 1 | -1) => {
    const vp = viewportRef.current;
    if (!vp) return;
    const v = view.current;
    const STEP = 10;
    const curPct = (v.z / (v.fitZ || 1)) * 100;
    let target = dir > 0
      ? (Math.floor(curPct / STEP + 1e-6) + 1) * STEP
      : (Math.ceil(curPct / STEP - 1e-6) - 1) * STEP;
    target = Math.min(1200, Math.max(15, target)); // matches zoomAt's fit*0.15..fit*12
    const nz = v.fitZ * (target / 100);
    zoomAt(vp.clientWidth / 2, vp.clientHeight / 2, nz / v.z, true); // eased
  }, [zoomAt]);

  const fitAndRevert = useCallback(() => {
    setSmooth(true);
    fit();
    if (smoothTimer.current) clearTimeout(smoothTimer.current);
    smoothTimer.current = setTimeout(() => { setSmooth(false); scheduleHiRes(); }, 320);
  }, [fit, scheduleHiRes, setSmooth]);

  // imperative zoom controls for keyboard shortcuts driven from the page
  useImperativeHandle(ref, () => ({
    zoomIn: () => zoomStep(1),
    zoomOut: () => zoomStep(-1),
    fit: () => fitAndRevert(),
  }), [zoomStep, fitAndRevert]);

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

  // refit when the viewport resizes
  useEffect(() => {
    const vp = viewportRef.current;
    if (!vp || typeof ResizeObserver === 'undefined') return;
    const ro = new ResizeObserver(() => fit());
    ro.observe(vp);
    return () => ro.disconnect();
  }, [fit]);

  const lastPageKey = useRef('');

  // reset to the base preview whenever the file/page changes
  useEffect(() => {
    hiResToken.current++;          // cancel any in-flight hi-res render
    hiResCanvas.current = null;
    srcScale.current = result.renderScale;
    if (loadedScale !== result.renderScale) setLoadedScale(result.renderScale);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [result, pageIdx]);

  // draw the base bitmap (+ overlays), cropping to trim in finished mode
  useEffect(() => {
    const base = baseRef.current, over = overRef.current, l = layerRef.current;
    if (!base || !over || !l) return;
    setSmooth(false); // redraws / page changes / hi-res swaps are instant
    const geom = result.pages[pageIdx];
    const useHi = hiResCanvas.current && Math.abs(loadedScale - result.renderScale) > 1e-6;
    const raw = useHi ? hiResCanvas.current! : result.previews[pageIdx];
    if (!raw || !geom) return;
    const scale = useHi ? loadedScale : result.renderScale;
    const src = finished ? cropToTrim(raw, geom, scale) : raw;

    base.width = src.width; base.height = src.height;
    over.width = src.width; over.height = src.height;
    base.getContext('2d')!.drawImage(src, 0, 0);
    l.style.width = `${src.width}px`;
    l.style.height = `${src.height}px`;

    // refit when a different page/file/mode is shown (keeps zoom across toggles)
    const pageKey = `${result.fileName}:${pageIdx}:${result.previews[pageIdx]?.width}:${finished}`;
    if (pageKey !== lastPageKey.current) {
      lastPageKey.current = pageKey;
      fit();
    } else {
      apply();
    }

    over.getContext('2d')!.clearRect(0, 0, over.width, over.height);
    if (!finished) {
      renderOverlays(over, { result, settings, pageIdx, showTac, showGuides, showDims, markerKind, scaleOverride: scale });
    }
  }, [result, settings, pageIdx, showTac, showGuides, showDims, markerKind, finished, loadedScale, fit, apply, setSmooth]);


  return (
    <div
      className="stage2d zoomable"
      ref={viewportRef}
      onPointerDown={(e) => {
        if (e.button !== 0) return;
        setSmooth(false); // dragging is instant even right after a button zoom
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
        <button title="Zoom out" onClick={() => zoomStep(-1)}>−</button>
        <span className="zoomPct">{pct}%</span>
        <button title="Zoom in" onClick={() => zoomStep(1)}>＋</button>
        <button title="Fit to view" onClick={fitAndRevert}>Fit</button>
      </div>
    </div>
  );
});

export default Preview2D;
