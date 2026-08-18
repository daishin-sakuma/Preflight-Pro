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
        <label>Finished size</label>
        <select value={settings.paperId} onChange={(e) => set('paperId', e.target.value)}>
          {PAPER_PRESETS.map((p) => <option key={p.id} value={p.id}>{p.label}</option>)}
        </select>
      </div>
      {settings.paperId === 'custom' && (
        <div className="formRow">
          <label>Custom size (mm)</label>
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
        <label>Orientation</label>
        <select value={settings.landscape ? 'l' : 'p'} onChange={(e) => set('landscape', e.target.value === 'l')}>
          <option value="p">Portrait</option>
          <option value="l">Landscape</option>
        </select>
      </div>
      <div className="formRow">
        <label>Bleed<span className="hint">Usually 3mm</span></label>
        <select value={settings.bleedMm} onChange={(e) => set('bleedMm', +e.target.value)}>
          {[0, 2, 3, 5].map((v) => <option key={v} value={v}>{v}mm</option>)}
        </select>
      </div>
      <div className="formRow">
        <label>Total ink limit<span className="hint">Coated ~300% / uncoated ~250%</span></label>
        <select value={settings.tacLimit} onChange={(e) => set('tacLimit', +e.target.value)}>
          {TAC_CHOICES.map((v) => <option key={v} value={v}>{v}%</option>)}
        </select>
      </div>
      <div className="formRow">
        <label>Required resolution<span className="hint">Color/gray: 300–350dpi</span></label>
        <select value={settings.minDpi} onChange={(e) => set('minDpi', +e.target.value)}>
          {DPI_CHOICES.map((v) => <option key={v} value={v}>{v}dpi</option>)}
        </select>
      </div>
      <div className="formRow">
        <label>RGB handling</label>
        <select value={settings.requireCmyk ? 'e' : 'w'} onChange={(e) => set('requireCmyk', e.target.value === 'e')}>
          <option value="e">Treat as error (CMYK required)</option>
          <option value="w">Warn only (RGB allowed)</option>
        </select>
      </div>
    </>
  );
}
