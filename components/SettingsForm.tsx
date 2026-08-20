'use client';

// Check-settings form (shared by the confirm step and re-check flow).

import { useEffect, useRef, useState } from 'react';
import type { Settings } from '@/lib/types';
import { PAPER_PRESETS, TAC_CHOICES, DPI_CHOICES, SCALE_CHOICES } from '@/lib/presets';

interface Props {
  settings: Settings;
  onChange: <K extends keyof Settings>(key: K, value: Settings[K]) => void;
}

// Numeric input that keeps an editable string draft, so the field can be cleared
// (empty) while editing instead of snapping to 0. Commits a number on change/blur.
function NumberField({
  value, onCommit, min, max, step,
}: { value: number; onCommit: (v: number) => void; min?: number; max?: number; step?: number }) {
  const [draft, setDraft] = useState(String(value));
  const focused = useRef(false);
  // sync from outside (e.g. "Use detected settings") only when not being edited
  useEffect(() => { if (!focused.current) setDraft(String(value)); }, [value]);
  return (
    <input
      type="number" value={draft} min={min} max={max} step={step}
      onFocus={(e) => { focused.current = true; e.currentTarget.select(); }}
      onChange={(e) => {
        const s = e.target.value;
        setDraft(s);
        if (s !== '' && !Number.isNaN(Number(s))) onCommit(Number(s));
      }}
      onBlur={() => {
        focused.current = false;
        if (draft === '' || Number.isNaN(Number(draft))) setDraft(String(value));
        else { const n = Number(draft); onCommit(n); setDraft(String(n)); }
      }}
    />
  );
}

export default function SettingsForm({ settings, onChange: set }: Props) {
  const BLEED_CHOICES = [0, 2, 3, 5, 10];
  // "Custom" is a sticky, explicit mode: once chosen it stays even if the value
  // happens to equal a preset. It also turns on for any non-preset value.
  const [tacCustom, setTacCustom] = useState(false);
  const [dpiCustom, setDpiCustom] = useState(false);
  const [bleedCustom, setBleedCustom] = useState(false);
  const [scaleCustom, setScaleCustom] = useState(false);
  const showTacCustom = tacCustom || !TAC_CHOICES.includes(settings.tacLimit);
  const showDpiCustom = dpiCustom || !DPI_CHOICES.includes(settings.minDpi);
  const showBleedCustom = bleedCustom || !BLEED_CHOICES.includes(settings.bleedMm);
  const showScaleCustom = scaleCustom || !SCALE_CHOICES.includes(settings.scale);
  const fmtScale = (v: number) => (v === 1 ? '1:1 (full size)' : `1:${v}`);
  return (
    <>
      <div className="formRow">
        <label>Finished size</label>
        <select
          value={settings.paperId}
          onChange={(e) => {
            const id = e.target.value;
            set('paperId', id);
            // default the orientation to the preset's natural shape (so e.g.
            // "Business card JP (91×55)" lands as landscape, matching its label)
            const p = PAPER_PRESETS.find((q) => q.id === id);
            if (p && id !== 'custom') set('landscape', p.wMm > p.hMm);
          }}>
          {PAPER_PRESETS.map((p) => <option key={p.id} value={p.id}>{p.label}</option>)}
        </select>
      </div>
      {settings.paperId === 'custom' && (
        <div className="formRow">
          <label>Custom size (mm)</label>
          <span className="inline">
            <NumberField value={settings.customWmm} min={10} onCommit={(v) => set('customWmm', v)} />
            ×
            <NumberField value={settings.customHmm} min={10} onCommit={(v) => set('customHmm', v)} />
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
        <label>Design scale<span className="hint">For reduced-scale large-format data</span></label>
        <select
          value={showScaleCustom ? 'custom' : String(settings.scale)}
          onChange={(e) => {
            if (e.target.value === 'custom') setScaleCustom(true);
            else { setScaleCustom(false); set('scale', +e.target.value); }
          }}>
          {SCALE_CHOICES.map((v) => <option key={v} value={v}>{fmtScale(v)}</option>)}
          <option value="custom">Custom…</option>
        </select>
      </div>
      {showScaleCustom && (
        <div className="formRow">
          <label>Custom scale (1 : N)</label>
          <span className="inline">
            1 :
            <NumberField value={settings.scale} min={0.01} step={0.1} onCommit={(v) => set('scale', v)} />
          </span>
        </div>
      )}
      <div className="formRow">
        <label>Bleed<span className="hint">Usually 3mm</span></label>
        <select
          value={showBleedCustom ? 'custom' : String(settings.bleedMm)}
          onChange={(e) => {
            if (e.target.value === 'custom') setBleedCustom(true);
            else { setBleedCustom(false); set('bleedMm', +e.target.value); }
          }}>
          {BLEED_CHOICES.map((v) => <option key={v} value={v}>{v}mm</option>)}
          <option value="custom">Custom…</option>
        </select>
      </div>
      {showBleedCustom && (
        <div className="formRow">
          <label>Custom bleed (mm)</label>
          <span className="inline">
            <NumberField value={settings.bleedMm} min={0} max={50} step={0.5} onCommit={(v) => set('bleedMm', v)} />
            mm
          </span>
        </div>
      )}
      <div className="formRow">
        <label>Total ink limit<span className="hint">Coated ~300% / uncoated ~250%</span></label>
        <select
          value={showTacCustom ? 'custom' : String(settings.tacLimit)}
          onChange={(e) => {
            if (e.target.value === 'custom') setTacCustom(true);
            else { setTacCustom(false); set('tacLimit', +e.target.value); }
          }}>
          {TAC_CHOICES.map((v) => <option key={v} value={v}>{v}%</option>)}
          <option value="custom">Custom…</option>
        </select>
      </div>
      {showTacCustom && (
        <div className="formRow">
          <label>Custom ink limit (%)</label>
          <span className="inline">
            <NumberField value={settings.tacLimit} min={1} max={400} step={1} onCommit={(v) => set('tacLimit', v)} />
            %
          </span>
        </div>
      )}
      <div className="formRow">
        <label>Required resolution<span className="hint">Color/gray: 300–350dpi</span></label>
        <select
          value={showDpiCustom ? 'custom' : String(settings.minDpi)}
          onChange={(e) => {
            if (e.target.value === 'custom') setDpiCustom(true);
            else { setDpiCustom(false); set('minDpi', +e.target.value); }
          }}>
          {DPI_CHOICES.map((v) => <option key={v} value={v}>{v}dpi</option>)}
          <option value="custom">Custom…</option>
        </select>
      </div>
      {showDpiCustom && (
        <div className="formRow">
          <label>Custom resolution (dpi)</label>
          <span className="inline">
            <NumberField value={settings.minDpi} min={1} step={1} onCommit={(v) => set('minDpi', v)} />
            dpi
          </span>
        </div>
      )}
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
