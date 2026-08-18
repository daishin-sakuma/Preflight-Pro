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
  pdf: 'PDF', ai: 'Illustrator (PDF互換)', jpg: 'JPEG', jpeg: 'JPEG', png: 'PNG',
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
    setProgress('ファイルを読み込み中…');
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
  // starts when the user explicitly presses チェックを開始. Size estimation
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

  const estimateMatchesSettings = useMemo(() => {
    if (!pre?.size) return false;
    const cur = paperSizeMm(settings.paperId, settings.customWmm, settings.customHmm, settings.landscape);
    return Math.abs(cur.wMm - pre.size.wMm) <= 0.6 && Math.abs(cur.hMm - pre.size.hMm) <= 0.6;
  }, [pre, settings]);

  const applyEstimate = useCallback(() => {
    const est = pre?.size;
    if (!est) return;
    setSettings((s) => est.presetId
      ? { ...s, paperId: est.presetId!, landscape: est.landscape }
      : { ...s, paperId: 'custom', customWmm: est.wMm, customHmm: est.hMm, landscape: false });
  }, [pre]);

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
          <span className="mark">Preflight Pro</span>
          <span className="sub">入稿データチェック</span>
        </div>
        <button
          className="btn ghost small themeToggle"
          onClick={() => setTheme((t) => (t === 'dark' ? 'light' : 'dark'))}
          title="テーマ切替"
        >
          {theme === 'dark' ? '☀ ライトモード' : '☾ ダークモード'}
        </button>
      </header>

      {phase === 'upload' && (
        <div className="uploadWrap single">
          <div className="card">
            <div className="cardHead">入稿データのアップロード</div>
            <div className="cardBody">
              <div
                className={`dropzone ${drag ? 'drag' : ''}`}
                onDragOver={(e) => { e.preventDefault(); setDrag(true); }}
                onDragLeave={() => setDrag(false)}
                onDrop={(e) => { e.preventDefault(); setDrag(false); onFiles(e.dataTransfer.files); }}
              >
                <div style={{ fontSize: 40 }}>📄</div>
                <div className="big">ファイルをドラッグ＆ドロップ</div>
                <div>または</div>
                <button className="btn" onClick={() => inputRef.current?.click()}>
                  ファイルを選択
                </button>
                <input
                  ref={inputRef}
                  type="file"
                  accept=".pdf,.ai,.jpg,.jpeg,.png"
                  style={{ display: 'none' }}
                  onChange={(e) => onFiles(e.target.files)}
                />
                <div className="formats">
                  対応形式: PDF / Illustrator (.ai ※PDF互換保存) / JPEG / PNG<br />
                  解析はすべてブラウザ内で行われ、データが外部に送信されることはありません。<br />
                  アップロード後、次の画面でチェック設定 (サイズ・塗り足し・インキ量など) を確認できます。
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
              <div className="cardHead">アップロードしたファイル</div>
              <div className="cardBody">
                <div className="fileSummary">
                  <span className="fileIcon">📄</span>
                  <div>
                    <div className="fsName">{fileRef.current.name}</div>
                    <div className="fsMeta">
                      {FORMAT_LABELS[fileRef.current.name.split('.').pop()?.toLowerCase() ?? ''] ?? '不明な形式'}
                      {' ・ '}{(fileRef.current.size / 1024 / 1024).toFixed(2)}MB
                    </div>
                  </div>
                  <button className="btn ghost small" style={{ marginLeft: 'auto' }}
                    onClick={() => { fileRef.current = null; setPhase('upload'); }}>
                    ファイルを選び直す
                  </button>
                </div>
                <div className="estimateBox">
                  {estimating ? (
                    <span className="estWait">データを精査中…</span>
                  ) : pre ? (
                    <>
                      <div className="estHead">データからの読み取り結果 (事前精査)</div>
                      <div className="pcGrid">
                        <span className="pcLabel">推定仕上がり</span>
                        <span className="pcValue">
                          {pre.size ? (
                            <>
                              <span className="estValue">
                                {pre.size.presetId
                                  ? `${PAPER_PRESETS.find((p) => p.id === pre.size!.presetId)?.label ?? ''}${pre.size.landscape ? ' 横' : ''}`
                                  : `${pre.size.wMm}×${pre.size.hMm}mm (カスタム)`}
                              </span>
                              {estimateMatchesSettings ? (
                                <span className="estOk">✓ 設定と一致</span>
                              ) : (
                                <button className="btn small" onClick={applyEstimate}>この推定サイズを使用</button>
                              )}
                              <span className="pcSub">{pre.size.sourceLabel}</span>
                            </>
                          ) : (
                            <span className="pcDim">推定不可 (解像度情報なし) — 右の設定で指定してください</span>
                          )}
                        </span>

                        <span className="pcLabel">塗り足し</span>
                        <span className="pcValue">
                          {pre.kind === 'pdf' ? (
                            pre.hasTrimBox && pre.bleedMm !== null ? (
                              pre.bleedMm >= settings.bleedMm - 0.3
                                ? <span className="pcOk">約{pre.bleedMm}mm ✓</span>
                                : pre.bleedMm > 0.3
                                  ? <span className="pcWarn">約{pre.bleedMm}mm (必要: {settings.bleedMm}mm) ⚠</span>
                                  : <span className="pcWarn">なし ⚠</span>
                            ) : <span className="pcDim">TrimBox未設定のため測定不可 (本チェックでサイズから判定)</span>
                          ) : <span className="pcDim">画像入稿のため本チェックで判定</span>}
                        </span>

                        <span className="pcLabel">ページ数</span>
                        <span className="pcValue">{pre.pageCount ?? '—'}</span>

                        <span className="pcLabel">カラー</span>
                        <span className="pcValue">
                          {pre.colorHint === 'cmyk' && <span className="pcOk">CMYK ✓</span>}
                          {pre.colorHint === 'rgb-mixed' && <span className="pcWarn">RGBを含む ⚠</span>}
                          {pre.colorHint === 'gray' && 'グレースケール'}
                          {pre.colorHint === 'unknown' && <span className="pcDim">判定不能</span>}
                        </span>

                        {pre.image && (
                          <>
                            <span className="pcLabel">画像情報</span>
                            <span className="pcValue">
                              {pre.image.format.toUpperCase()} ・ {pre.image.colorSpace} ・ {pre.image.width}×{pre.image.height}px
                              {pre.image.dpi ? ` ・ ${pre.image.dpi}dpi` : ' ・ 解像度情報なし'}
                              {pre.image.hasAlpha && <span className="pcWarn"> ・ 透明あり ⚠</span>}
                            </span>
                          </>
                        )}

                        {(pre.encrypted || pre.fontsNotEmbedded > 0 || pre.spotColors > 0) && (
                          <>
                            <span className="pcLabel">注意</span>
                            <span className="pcValue pcWarn">
                              {[
                                pre.encrypted && '暗号化あり',
                                pre.fontsNotEmbedded > 0 && `未埋め込みフォント ${pre.fontsNotEmbedded}書体`,
                                pre.spotColors > 0 && `特色 ${pre.spotColors}色`,
                              ].filter(Boolean).join(' ・ ')} ⚠
                            </span>
                          </>
                        )}
                      </div>
                      <div className="estSrc">※事前精査の概要です。詳細な検査は「チェックを開始」後に実施されます。</div>
                    </>
                  ) : (
                    <span className="estNone">
                      データを精査できませんでした。右の設定で仕上がりサイズを指定し、そのままチェックを開始してください。
                    </span>
                  )}
                </div>
                <div className="confirmHint">
                  右のチェック設定 (仕上がりサイズ・塗り足し・総インキ量の上限など) が
                  注文内容と合っているか確認してから、チェックを開始してください。
                  設定は次回のために自動保存され、結果画面からも変更して再チェックできます。
                </div>
                <div className="confirmActions">
                  <button className="btn big" onClick={() => fileRef.current && runAnalysis(fileRef.current, settings)}>
                    この設定でチェックを開始
                  </button>
                </div>
              </div>
            </div>
          </div>

          <div className="card">
            <div className="cardHead">チェック設定</div>
            <div className="cardBody">
              <SettingsForm settings={settings} onChange={set} />
            </div>
          </div>
        </div>
      )}

      {phase === 'analyzing' && (
        <div className="analyzing">
          <div className="spinner" />
          <h2>データチェック中…</h2>
          <div className="msg">{progress}</div>
        </div>
      )}

      {phase === 'error' && (
        <div className="errorBox">
          <h2>チェックできませんでした</h2>
          <p>{errorMsg}</p>
          <p style={{ marginTop: 18 }}>
            <button className="btn" onClick={() => setPhase('upload')}>アップロードに戻る</button>
          </p>
        </div>
      )}

      {phase === 'result' && result && summary && (
        <div className="resultWrap">
          <div className="fileBar">
            <span className="name">{result.fileName}</span>
            <span className="meta">
              {(result.fileSize / 1024 / 1024).toFixed(2)}MB ・ {result.pageCount}ページ ・
              {result.kind === 'pdf' ? ' PDF' : ` ${result.imageInfo?.format.toUpperCase()}画像`}
            </span>
            <span className="right">
              <button className="btn ghost small" onClick={() => setPhase('confirm')}>
                設定を変えて再チェック
              </button>
              <button className="btn small" onClick={() => { setResult(null); fileRef.current = null; setPhase('upload'); }}>
                別のファイルをチェック
              </button>
            </span>
          </div>

          <div className={`summaryBanner ${summary.errs ? 'fail' : summary.warns ? 'warn' : 'pass'}`}>
            {summary.errs
              ? `修正が必要な問題が見つかりました`
              : summary.warns
                ? `入稿は可能ですが、確認をおすすめする項目があります`
                : `すべてのチェックに合格しました`}
            <span className="chips">
              {summary.errs > 0 && <span className="chip err">エラー {summary.errs}</span>}
              {summary.warns > 0 && <span className="chip warn">注意 {summary.warns}</span>}
              <span className="chip ok">OK {summary.oks}</span>
            </span>
          </div>

          <div className="previewCol">
          <div className="card previewCard">
            <div className="previewTabs">
              <button className={tab === '3d' ? 'on' : ''} onClick={() => setTab('3d')}>3Dプレビュー</button>
              <button className={tab === '2d' ? 'on' : ''} onClick={() => setTab('2d')}>2D校正ビュー</button>
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
                        {result.pageCount === 2 ? (i === 0 ? '表面' : '裏面') : `ページ ${i + 1}`}
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
                    {autoRotate ? '⏸ 回転停止' : '▶ 3D回転'}
                  </button>
                  <button className="btn ghost small" onClick={() => setCommand((c) => ({ cmd: 'front', n: c.n + 1 }))}>正面</button>
                  <button className="btn ghost small" onClick={() => setCommand((c) => ({ cmd: 'back', n: c.n + 1 }))}>背面</button>
                  <button className="btn ghost small" onClick={() => setCommand((c) => ({ cmd: 'reset', n: c.n + 1 }))}>リセット</button>
                  <span className="sep" />
                </>
              )}
              <button className={`btn ghost small ${showGuides ? 'active' : ''}`}
                onClick={() => setShowGuides((v) => !v)}>
                ガイド表示
              </button>
              <button className={`btn ghost small ${showDims ? 'active' : ''}`}
                onClick={() => setShowDims((v) => !v)}>
                寸法表示
              </button>
              <button className={`btn ghost small ${showTac ? 'active' : ''}`}
                onClick={() => setShowTac((v) => !v)}>
                インキ量 ({settings.tacLimit}%超を表示)
              </button>
              {markerKind && (
                <button className="btn ghost small markerClear"
                  style={{ borderColor: MARKER_STYLE[markerKind].color, color: MARKER_STYLE[markerKind].color }}
                  onClick={() => setMarkerKind(null)}>
                  ◎ {MARKER_STYLE[markerKind].label} の該当箇所を表示中 ✕
                </button>
              )}
              {tab === '3d' ? (
                <span className="note">
                  {paper3d && `${overlaysOn ? 'データ' : '仕上がり'} ${Math.round(paper3d.wMm)}×${Math.round(paper3d.hMm)}mm ・ `}
                  ドラッグで回転 / ホイールで拡大縮小 (カーソル中心)
                </span>
              ) : (
                <span className="note">ホイールでズーム (カーソル中心) / ドラッグで移動</span>
              )}
            </div>
            {showGuides && (
              <div className="legend">
                <span className="key"><span className="swatch" style={{ background: 'rgba(40,110,240,.35)' }} />塗り足し (断ち落とし) 領域</span>
                <span className="key"><span className="swatch" style={{ border: '2px dashed #e11d48', background: 'transparent' }} />仕上がり線 (断裁位置)</span>
                <span className="key"><span className="swatch" style={{ border: '2px dashed #0d9488', background: 'transparent' }} />文字安全域 ({settings.safeMarginMm}mm内側)</span>
                <span className="key"><span className="swatch" style={{ border: '2px solid #dc2626', background: 'transparent' }} />低解像度画像</span>
                {showTac && <span className="key"><span className="swatch" style={{ background: 'rgba(255,40,40,.75)' }} />総インキ量{settings.tacLimit}%超 (推定)</span>}
                {markerKind && (
                  <span className="key">
                    <span className="swatch" style={{ border: `2.5px solid ${MARKER_STYLE[markerKind].color}`, background: 'transparent' }} />
                    {MARKER_STYLE[markerKind].label} の該当箇所 (概略位置)
                  </span>
                )}
              </div>
            )}
          </div>

          <div className="footerNote">
            ※ 本ツールの判定は入稿前のセルフチェックを目的とした解析であり、印刷所の正式なデータチェックを代替するものではありません。
            総インキ量のピクセル判定はRGBレンダリングからの近似値です (ベクターオブジェクトのCMYK値は正確に判定されます)。
            {result.kind === 'pdf' && ` 判定基準: 仕上がり ${paperSizeMm(settings.paperId, settings.customWmm, settings.customHmm, settings.landscape).wMm}×${paperSizeMm(settings.paperId, settings.customWmm, settings.customHmm, settings.landscape).hMm}mm / 塗り足し${settings.bleedMm}mm / TAC上限${settings.tacLimit}% / ${settings.minDpi}dpi以上`}
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
