'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import dynamic from 'next/dynamic';
import type { AnalysisResult, Finding, MarkerKind, Settings } from '@/lib/types';
import { DEFAULT_SETTINGS, MM_PER_PT } from '@/lib/types';
import { PAPER_PRESETS, paperSizeMm } from '@/lib/presets';
import type { PrecheckInfo } from '@/lib/estimateSize';
import ResultsPanel, { worstSeverity } from '@/components/ResultsPanel';
import Preview2D, { type Preview2DHandle } from '@/components/Preview2D';
import { MARKER_STYLE, renderOverlays } from '@/lib/overlay';
import SettingsForm from '@/components/SettingsForm';
import type { ViewCommand } from '@/components/Preview3D';

const Preview3D = dynamic(() => import('@/components/Preview3D'), { ssr: false });

// upload → confirm (settings review) → analyzing → result
type Phase = 'upload' | 'confirm' | 'analyzing' | 'result' | 'error';

const FORMAT_LABELS: Record<string, string> = {
  pdf: 'PDF', ai: 'Illustrator (PDF-compatible)', jpg: 'JPEG', jpeg: 'JPEG', png: 'PNG',
};

// Check settings persist across sessions (incl. custom size).
const SETTINGS_KEY = 'preflight-pro:settings:v1';
const THEME_KEY = 'preflight-pro:theme';

// In-page anchor scroll: offset for the sticky header + gap, eased over ~0.3s.
const SCROLL_OFFSET = 60; // header (44) + breathing room
function smoothScrollTo(targetY: number, duration = 2000) {
  const reduce = typeof matchMedia !== 'undefined'
    && matchMedia('(prefers-reduced-motion: reduce)').matches;
  // clamp to the actually reachable range so the ease lands exactly on the
  // target — otherwise the browser hard-clamps at the top/bottom mid-glide
  // and the motion stops abruptly.
  const maxScroll = Math.max(0, document.documentElement.scrollHeight - window.innerHeight);
  const y = Math.min(maxScroll, Math.max(0, targetY));
  if (reduce) { window.scrollTo(0, y); return; }
  const start = window.scrollY;
  const change = y - start;
  const t0 = performance.now();
  // easeInOutQuint — soft ease in, and an especially gentle, drawn-out stop
  const ease = (t: number) => (t < 0.5 ? 16 * t * t * t * t * t : 1 - Math.pow(-2 * t + 2, 5) / 2);
  const step = (now: number) => {
    const p = Math.min(1, (now - t0) / duration);
    window.scrollTo(0, start + change * ease(p));
    if (p < 1) requestAnimationFrame(step);
  };
  requestAnimationFrame(step);
}

// Crop a page preview to its trim box → the finished piece for the 3D view.
function croppedToTrim(result: AnalysisResult, pageIdx: number): { canvas: HTMLCanvasElement; wMm: number; hMm: number } | null {
  const src = result.previews[pageIdx];
  const geom = result.pages[pageIdx];
  if (!src || !geom) return null;
  const s = result.renderScale;
  const vb = geom.viewBoxPt ?? geom.mediaBoxPt;
  const trim = geom.trimBoxPt;
  if (!trim) {
    return {
      canvas: src,
      wMm: (vb[2] - vb[0]) * MM_PER_PT,
      hMm: (vb[3] - vb[1]) * MM_PER_PT,
    };
  }
  const x = (trim[0] - vb[0]) * s;
  const w = (trim[2] - trim[0]) * s;
  const h = (trim[3] - trim[1]) * s;
  const y = src.height - (trim[3] - vb[1]) * s;
  const k = ssFactor(w, h);
  const out = document.createElement('canvas');
  out.width = Math.max(2, Math.round(w * k));
  out.height = Math.max(2, Math.round(h * k));
  const ctx = out.getContext('2d')!;
  ctx.imageSmoothingEnabled = true; ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(src, x, y, w, h, 0, 0, out.width, out.height);
  return { canvas: out, wMm: (trim[2] - trim[0]) * MM_PER_PT, hMm: (trim[3] - trim[1]) * MM_PER_PT };
}

// Full page (bleed included) composited with the selected overlays — used by
// the 3D preview when guides / dims / TAC are switched on.
// target long-edge (px) for the 3D paper texture, so small previews aren't
// magnified by the GPU into a jagged/soft mess (overlays stay crisp too).
const TEX_TARGET = 2600;
const ssFactor = (w: number, h: number) =>
  Math.min(3, Math.max(1, TEX_TARGET / Math.max(w, h)));

function compositedFullPage(
  result: AnalysisResult, settings: Settings, pageIdx: number,
  opts: { showTac: boolean; showGuides: boolean; showDims: boolean; markerKind: MarkerKind | null },
): { canvas: HTMLCanvasElement; wMm: number; hMm: number } | null {
  const src = result.previews[pageIdx];
  const geom = result.pages[pageIdx];
  if (!src || !geom) return null;
  const k = ssFactor(src.width, src.height);
  const out = document.createElement('canvas');
  out.width = Math.round(src.width * k);
  out.height = Math.round(src.height * k);
  const ctx = out.getContext('2d')!;
  ctx.imageSmoothingEnabled = true; ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(src, 0, 0, out.width, out.height);
  renderOverlays(out, { result, settings, pageIdx, ...opts, scaleOverride: result.renderScale * k });
  const vb = geom.viewBoxPt ?? geom.mediaBoxPt;
  return {
    canvas: out,
    wMm: (vb[2] - vb[0]) * MM_PER_PT,
    hMm: (vb[3] - vb[1]) * MM_PER_PT,
  };
}

