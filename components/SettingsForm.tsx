'use client';

// Check-settings form (shared by the confirm step and re-check flow).

import type { Settings } from '@/lib/types';
import { PAPER_PRESETS, TAC_CHOICES, DPI_CHOICES } from '@/lib/presets';

interface Props {
  settings: Settings;
  onChange: <K extends keyof Settings>(key: K, value: Settings[K]) => void;
}

export default function SettingsForm({ settings, onChange: set }: Props) {
  return (
    <>
      <div className="formRow">
        <label>仕上がりサイズ</label>
        <select value={settings.paperId} onChange={(e) => set('paperId', e.target.value)}>
          {PAPER_PRESETS.map((p) => <option key={p.id} value={p.id}>{p.label}</option>)}
        </select>
      </div>
      {settings.paperId === 'custom' && (
        <div className="formRow">
          <label>カスタムサイズ (mm)</label>
          <span className="inline">
            <input type="number" value={settings.customWmm} min={10}
              onChange={(e) => set('customWmm', +e.target.value)} />
            ×
            <input type="number" value={settings.customHmm} min={10}
              onChange={(e) => set('customHmm', +e.target.value)} />
          </span>
        </div>
      )}
      <div className="formRow">
        <label>向き</label>
        <select value={settings.landscape ? 'l' : 'p'} onChange={(e) => set('landscape', e.target.value === 'l')}>
          <option value="p">縦 (ポートレート)</option>
          <option value="l">横 (ランドスケープ)</option>
        </select>
      </div>
      <div className="formRow">
        <label>塗り足し幅<span className="hint">通常3mm</span></label>
        <select value={settings.bleedMm} onChange={(e) => set('bleedMm', +e.target.value)}>
          {[0, 2, 3, 5].map((v) => <option key={v} value={v}>{v}mm</option>)}
        </select>
      </div>
      <div className="formRow">
        <label>総インキ量上限<span className="hint">コート紙300% / 上質紙250%が目安</span></label>
        <select value={settings.tacLimit} onChange={(e) => set('tacLimit', +e.target.value)}>
          {TAC_CHOICES.map((v) => <option key={v} value={v}>{v}%</option>)}
        </select>
      </div>
      <div className="formRow">
        <label>必要解像度<span className="hint">カラー/グレー: 300〜350dpi</span></label>
        <select value={settings.minDpi} onChange={(e) => set('minDpi', +e.target.value)}>
          {DPI_CHOICES.map((v) => <option key={v} value={v}>{v}dpi</option>)}
        </select>
      </div>
      <div className="formRow">
        <label>RGBの扱い</label>
        <select value={settings.requireCmyk ? 'e' : 'w'} onChange={(e) => set('requireCmyk', e.target.value === 'e')}>
          <option value="e">エラーにする (CMYK必須)</option>
          <option value="w">注意にとどめる (RGB入稿可)</option>
        </select>
      </div>
    </>
  );
}
