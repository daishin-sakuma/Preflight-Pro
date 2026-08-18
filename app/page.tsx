'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import dynamic from 'next/dynamic';
import type { AnalysisResult, Finding, MarkerKind, Settings } from '@/lib/types';
import { DEFAULT_SETTINGS, MM_PER_PT } from '@/lib/types';
import { PAPER_PRESETS, paperSizeMm } from '@/lib/presets';
import type { PrecheckInfo } from '@/lib/estimateSize';
import ResultsPanel, { worstSeverity } from '@/components/ResultsPanel';
import Preview2D from '@/components/Preview2D';
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
  const out = document.createElement('canvas');
  out.width = Math.max(2, Math.round(w));
  out.height = Math.max(2, Math.round(h));
  out.getContext('2d')!.drawImage(src, x, y, w, h, 0, 0, out.width, out.height);
  return { canvas: out, wMm: (trim[2] - trim[0]) * MM_PER_PT, hMm: (trim[3] - trim[1]) * MM_PER_PT };
}

// Full page (bleed included) composited with the selected overlays — used by
// the 3D preview when guides / dims / TAC are switched on.
function compositedFullPage(
  result: AnalysisResult, settings: Settings, pageIdx: number,
  opts: { showTac: boolean; showGuides: boolean; showDims: boolean; markerKind: MarkerKind | null },
): { canvas: HTMLCanvasElement; wMm: number; hMm: number } | null {
  const src = result.previews[pageIdx];
  const geom = result.pages[pageIdx];
  if (!src || !geom) return null;
  const out = document.createElement('canvas');
  out.width = src.width;
  out.height = src.height;
  out.getContext('2d')!.drawImage(src, 0, 0);
  renderOverlays(out, { result, settings, pageIdx, ...opts });
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

  // preview state
  const [tab, setTab] = useState<'3d' | '2d'>('3d');
  const [pageIdx, setPageIdx] = useState(0);
  const [showTac, setShowTac] = useState(false);
  const [showGuides, setShowGuides] = useState(true);
  const [showDims, setShowDims] = useState(true);
  const [markerKind, setMarkerKind] = useState<MarkerKind | null>(null);
  const [autoRotate, setAutoRotate] = useState(false);
  const [command, setCommand] = useState<ViewCommand>({ cmd: 'reset', n: 0 });

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
      setResult(r);
      setPageIdx(0);
      setTab('3d');
      setPhase('result');
    } catch (e: any) {
      setErrorMsg(e?.message ?? String(e));
      setPhase('error');
    }
  }, []);

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
  const back3d = useMemo(() => {
    if (!result || result.pageCount < 2) return null;
    const other = pageIdx === 0 ? 1 : pageIdx - 1 >= 0 ? pageIdx + (pageIdx % 2 === 0 ? 1 : -1) : null;
    if (other === null || other >= result.previews.length) return null;
    if (overlaysOn) return compositedFullPage(result, settings, other, overlayOpts)?.canvas ?? null;
    return croppedToTrim(result, other)?.canvas ?? null;
  }, [result, pageIdx, overlaysOn, overlayOpts, settings]);

  return (
    <>
      <header className="header">
        <div className="logo">
          <span className="mark">Preflight</span>
        </div>
        <button
          className="btn ghost small themeToggle"
          onClick={() => setTheme((t) => (t === 'dark' ? 'light' : 'dark'))}
          title="Toggle theme"
        >
          {theme === 'dark' ? '☀ Light' : '☾ Dark'}
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
                <div style={{ fontSize: 40 }}>📄</div>
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
        </div>
      )}

      {phase === 'confirm' && fileRef.current && (
        <div className="uploadWrap">
          <div>
            <div className="card">
              <div className="cardHead">Uploaded file</div>
              <div className="cardBody">
                <div className="fileSummary">
                  <span className="fileIcon">📄</span>
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
                          <button className="btn small" onClick={applyDetected}>Use detected settings</button>
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
                      <div className="estSrc">Pre-check summary only. The full inspection runs after you press Start check.</div>
                    </>
                  ) : (
                    <span className="estNone">
                      Could not inspect the file. Set the finished size in the settings panel and start the check.
                    </span>
                  )}
                </div>
                <div className="confirmHint">
                  Make sure the check settings (finished size, bleed, ink limit, etc.) match
                  your order before starting. Settings are saved for next time and can also be
                  changed on the results screen to re-run the check.
                </div>
                <div className="confirmActions">
                  <button className="btn big" onClick={() => fileRef.current && runAnalysis(fileRef.current, settings)}>
                    Start check
                  </button>
                </div>
              </div>
            </div>
          </div>

          <div className="card">
            <div className="cardHead">Check settings</div>
            <div className="cardBody">
              <SettingsForm settings={settings} onChange={set} />
            </div>
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
          <div className="fileBar">
            <span className="name">{result.fileName}</span>
            <span className="meta">
              {(result.fileSize / 1024 / 1024).toFixed(2)}MB · {result.pageCount} page{result.pageCount > 1 ? 's' : ''} ·
              {result.kind === 'pdf' ? ' PDF' : ` ${result.imageInfo?.format.toUpperCase()} image`}
            </span>
            <span className="right">
              <button className="btn ghost small" onClick={() => setPhase('confirm')}>
                Change settings &amp; re-check
              </button>
              <button className="btn small" onClick={() => { setResult(null); fileRef.current = null; setPhase('upload'); }}>
                Check another file
              </button>
            </span>
          </div>

          <div className={`summaryBanner ${summary.errs ? 'fail' : summary.warns ? 'warn' : 'pass'}`}>
            {summary.errs
              ? `Problems were found that need fixing`
              : summary.warns
                ? `Ready to submit, but some items are worth reviewing`
                : `All checks passed`}
            <span className="chips">
              {summary.errs > 0 && <span className="chip err">Errors {summary.errs}</span>}
              {summary.warns > 0 && <span className="chip warn">Warnings {summary.warns}</span>}
              <span className="chip ok">OK {summary.oks}</span>
            </span>
          </div>

          <div className="previewCol">
          <div className="card previewCard">
            <div className="previewTabs">
              <button className={tab === '3d' ? 'on' : ''} onClick={() => setTab('3d')}>3D preview</button>
              <button className={tab === '2d' ? 'on' : ''} onClick={() => setTab('2d')}>2D proof</button>
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
                />
              )}
              {tab === '2d' && (
                <Preview2D
                  result={result}
                  settings={settings}
                  pageIdx={pageIdx}
                  showTac={showTac}
                  showGuides={showGuides}
                  showDims={showDims}
                  markerKind={markerKind}
                />
              )}
            </div>
            <div className="previewCtrl">
              {result.pageCount > 1 && (
                <>
                  <select value={pageIdx} onChange={(e) => setPageIdx(+e.target.value)}>
                    {result.previews.map((_, i) => (
                      <option key={i} value={i}>
                        {result.pageCount === 2 ? (i === 0 ? 'Front' : 'Back') : `Page ${i + 1}`}
                      </option>
                    ))}
                  </select>
                  <span className="sep" />
                </>
              )}
              {tab === '3d' && (
                <>
                  <button className={`btn ghost small ${autoRotate ? 'active' : ''}`}
                    onClick={() => setAutoRotate((v) => !v)}>
                    {autoRotate ? '⏸ Stop' : '▶ Spin'}
                  </button>
                  <button className="btn ghost small" onClick={() => setCommand((c) => ({ cmd: 'front', n: c.n + 1 }))}>Front</button>
                  <button className="btn ghost small" onClick={() => setCommand((c) => ({ cmd: 'back', n: c.n + 1 }))}>Back</button>
                  <button className="btn ghost small" onClick={() => setCommand((c) => ({ cmd: 'reset', n: c.n + 1 }))}>Reset</button>
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
                  ◎ Showing “{MARKER_STYLE[markerKind].label}” ✕
                </button>
              )}
              {tab === '3d' ? (
                <span className="note">
                  {paper3d && `${overlaysOn ? 'Data' : 'Trim'} ${Math.round(paper3d.wMm)}×${Math.round(paper3d.hMm)}mm · `}
                  Drag to rotate / wheel to zoom (cursor-centered)
                </span>
              ) : (
                <span className="note">Wheel to zoom (cursor-centered) / drag to pan</span>
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
          />
        </div>
      )}
    </>
  );
}