export default function Home() {
  const [phase, setPhase] = useState<Phase>('upload');
  const [settings, setSettings] = useState<Settings>(DEFAULT_SETTINGS);
  const [progress, setProgress] = useState('');
  const [result, setResult] = useState<AnalysisResult | null>(null);
  const [errorMsg, setErrorMsg] = useState('');
  const [drag, setDrag] = useState(false);
  const fileRef = useRef<File | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const disposeRef = useRef<(() => void) | null>(null); // releases the previous PDF's retained doc
  const preview2dRef = useRef<Preview2DHandle>(null);
  const preview3dFitRef = useRef<(() => void) | null>(null);
  const previewColRef = useRef<HTMLDivElement>(null);
  const [panelMaxH, setPanelMaxH] = useState<number | undefined>(undefined);
  const [scMounted, setScMounted] = useState(false); // shortcuts modal in DOM
  const [scOpen, setScOpen] = useState(false);        // shortcuts modal visible (transition)
  const scTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const openShortcuts = useCallback(() => {
    if (scTimer.current) clearTimeout(scTimer.current);
    setScMounted(true);
    requestAnimationFrame(() => setScOpen(true)); // next frame → enter transition
  }, []);
  const closeShortcuts = useCallback(() => {
    setScOpen(false);
    if (scTimer.current) clearTimeout(scTimer.current);
    scTimer.current = setTimeout(() => setScMounted(false), 300); // unmount after exit
  }, []);

  // preview state
  const [tab, setTab] = useState<'3d' | '2d'>('3d');
  const [pageIdx, setPageIdx] = useState(0);
  const [showTac, setShowTac] = useState(false);
  const [showGuides, setShowGuides] = useState(true);
  const [showDims, setShowDims] = useState(true);
  const [markerKind, setMarkerKind] = useState<MarkerKind | null>(null);
  const [autoRotate, setAutoRotate] = useState(false);
  const [command, setCommand] = useState<ViewCommand>({ cmd: 'reset', n: 0 });
  const [facing3d, setFacing3d] = useState<'front' | 'back'>('front'); // which face the 3D camera sees

  // Return to the top (upload) page — used by the header logo.
  const goHome = useCallback(() => {
    disposeRef.current?.();
    disposeRef.current = null;
    fileRef.current = null;
    setResult(null);
    setPre(null);
    setMarkerKind(null);
    setPhase('upload');
  }, []);

  // Match the results panel's scroll height to the preview column (desktop),
  // so it scrolls on its own instead of stretching the page.
  useEffect(() => {
    if (phase !== 'result') return;
    const el = previewColRef.current;
    if (!el || typeof ResizeObserver === 'undefined') return;
    const update = () => setPanelMaxH(window.innerWidth > 1000 ? el.offsetHeight : undefined);
    const ro = new ResizeObserver(update);
    ro.observe(el);
    window.addEventListener('resize', update);
    update();
    return () => { ro.disconnect(); window.removeEventListener('resize', update); };
  }, [phase, result]);

  // Page turning (works in both 2D and 3D; also bound to ← / → keys).
  // Wraps around: past the last page → first, before the first → last, so a
  // 2-page front/back can be flipped repeatedly with one arrow.
  const goPage = useCallback((delta: number) => {
    setResult((r) => {
      if (r && r.pageCount > 1) {
        setPageIdx((i) => ((i + delta) % r.pageCount + r.pageCount) % r.pageCount);
      }
      return r;
    });
  }, []);

  // Keyboard shortcuts while viewing results (ignored while typing in a field
  // or when a browser/OS modifier is held).
  useEffect(() => {
    if (phase !== 'result') return;
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement | null;
      if (t && /^(INPUT|SELECT|TEXTAREA)$/.test(t.tagName)) return;
      // ⌘0 / Ctrl+0 → fit the active preview (overrides browser reset-zoom)
      if ((e.metaKey || e.ctrlKey) && !e.altKey && e.key === '0') {
        e.preventDefault();
        if (tab === '2d') preview2dRef.current?.fit();
        else preview3dFitRef.current?.();
        return;
      }
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      switch (e.key) {
        // page turning
        case 'ArrowLeft': e.preventDefault(); goPage(-1); break;
        case 'ArrowRight': e.preventDefault(); goPage(1); break;
        // view switching
        case '2': setTab('2d'); break;
        case '3': setTab('3d'); break;
        // overlay toggles
        case 'g': case 'G': setShowGuides((v) => !v); break;
        case 'd': case 'D': setShowDims((v) => !v); break;
        case 'i': case 'I': setShowTac((v) => !v); break;
        // 3D view controls
        case ' ': if (tab === '3d') { e.preventDefault(); setAutoRotate((v) => !v); } break;
        case 'f': case 'F': if (tab === '3d') setCommand((c) => ({ cmd: 'front', n: c.n + 1 })); break;
        case 'b': case 'B': if (tab === '3d') setCommand((c) => ({ cmd: 'back', n: c.n + 1 })); break;
        case 'r': case 'R': if (tab === '3d') setCommand((c) => ({ cmd: 'reset', n: c.n + 1 })); break;
        // 2D zoom controls
        case '+': case '=': if (tab === '2d') { e.preventDefault(); preview2dRef.current?.zoomIn(); } break;
        case '-': case '_': if (tab === '2d') { e.preventDefault(); preview2dRef.current?.zoomOut(); } break;
        case '0': if (tab === '2d') preview2dRef.current?.fit(); else preview3dFitRef.current?.(); break;
        // help / dismiss
        case '?': e.preventDefault(); scMounted ? closeShortcuts() : openShortcuts(); break;
        case 'Escape':
          if (scMounted) closeShortcuts();
          else setMarkerKind(null);
          break;
        default: break;
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [phase, tab, goPage, scMounted, openShortcuts, closeShortcuts]);

  // Locate a finding's spots: jump to the 2D view (and its first page).
  const onLocate = useCallback((f: Finding) => {
    if (!f.markerKind) return;
    setMarkerKind((cur) => (cur === f.markerKind ? null : f.markerKind!));
    setTab('2d');
    setResult((r) => {
      if (r) {
        const first = r.markers.find((m) => m.kind === f.markerKind);
        if (first && first.page - 1 < r.previews.length) setPageIdx(first.page - 1);
      }
      return r;
    });
  }, []);

  const runAnalysis = useCallback(async (file: File, s: Settings) => {
    fileRef.current = file;
    setPhase('analyzing');
    setMarkerKind(null);
    setProgress('Loading file…');
    try {
      const { analyzeFile } = await import('@/lib/analyze');
      const r = await analyzeFile(file, s, setProgress);
      disposeRef.current?.();            // release the previous file's retained PDF
      disposeRef.current = r.dispose ?? null;
      setResult(r);
      setPageIdx(0);
      setTab('3d');
      setPhase('result');
    } catch (e: any) {
      setErrorMsg(e?.message ?? String(e));
      setPhase('error');
    }
  }, []);

  // In-page anchor links (landing nav / in-text): scroll with a header offset
  // so the target isn't hidden, eased over 0.3s like the rest of the app.
  useEffect(() => {
    const onClick = (e: MouseEvent) => {
      if (e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
      const a = (e.target as HTMLElement | null)?.closest?.('a[href^="#"]') as HTMLAnchorElement | null;
      if (!a) return;
      const id = a.getAttribute('href')!.slice(1);
      const el = id ? document.getElementById(id) : null;
      if (!el) return;
      e.preventDefault();
      const y = el.getBoundingClientRect().top + window.scrollY - SCROLL_OFFSET;
      smoothScrollTo(y);
      history.replaceState(null, '', `#${id}`);
    };
    document.addEventListener('click', onClick);
    return () => document.removeEventListener('click', onClick);
  }, []);

  // On the confirm screen, Enter runs the check — but not while a value field
  // (size / bleed / ink / dpi / dropdown) is focused, so confirming an input
  // with Enter doesn't accidentally start the check.
  useEffect(() => {
    if (phase !== 'confirm') return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Enter' || e.metaKey || e.ctrlKey || e.altKey) return;
      const t = e.target as HTMLElement | null;
      if (t && /^(INPUT|SELECT|TEXTAREA)$/.test(t.tagName)) return;
      e.preventDefault();
      if (fileRef.current) runAnalysis(fileRef.current, settings);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [phase, runAnalysis, settings]);

  // Selecting a file moves to the settings-confirmation step; the check only
  // starts when the user explicitly presses Start check. Size estimation
  // (from TrimBox / image DPI) runs in the background for the confirm screen.
  const onFiles = useCallback((files: FileList | null) => {
    if (!files || !files[0]) return;
    fileRef.current = files[0];
    setPhase('confirm');
    setPre(null);
    setEstimating(true);
    const f = files[0];
    void (async () => {
      try {
        const buf = new Uint8Array(await f.arrayBuffer());
        const { precheckFile } = await import('@/lib/estimateSize');
        setPre(precheckFile(buf, settings.bleedMm));
      } catch {
        setPre(null);
      } finally {
        setEstimating(false);
      }
    })();
  }, [settings.bleedMm]);

  const set = <K extends keyof Settings>(k: K, v: Settings[K]) =>
    setSettings((s) => ({ ...s, [k]: v }));

  // ---- theme (dark = default identity / light) ----
  const [theme, setTheme] = useState<'dark' | 'light'>('dark');
  useEffect(() => {
    try {
      if (localStorage.getItem(THEME_KEY) === 'light') setTheme('light');
    } catch { /* ignore */ }
  }, []);
  useEffect(() => {
    if (theme === 'light') document.documentElement.dataset.theme = 'light';
    else delete document.documentElement.dataset.theme;
    try { localStorage.setItem(THEME_KEY, theme); } catch { /* quota */ }
  }, [theme]);

  // ---- settings persistence (localStorage) ----
  useEffect(() => {
    try {
      const stored = localStorage.getItem(SETTINGS_KEY);
      if (stored) setSettings({ ...DEFAULT_SETTINGS, ...JSON.parse(stored) });
    } catch { /* corrupted storage — keep defaults */ }
  }, []);
  useEffect(() => {
    try { localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings)); } catch { /* quota */ }
  }, [settings]);

  // ---- pre-check (size estimate + quick facts) state ----
  const [pre, setPre] = useState<PrecheckInfo | null>(null);
  const [estimating, setEstimating] = useState(false);

  // settings the pre-check could infer from the file (size + bleed + dpi)
  const detected = useMemo(() => {
    if (!pre) return null;
    const d: Partial<Settings> = {};
    if (pre.size) {
      if (pre.size.presetId) { d.paperId = pre.size.presetId; d.landscape = pre.size.landscape; }
      else { d.paperId = 'custom'; d.customWmm = pre.size.wMm; d.customHmm = pre.size.hMm; d.landscape = false; }
    }
    // measured bleed from a PDF TrimBox (snap to the nearest offered option)
    if (pre.kind === 'pdf' && pre.hasTrimBox && pre.bleedMm != null && pre.bleedMm > 0.3) {
      d.bleedMm = [0, 2, 3, 5].reduce((a, b) => Math.abs(b - pre.bleedMm!) < Math.abs(a - pre.bleedMm!) ? b : a);
    }
    // embedded image resolution → required resolution
    if (pre.image?.dpi) d.minDpi = pre.image.dpi;
    return Object.keys(d).length ? d : null;
  }, [pre]);

  const sizeMatchesSettings = useMemo(() => {
    if (!pre?.size) return false;
    const cur = paperSizeMm(settings.paperId, settings.customWmm, settings.customHmm, settings.landscape);
    return Math.abs(cur.wMm - pre.size.wMm) <= 0.6 && Math.abs(cur.hMm - pre.size.hMm) <= 0.6;
  }, [pre, settings]);

  // does every detected field already match the current settings?
  const detectedMatchesSettings = useMemo(() => {
    if (!detected) return true;
    if ((detected.paperId !== undefined || detected.customWmm !== undefined) && !sizeMatchesSettings) return false;
    if (detected.bleedMm !== undefined && detected.bleedMm !== settings.bleedMm) return false;
    if (detected.minDpi !== undefined && detected.minDpi !== settings.minDpi) return false;
    return true;
  }, [detected, sizeMatchesSettings, settings.bleedMm, settings.minDpi]);

  const applyDetected = useCallback(() => {
    if (!detected) return;
    setSettings((s) => ({ ...s, ...detected }));
  }, [detected]);

  const summary = useMemo(() => {
    if (!result) return null;
    const errs = result.findings.filter((x) => x.severity === 'error').length;
    const warns = result.findings.filter((x) => x.severity === 'warning').length;
    const oks = result.findings.filter((x) => x.severity === 'ok').length;
    return { errs, warns, oks, worst: worstSeverity(result.findings) };
  }, [result]);

  // overlays shown in 3D too: full page (bleed included) with composited guides
  const overlaysOn = showGuides || showDims || showTac || !!markerKind;
  const overlayOpts = useMemo(
    () => ({ showTac, showGuides, showDims, markerKind }),
    [showTac, showGuides, showDims, markerKind],
  );
  const paper3d = useMemo(() => {
    if (!result) return null;
    return overlaysOn
      ? compositedFullPage(result, settings, pageIdx, overlayOpts)
      : croppedToTrim(result, pageIdx);
  }, [result, pageIdx, overlaysOn, overlayOpts, settings]);
  // the page shown on the back face of the 3D sheet (front/back are paired)
  const backPageIdx = useMemo(() => {
    if (!result || result.pageCount < 2) return null;
    const other = pageIdx === 0 ? 1 : pageIdx + (pageIdx % 2 === 0 ? 1 : -1);
    return other >= 0 && other < result.previews.length ? other : null;
  }, [result, pageIdx]);
  const back3d = useMemo(() => {
    if (!result || backPageIdx === null) return null;
    if (overlaysOn) return compositedFullPage(result, settings, backPageIdx, overlayOpts)?.canvas ?? null;
    return croppedToTrim(result, backPageIdx)?.canvas ?? null;
  }, [result, backPageIdx, overlaysOn, overlayOpts, settings]);

  return (
    <>
      <header className="header">
        <button className="logo" onClick={goHome} title="Back to top" aria-label="Back to top">
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img className="logoImg" src="/logo.png" alt="Preflight logo" width={20} height={20} />
          <span className="mark">Preflight</span>
        </button>
        <button
          className="themeToggle"
          onClick={() => setTheme((t) => (t === 'dark' ? 'light' : 'dark'))}
          title="Toggle light / dark mode"
          aria-label="Toggle light / dark mode"
        >
          <span className="themeIcon" aria-hidden="true">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6"
              strokeLinecap="round" strokeLinejoin="round">
              <circle cx="12" cy="12" r="4" />
              <path d="M12 2v2M12 20v2M4.93 4.93l1.41 1.41M17.66 17.66l1.41 1.41M2 12h2M20 12h2M6.34 17.66l-1.41 1.41M19.07 4.93l-1.41 1.41" />
            </svg>
          </span>
        </button>
      </header>

      {phase === 'upload' && (
        <div className="uploadWrap single">
          <div className="card">
            <div className="cardHead">Upload print data</div>
            <div className="cardBody">
              <div
                className={`dropzone ${drag ? 'drag' : ''}`}
                onDragOver={(e) => { e.preventDefault(); setDrag(true); }}
                onDragLeave={() => setDrag(false)}
                onDrop={(e) => { e.preventDefault(); setDrag(false); onFiles(e.dataTransfer.files); }}
              >
                <svg className="dropIcon" viewBox="0 0 24 24" fill="none" stroke="currentColor"
                  strokeWidth="0.85" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                  <path d="M15 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7z" />
                  <path d="M14 2v5h5" />
                </svg>
                <div className="big">Drag &amp; drop a file</div>
                <div>or</div>
                <button className="btn" onClick={() => inputRef.current?.click()}>
                  Choose file
                </button>
                <input
                  ref={inputRef}
                  type="file"
                  accept=".pdf,.ai,.jpg,.jpeg,.png"
                  style={{ display: 'none' }}
                  onChange={(e) => onFiles(e.target.files)}
                />
                <div className="formats">
                  Supported: PDF / Illustrator (.ai, saved PDF-compatible) / JPEG / PNG<br />
                  All analysis runs in your browser — your files are never uploaded to a server.<br />
                  After selecting a file, you can review the check settings (size, bleed, ink, etc.) on the next screen.
                </div>
              </div>
            </div>
          </div>

          <section className="landing">
            <h1>Print data preflight &amp; proofing in your browser</h1>
            <p>
              <strong>Preflight</strong> is a free tool for print data preflight and proofing that runs
              entirely in your browser. Before you submit artwork to a print shop, drop in a PDF, Adobe
              Illustrator (.ai), JPEG or PNG and get an instant, detailed report. There is no sign-up and
              nothing is uploaded — every file is analysed locally in your browser, so your print data
              never leaves your computer. Whether you are a designer preparing a brochure, a photographer
              building a photo book, or a small business printing business cards and flyers, doing your
              preflight and proofing in the browser helps you catch problems before they turn into a
              costly reprint.
            </p>

            <nav className="landingNav" aria-label="On this page">
              <a href="#checks">What it checks</a>
              <a href="#how">How it works</a>
              <a href="#formats">File types</a>
              <a href="#why">Why preflight</a>
              <a href="#glossary">Print glossary</a>
              <a href="#privacy">Privacy</a>
              <a href="#faq">FAQ</a>
            </nav>

            <h2 id="checks">What Preflight checks</h2>
            <p>
              Preflight runs the same core checks a prepress operator would, and shows exactly where each
              problem is on a 3D paper preview and a zoomable 2D proof. Every finding comes with a
              plain-language explanation and, where possible, an arrow that points to the affected object
              so proofing is fast and unambiguous:
            </p>
            <ul className="landingList">
              <li><strong>Color mode</strong> — detects RGB objects that should be CMYK, plus spot colors and ICC profiles that may shift on press.</li>
              <li><strong>Total ink coverage (TAC)</strong> — flags colors that exceed your ink limit and 4-color / rich blacks that can smear or set off.</li>
              <li><strong>Bleed &amp; trim size</strong> — verifies the finished size and that enough bleed is present so no white edges appear after cutting.</li>
              <li><strong>Overprint</strong> — finds overprint and white-overprint (knockout) that looks fine on screen but can vanish in print.</li>
              <li><strong>Fonts</strong> — checks that every font is embedded or converted to outlines so text is not substituted at the shop.</li>
              <li><strong>Image resolution</strong> — calculates the effective DPI of placed images against your required resolution to avoid blurry output.</li>
            </ul>
            <p>
              Not sure what a term means? Jump to the <a href="#glossary">print glossary</a> for short
              definitions of bleed, trim, TAC, overprint and effective resolution.
            </p>

            <h2 id="how">How preflight and proofing works</h2>
            <p>
              Getting a proof takes three quick steps. First, choose a file or drag it onto the uploader
              above — the tool reads it immediately and runs a fast pre-check. Second, confirm the check
              settings: finished size, bleed, ink limit and required resolution. Preflight can estimate
              the finished size and bleed from the file itself, and your settings are remembered for next
              time. Third, press Check to run the full inspection and review the result. You can rotate
              the 3D paper preview, flip between front and back, zoom the 2D proof, and toggle guides,
              dimensions and an ink-coverage overlay. Because everything is computed in your browser, the
              report appears in seconds and you can re-run the <a href="#checks">checks</a> with different
              settings as many times as you like.
            </p>

            <h2 id="formats">Supported file types</h2>
            <p>
              Preflight accepts the formats most commonly used for print submission: <strong>PDF</strong>,
              Adobe <strong>Illustrator (.ai)</strong> saved as PDF-compatible, <strong>JPEG</strong> and
              <strong> PNG</strong>. Vector files such as PDF and Illustrator are inspected object by object,
              so exact CMYK values, overprint settings and fonts are read directly from the file. Raster
              files such as JPEG and PNG are checked for color mode, transparency and whether their pixel
              size is high enough for the chosen print size. For the strictest color control, exporting a
              CMYK PDF/X file is recommended, but the tool works well with everyday exports too.
            </p>

            <h2 id="why">Why preflight before you print?</h2>
            <p>
              Most reprints and unexpected charges come from a handful of avoidable issues: artwork left in
              RGB, black text built from four inks, missing bleed, non-embedded fonts, or low-resolution
              images. Catching these during preflight and proofing saves time, money and a frustrating
              back-and-forth with the printer. A commercial press cannot “undo” a mistake once plates are
              made, so a few minutes of checking up front is the cheapest insurance you can buy. Preflight
              gives you a clear report and pinpoints each issue on the preview so you can fix it with
              confidence before you submit your <a href="#formats">print data</a>.
            </p>

            <h2 id="glossary">Print glossary</h2>
            <ul className="landingList">
              <li><strong>Bleed</strong> — extra artwork (usually 3&nbsp;mm) extending past the trim so no white edge shows after cutting.</li>
              <li><strong>Trim</strong> — the final cut line; the finished size of the printed piece.</li>
              <li><strong>Safe area</strong> — a margin inside the trim where important text and logos should stay.</li>
              <li><strong>TAC / total ink coverage</strong> — the sum of C, M, Y and K percentages; too high and ink will not dry.</li>
              <li><strong>Overprint</strong> — printing one ink on top of another instead of knocking it out; white overprint can disappear.</li>
              <li><strong>Rich black</strong> — black mixed from several inks for a deeper tone; risky for small text.</li>
              <li><strong>Effective resolution (DPI)</strong> — an image’s real resolution at its placed size, which drops as you scale it up.</li>
              <li><strong>CMYK vs RGB</strong> — presses print in CMYK, so RGB artwork is converted and vivid colors can look duller.</li>
            </ul>

            <h2 id="privacy">Private by design</h2>
            <p>
              Preflight is fully client-side. Your PDF, Illustrator, JPEG and PNG files are processed
              entirely in your browser and are never sent to a server, which keeps confidential artwork
              safe. It is free to use, requires no account, and works even without a stable connection once
              the page has loaded.
            </p>

            <h2 id="faq">Frequently asked questions</h2>
            <h3>Is Preflight free?</h3>
            <p>Yes. Preflight is completely free and does not require an account.</p>
            <h3>Are my files uploaded anywhere?</h3>
            <p>No. All preflight and proofing happens locally in your browser; nothing is sent to a server. See <a href="#privacy">privacy</a>.</p>
            <h3>Does it replace the print shop’s own check?</h3>
            <p>No. It is a pre-submission self-check to catch common issues early; the shop still performs its official inspection.</p>
            <h3>Which files can I check?</h3>
            <p>PDF, Adobe Illustrator (.ai), JPEG and PNG — see <a href="#formats">supported file types</a>.</p>

            <p className="landingLinks">
              <span>
                Created by{' '}
                <a href="https://fxx.huruike.com" target="_blank" rel="noopener noreferrer">Daishin Sakuma</a>
              </span>
              <span aria-hidden="true">·</span>
              <span>Share:</span>
              <a href="https://twitter.com/intent/tweet?url=https%3A%2F%2Fpreflight-pro.vercel.app&text=Preflight%20%E2%80%94%20check%20your%20print%20data%20in%20the%20browser"
                target="_blank" rel="noopener noreferrer">X</a>
              <a href="https://www.facebook.com/sharer/sharer.php?u=https%3A%2F%2Fpreflight-pro.vercel.app"
                target="_blank" rel="noopener noreferrer">Facebook</a>
              <a href="https://www.linkedin.com/sharing/share-offsite/?url=https%3A%2F%2Fpreflight-pro.vercel.app"
                target="_blank" rel="noopener noreferrer">LinkedIn</a>
            </p>
          </section>
        </div>
      )}

      {phase === 'confirm' && fileRef.current && (
        <div className="uploadWrap">
            <div className="card">
              <div className="cardHead">Uploaded file</div>
              <div className="cardBody">
                <div className="fileSummary">
                  <svg className="fileIcon" viewBox="0 0 24 24" fill="none" stroke="currentColor"
                    strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                    <path d="M15 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7z" />
                    <path d="M14 2v5h5" />
                  </svg>
                  <div>
                    <div className="fsName">{fileRef.current.name}</div>
                    <div className="fsMeta">
                      {FORMAT_LABELS[fileRef.current.name.split('.').pop()?.toLowerCase() ?? ''] ?? 'Unknown format'}
                      {' · '}{(fileRef.current.size / 1024 / 1024).toFixed(2)}MB
                    </div>
                  </div>
                  <button className="btn ghost small" style={{ marginLeft: 'auto' }}
                    onClick={() => { fileRef.current = null; setPhase('upload'); }}>
                    Choose another file
                  </button>
                </div>
                <div className="estimateBox">
                  {estimating ? (
                    <span className="estWait">Inspecting file…</span>
                  ) : pre ? (
                    <>
                      <div className="estHead">Detected from the file (pre-check)</div>
                      <div className="pcGrid">
                        <span className="pcLabel">Est. finished size</span>
                        <span className="pcValue">
                          {pre.size ? (
                            <>
                              <span className="estValue">
                                {pre.size.presetId
                                  ? `${PAPER_PRESETS.find((p) => p.id === pre.size!.presetId)?.label ?? ''}${pre.size.landscape ? ' landscape' : ''}`
                                  : `${pre.size.wMm}×${pre.size.hMm}mm (custom)`}
                              </span>
                              {sizeMatchesSettings
                                ? <span className="estOk">✓ Matches settings</span>
                                : <span className="pcWarn">≠ current settings</span>}
                              <span className="pcSub">{pre.size.sourceLabel}</span>
                            </>
                          ) : (
                            <span className="pcDim">Could not estimate (no resolution info) — set it in the settings panel</span>
                          )}
                        </span>

                        <span className="pcLabel">Bleed</span>
                        <span className="pcValue">
                          {pre.kind === 'pdf' ? (
                            pre.hasTrimBox && pre.bleedMm !== null ? (
                              pre.bleedMm >= settings.bleedMm - 0.3
                                ? <span className="pcOk">~{pre.bleedMm}mm ✓</span>
                                : pre.bleedMm > 0.3
                                  ? <span className="pcWarn">~{pre.bleedMm}mm (need {settings.bleedMm}mm) ⚠</span>
                                  : <span className="pcWarn">None ⚠</span>
                            ) : <span className="pcDim">No TrimBox — will be judged from size in the full check</span>
                          ) : <span className="pcDim">Raster file — judged in the full check</span>}
                        </span>

                        <span className="pcLabel">Pages</span>
                        <span className="pcValue">{pre.pageCount ?? '—'}</span>

                        <span className="pcLabel">Color</span>
                        <span className="pcValue">
                          {pre.colorHint === 'cmyk' && <span className="pcOk">CMYK ✓</span>}
                          {pre.colorHint === 'rgb-mixed' && <span className="pcWarn">Contains RGB ⚠</span>}
                          {pre.colorHint === 'gray' && 'Grayscale'}
                          {pre.colorHint === 'unknown' && <span className="pcDim">Undetermined</span>}
                        </span>

                        {pre.image && (
                          <>
                            <span className="pcLabel">Image</span>
                            <span className="pcValue">
                              {pre.image.format.toUpperCase()} · {pre.image.colorSpace} · {pre.image.width}×{pre.image.height}px
                              {pre.image.dpi ? ` · ${pre.image.dpi}dpi` : ' · no resolution info'}
                              {pre.image.hasAlpha && <span className="pcWarn"> · has transparency ⚠</span>}
                            </span>
                          </>
                        )}

                        {(pre.encrypted || pre.fontsNotEmbedded > 0 || pre.spotColors > 0) && (
                          <>
                            <span className="pcLabel">Warnings</span>
                            <span className="pcValue pcWarn">
                              {[
                                pre.encrypted && 'Encrypted',
                                pre.fontsNotEmbedded > 0 && `${pre.fontsNotEmbedded} unembedded font(s)`,
                                pre.spotColors > 0 && `${pre.spotColors} spot color(s)`,
                              ].filter(Boolean).join(' · ')} ⚠
                            </span>
                          </>
                        )}
                      </div>
                      {detected && !detectedMatchesSettings && (
                        <div className="estApply">
                          <button className="btn ghost small" onClick={applyDetected}>Use detected settings</button>
                          <span className="pcSub">
                            Applies{' '}
                            {[
                              (detected.paperId !== undefined || detected.customWmm !== undefined) && 'size',
                              detected.bleedMm !== undefined && `bleed ${detected.bleedMm}mm`,
                              detected.minDpi !== undefined && `resolution ${detected.minDpi}dpi`,
                            ].filter(Boolean).join(' · ')}
                          </span>
                        </div>
                      )}
                      <div className="estSrc">Pre-check summary only. The full inspection runs after you press Check.</div>
                    </>
                  ) : (
                    <span className="estNone">
                      Could not inspect the file. Set the finished size in the settings panel and start the check.
                    </span>
                  )}
                </div>
              </div>
            </div>

          <div className="card">
            <div className="cardHead">Check settings</div>
            <div className="cardBody">
              <SettingsForm settings={settings} onChange={set} />
            </div>
          </div>

          <div className="confirmBar">
            <p className="confirmHint">
              Make sure the file and the check settings (finished size, bleed, ink limit, etc.)
              match your order before starting. Settings are saved for next time and can also be
              changed on the results screen to re-run the check.
            </p>
            <button className="btn confirmCheck" onClick={() => fileRef.current && runAnalysis(fileRef.current, settings)}>
              Check
            </button>
          </div>
        </div>
      )}

      {phase === 'analyzing' && (
        <div className="analyzing">
          <div className="spinner" />
          <h2>Checking data…</h2>
          <div className="msg">{progress}</div>
        </div>
      )}

      {phase === 'error' && (
        <div className="errorBox">
          <h2>Couldn’t run the check</h2>
          <p>{errorMsg}</p>
          <p style={{ marginTop: 18 }}>
            <button className="btn" onClick={() => setPhase('upload')}>Back to upload</button>
          </p>
        </div>
      )}

      {phase === 'result' && result && summary && (
        <div className="resultWrap">
          <div className={`summaryBanner ${summary.errs ? 'fail' : summary.warns ? 'warn' : 'pass'}`}>
            <span className="sbIcon" aria-hidden="true">
              {summary.errs ? (
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8"
                  strokeLinecap="round" strokeLinejoin="round">
                  <circle cx="12" cy="12" r="9" /><path d="m14.5 9.5-5 5M9.5 9.5l5 5" />
                </svg>
              ) : summary.warns ? (
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8"
                  strokeLinecap="round" strokeLinejoin="round">
                  <path d="M10.29 3.86 1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0Z" />
                  <path d="M12 9v4M12 17h.01" />
                </svg>
              ) : (
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8"
                  strokeLinecap="round" strokeLinejoin="round">
                  <circle cx="12" cy="12" r="9" /><path d="m8.5 12 2.5 2.5 4.5-5" />
                </svg>
              )}
            </span>
            <span className="sbText">
              {summary.errs
                ? `Problems were found that need fixing`
                : summary.warns
                  ? `Ready to submit, but some items are worth reviewing`
                  : `All checks passed`}
            </span>
            <span className="chips">
              {summary.errs > 0 && <span className="chip err"><i />Errors <b>{summary.errs}</b></span>}
              {summary.warns > 0 && <span className="chip warn"><i />Warnings <b>{summary.warns}</b></span>}
              <span className="chip ok"><i />OK <b>{summary.oks}</b></span>
            </span>
          </div>

          <div className="previewCol" ref={previewColRef}>
          <div className="card previewCard">
            <div className="previewTabs">
              <button className={tab === '3d' ? 'on' : ''} onClick={() => setTab('3d')}>3D preview</button>
              <button className={tab === '2d' ? 'on' : ''} onClick={() => setTab('2d')}>2D proof</button>
              <div className="tabInfo">
                <span className="name" title={result.fileName}>{result.fileName}</span>
                <span className="meta">
                  {(result.fileSize / 1024 / 1024).toFixed(2)}MB · {result.pageCount} page{result.pageCount > 1 ? 's' : ''} ·
                  {result.kind === 'pdf' ? ' PDF' : ` ${result.imageInfo?.format.toUpperCase()} image`}
                </span>
                <button className="tabAction" onClick={() => setPhase('confirm')}>
                  Change settings
                </button>
              </div>
            </div>
            <div className="previewStage">
              {tab === '3d' && paper3d && (
                <Preview3D
                  front={paper3d.canvas}
                  back={back3d}
                  wMm={paper3d.wMm}
                  hMm={paper3d.hMm}
                  autoRotate={autoRotate}
                  command={command}
                  stageColor={theme === 'light' ? '#b9bcc2' : '#454547'}
                  onFacing={setFacing3d}
                  fitRef={preview3dFitRef}
                />
              )}
              {tab === '2d' && (
                <Preview2D
                  ref={preview2dRef}
                  result={result}
                  settings={settings}
                  pageIdx={pageIdx}
                  showTac={showTac}
                  showGuides={showGuides}
                  showDims={showDims}
                  markerKind={markerKind}
                  finished={!overlaysOn}
                />
              )}
              {result.pageCount > 1 && (
                <>
                  <button className="pageNav left"
                    onClick={() => goPage(-1)} title="Previous page (←)" aria-label="Previous page">
                    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.25"
                      strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="m15 18-6-6 6-6" /></svg>
                  </button>
                  <button className="pageNav right"
                    onClick={() => goPage(1)} title="Next page (→)" aria-label="Next page">
                    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.25"
                      strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="m9 18 6-6-6-6" /></svg>
                  </button>
                  <div className="pageBadge">
                    {(() => {
                      // in 3D, follow which face the camera currently sees
                      const viewingBack = tab === '3d' && facing3d === 'back';
                      if (viewingBack && backPageIdx === null) return 'Blank back';
                      const idx = viewingBack && backPageIdx !== null ? backPageIdx : pageIdx;
                      return result.pageCount === 2
                        ? (idx === 0 ? 'Front' : 'Back')
                        : `Page ${idx + 1} / ${result.pageCount}`;
                    })()}
                  </div>
                </>
              )}
            </div>
            <div className="previewCtrl">
              {tab === '3d' && (
                <>
                  <button className={`btn ghost small spinToggle ${autoRotate ? 'active' : ''}`}
                    onClick={() => setAutoRotate((v) => !v)}
                    title={autoRotate ? 'Stop rotation' : 'Auto-rotate'}>
                    {autoRotate ? (
                      <svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
                        <rect x="7" y="5" width="3.4" height="14" rx="1" />
                        <rect x="13.6" y="5" width="3.4" height="14" rx="1" />
                      </svg>
                    ) : (
                      <svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
                        <path d="M8 5.2v13.6a1 1 0 0 0 1.52.85l11-6.8a1 1 0 0 0 0-1.7l-11-6.8A1 1 0 0 0 8 5.2Z" />
                      </svg>
                    )}
                    <span>{autoRotate ? 'Stop' : 'Spin'}</span>
                  </button>
                  <span className="sep" />
                </>
              )}
              <button className={`btn ghost small ${showGuides ? 'active' : ''}`}
                onClick={() => setShowGuides((v) => !v)}>
                Guides
              </button>
              <button className={`btn ghost small ${showDims ? 'active' : ''}`}
                onClick={() => setShowDims((v) => !v)}>
                Dimensions
              </button>
              <button className={`btn ghost small ${showTac ? 'active' : ''}`}
                onClick={() => setShowTac((v) => !v)}>
                Ink (over {settings.tacLimit}%)
              </button>
              {markerKind && (
                <button className="btn ghost small markerClear"
                  style={{ borderColor: MARKER_STYLE[markerKind].color, color: MARKER_STYLE[markerKind].color }}
                  onClick={() => setMarkerKind(null)}>
                  <i className="mcDot" style={{ background: MARKER_STYLE[markerKind].color }} />
                  <span>Showing “{MARKER_STYLE[markerKind].label}”</span>
                  <span className="mcX" aria-hidden="true">✕</span>
                </button>
              )}
              {tab === '3d' ? (
                <span className="note">
                  {paper3d && `${overlaysOn ? 'Data' : 'Trim'} ${Math.round(paper3d.wMm)}×${Math.round(paper3d.hMm)}mm · `}
                  Drag to rotate / wheel to zoom (cursor-centered)
                </span>
              ) : (
                <span className="note">
                  {!overlaysOn && 'Finished (trimmed) preview · '}
                  Wheel to zoom (cursor-centered) / drag to pan
                </span>
              )}
            </div>
            {(
              <div className="legend">
                <span className="key"><span className="swatch" style={{ background: 'rgba(40,110,240,.35)' }} />Bleed (trim-off) area</span>
                <span className="key"><span className="swatch" style={{ border: '2px dashed #e11d48', background: 'transparent' }} />Trim line (cut position)</span>
                <span className="key"><span className="swatch" style={{ border: '2px dashed #0d9488', background: 'transparent' }} />Safe area ({settings.safeMarginMm}mm inside)</span>
                <span className="key"><span className="swatch" style={{ border: '2px solid #dc2626', background: 'transparent' }} />Low-resolution image</span>
                {showTac && <span className="key"><span className="swatch" style={{ background: 'rgba(255,40,40,.75)' }} />Total ink over {settings.tacLimit}% (est.)</span>}
                {markerKind && (
                  <span className="key">
                    <span className="swatch" style={{ border: `2.5px solid ${MARKER_STYLE[markerKind].color}`, background: 'transparent' }} />
                    {MARKER_STYLE[markerKind].label} location (approx.)
                  </span>
                )}
              </div>
            )}
          </div>

          <div className="footerNote">
            Note: This tool is a pre-submission self-check and does not replace the print shop’s official data inspection.
            Total-ink judgments on pixels are approximations from RGB rendering (CMYK values of vector objects are judged exactly).
            {result.kind === 'pdf' && ` Criteria: finished ${paperSizeMm(settings.paperId, settings.customWmm, settings.customHmm, settings.landscape).wMm}×${paperSizeMm(settings.paperId, settings.customWmm, settings.customHmm, settings.landscape).hMm}mm / bleed ${settings.bleedMm}mm / ink limit ${settings.tacLimit}% / ${settings.minDpi}dpi or higher`}
          </div>
          </div>

          <ResultsPanel
            findings={result.findings}
            onLocate={onLocate}
            activeMarkerKind={markerKind}
            maxHeight={panelMaxH}
          />
        </div>
      )}

      {scMounted && (
        <div className={`shortcutsOverlay ${scOpen ? 'open' : ''}`} onClick={closeShortcuts}>
          <div className="shortcutsCard" onClick={(e) => e.stopPropagation()}>
            <div className="scHead">
              <span>Keyboard shortcuts</span>
              <button className="scClose" aria-label="Close" onClick={closeShortcuts}>✕</button>
            </div>
            <div className="scGrid">
              <div className="scGroup">
                <div className="scGroupTitle">Pages &amp; views</div>
                <div className="scRow"><span><kbd>←</kbd><kbd>→</kbd></span> Previous / next page</div>
                <div className="scRow"><span><kbd>2</kbd></span> 2D proof</div>
                <div className="scRow"><span><kbd>3</kbd></span> 3D preview</div>
              </div>
              <div className="scGroup">
                <div className="scGroupTitle">Overlays</div>
                <div className="scRow"><span><kbd>G</kbd></span> Toggle guides</div>
                <div className="scRow"><span><kbd>D</kbd></span> Toggle dimensions</div>
                <div className="scRow"><span><kbd>I</kbd></span> Toggle ink overlay</div>
                <div className="scRow"><span><kbd>Esc</kbd></span> Clear “locate” markers</div>
              </div>
              <div className="scGroup">
                <div className="scGroupTitle">3D preview</div>
                <div className="scRow"><span><kbd>Space</kbd></span> Start / stop spin</div>
                <div className="scRow"><span><kbd>F</kbd></span> View front</div>
                <div className="scRow"><span><kbd>B</kbd></span> View back</div>
                <div className="scRow"><span><kbd>R</kbd></span> Reset view</div>
              </div>
              <div className="scGroup">
                <div className="scGroupTitle">2D proof</div>
                <div className="scRow"><span><kbd>+</kbd><kbd>−</kbd></span> Zoom in / out</div>
                <div className="scRow"><span><kbd>0</kbd><kbd>⌘0</kbd></span> Fit to view</div>
                <div className="scRow"><span><kbd>?</kbd></span> Toggle this help</div>
              </div>
            </div>
          </div>
        </div>
      )}
    </>
  );
}
