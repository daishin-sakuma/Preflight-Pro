'use client';

// Numbered check-category sidebar (graphic-style) with per-item details.

import { useCallback, useEffect, useRef, useState } from 'react';
import type { Finding, Severity, CategoryId } from '@/lib/types';
import { CATEGORY_LABELS, CATEGORY_ORDER } from '@/lib/types';

const SEV_RANK: Record<Severity, number> = { ok: 0, info: 1, warning: 2, error: 3 };
const SEV_LABEL: Record<Severity, string> = { ok: 'OK', info: 'INFO', warning: 'WARN', error: 'ERROR' };

export function worstSeverity(items: Finding[]): Severity {
  return items.reduce<Severity>(
    (w, x) => (SEV_RANK[x.severity] > SEV_RANK[w] ? x.severity : w), 'ok',
  );
}

interface Props {
  findings: Finding[];
  // Called when the user asks to see a finding's spots on the 2D preview.
  onLocate?: (finding: Finding) => void;
  // Currently highlighted marker kind (to render the button as active).
  activeMarkerKind?: string | null;
  // desktop: cap the scroll area to the preview column's height (px)
  maxHeight?: number;
}

export default function ResultsPanel({ findings, onLocate, activeMarkerKind, maxHeight }: Props) {
  const cats = CATEGORY_ORDER
    .map((cat) => ({ cat, items: findings.filter((x) => x.category === cat) }))
    .filter((c) => c.items.length > 0);

  const [open, setOpen] = useState<Record<CategoryId, boolean>>(() => {
    const o = {} as Record<CategoryId, boolean>;
    for (const { cat } of cats) o[cat] = true; // all categories open by default
    return o;
  });

  // Gemini-style soft fade at the top/bottom edges. Opacity is proportional to
  // how far you've scrolled from that edge (ramps 0→1 over RAMP px), so a slow
  // scroll reveals it gradually; a 0.3s transition (in CSS) smooths the change.
  const scrollRef = useRef<HTMLDivElement>(null);
  const topFadeRef = useRef<HTMLDivElement>(null);
  const botFadeRef = useRef<HTMLDivElement>(null);
  // instant = true skips the ease (used for layout changes like the initial
  // load, so a needed fade is shown from the start rather than animating in).
  const recompute = useCallback((instant = false) => {
    const el = scrollRef.current;
    if (!el) return;
    const RAMP = 4;
    const top = Math.min(1, Math.max(0, el.scrollTop / RAMP));
    const bottom = Math.min(1, Math.max(0, (el.scrollHeight - el.clientHeight - el.scrollTop) / RAMP));
    const apply = (ref: React.RefObject<HTMLDivElement>, v: number) => {
      const n = ref.current;
      if (!n) return;
      if (instant) {
        n.style.transition = 'none';
        n.style.opacity = String(v);
        requestAnimationFrame(() => { if (n) n.style.transition = ''; }); // re-enable ease
      } else {
        n.style.opacity = String(v);
      }
    };
    apply(topFadeRef, top);
    apply(botFadeRef, bottom);
  }, []);
  // layout-driven updates (mount / height / content) are instant
  useEffect(() => { recompute(true); }, [recompute, maxHeight, findings, open]);

  return (
    <div className="resultsCol">
      <div className="resultsFade top" ref={topFadeRef} aria-hidden="true" />
      <div
        className="resultsScroll"
        ref={scrollRef}
        onScroll={() => recompute()}
        style={maxHeight ? { maxHeight } : undefined}
      >
      {cats.map(({ cat, items }, i) => {
        const worst = worstSeverity(items);
        const sorted = [...items].sort((a, b) => SEV_RANK[b.severity] - SEV_RANK[a.severity]);
        return (
          <div className="catCard" key={cat}>
            <button className="catHead" onClick={() => setOpen((o) => ({ ...o, [cat]: !o[cat] }))}>
              <span className="num">{i + 1}</span>
              <span className="label">{CATEGORY_LABELS[cat]}</span>
              <span className={`status ${worst}`}>{SEV_LABEL[worst]}</span>
              <span className="catChev">{open[cat] ? '▲' : '▼'}</span>
            </button>
            {open[cat] && (
              <div className="catBody">
                {sorted.map((x) => (
                  <div className="finding" key={x.id}>
                    <div className="fTitle">
                      <span className={`dot ${x.severity}`} />
                      {x.title}
                      {x.count ? <span className="fCount">({x.count})</span> : null}
                    </div>
                    <div className="fDetail">{x.detail}</div>
                    {x.pages && x.pages.length > 0 && (
                      <div className="fPages">Pages: {x.pages.join(', ')}</div>
                    )}
                    {x.markerKind && onLocate && (
                      <div className="fLocate">
                        <button
                          className={`locateBtn ${activeMarkerKind === x.markerKind ? 'on' : ''}`}
                          onClick={() => onLocate(x)}
                        >
                          ◎ Locate on preview
                        </button>
                      </div>
                    )}
                  </div>
                ))}
              </div>
            )}
          </div>
        );
      })}
      </div>
      <div className="resultsFade bottom" ref={botFadeRef} aria-hidden="true" />
    </div>
  );
}
