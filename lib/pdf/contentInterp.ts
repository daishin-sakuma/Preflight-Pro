// Minimal PDF content-stream interpreter.
// pdf.js normalizes all colors to RGB in its operator list, so raw CMYK values
// (needed for exact TAC / rich-black / registration checks) must be read from
// the content streams directly. This walks tokens tracking just enough state:
// graphics stack, fill/stroke color, text mode, line width, ExtGState usage.

import type { CmykUsage, ContentStats } from '../types.ts';

type Tok = { t: 'num'; v: number } | { t: 'name'; v: string } | { t: 'op'; v: string } | { t: 'other' };

function* tokenize(src: string): Generator<Tok> {
  const n = src.length;
  let i = 0;
  while (i < n) {
    const c = src[i];
    if (c === ' ' || c === '\n' || c === '\r' || c === '\t' || c === '\f' || c === '\0') { i++; continue; }
    if (c === '%') { // comment
      while (i < n && src[i] !== '\n' && src[i] !== '\r') i++;
      continue;
    }
    if (c === '(') { // string with nesting/escapes
      let depth = 1; i++;
      while (i < n && depth > 0) {
        const ch = src[i];
        if (ch === '\\') i++;
        else if (ch === '(') depth++;
        else if (ch === ')') depth--;
        i++;
      }
      yield { t: 'other' };
      continue;
    }
    if (c === '<') {
      if (src[i + 1] === '<') { i += 2; yield { t: 'other' }; continue; }
      const e = src.indexOf('>', i);
      i = e === -1 ? n : e + 1;
      yield { t: 'other' };
      continue;
    }
    if (c === '>' && src[i + 1] === '>') { i += 2; yield { t: 'other' }; continue; }
    if (c === '[' || c === ']' || c === '{' || c === '}') { i++; yield { t: 'other' }; continue; }
    if (c === '/') {
      let j = i + 1;
      while (j < n && !/[\s()<>\[\]{}/%]/.test(src[j])) j++;
      yield { t: 'name', v: src.slice(i + 1, j) };
      i = j;
      continue;
    }
    if (/[-+.\d]/.test(c)) {
      let j = i + 1;
      while (j < n && /[.\d\-+eE]/.test(src[j])) j++;
      const v = parseFloat(src.slice(i, j));
      i = j;
      yield Number.isFinite(v) ? { t: 'num', v } : { t: 'other' };
      continue;
    }
    // operator (letters, *, ', ")
    let j = i;
    while (j < n && /[A-Za-z'"*01]/.test(src[j])) j++;
    if (j === i) { i++; yield { t: 'other' }; continue; }
    const op = src.slice(i, j);
    i = j;
    if (op === 'BI') {
      // inline image: skip binary data up to EI
      const id = src.indexOf('ID', i);
      if (id !== -1) {
        const ei = src.indexOf('EI', id + 2);
        i = ei === -1 ? n : ei + 2;
      }
      yield { t: 'op', v: 'BI' };
      continue;
    }
    yield { t: 'op', v: op };
  }
}

interface GState {
  space: 'rgb' | 'cmyk' | 'gray' | 'other';
  color: number[];
  gsActive: boolean;
  lineWidth: number;
  scale: number; // avg |scale| of CTM (approx, for line width)
}

const mag = (a: number, b: number) => Math.hypot(a, b);

export function interpretContent(
  streams: string[],
  docHasOverprint: boolean,
  // colorspace resource name -> kind (resolved by rawScan; e.g. CS0 -> cmyk for
  // Illustrator's ICCBased CMYK). Without this, `/CS0 cs 0 0 0 0 scn` would be
  // unclassifiable and AI/InDesign colors would go undetected.
  csNames: Record<string, { kind: 'cmyk' | 'rgb' | 'gray' | 'sep' | 'other' }> = {},
): ContentStats {
  const cmykMap = new Map<string, CmykUsage>();
  const richText: CmykUsage[] = [];
  let rgbOps = 0, grayOps = 0, whiteFillWithGs = 0, hairlineCount = 0;
  let minLW: number | null = null;

  const record = (vals: number[], inText: boolean, isFill: boolean) => {
    const [c, m, y, k] = vals;
    const key = vals.map((v) => Math.round(v * 100)).join(',') + (inText ? 'T' : '');
    const tac = (c + m + y + k) * 100;
    const prev = cmykMap.get(key);
    if (prev) return prev;
    const u: CmykUsage = { c, m, y, k, tac, inText, page: 0, isFill };
    cmykMap.set(key, u);
    // rich black in text: 3+ channels heavily inked
    const heavy = vals.filter((v) => v >= 0.7).length;
    if (inText && heavy >= 3) richText.push(u);
    return u;
  };

  for (const src of streams) {
    const st: GState = { space: 'other', color: [], gsActive: false, lineWidth: 1, scale: 1 };
    const stack: GState[] = [];
    let inText = false;
    const nums: number[] = [];
    let lastName: string | null = null;

    try {
      for (const tok of tokenize(src)) {
        if (tok.t === 'num') { nums.push(tok.v); if (nums.length > 8) nums.shift(); continue; }
        if (tok.t === 'name') { lastName = tok.v; continue; }
        if (tok.t === 'other') { continue; }
        const op = tok.v;
        switch (op) {
          case 'q': stack.push({ ...st, color: [...st.color] }); break;
          case 'Q': { const p = stack.pop(); if (p) Object.assign(st, p); break; }
          case 'cm': {
            if (nums.length >= 6) {
              const [a, b, c2, d] = nums.slice(-6);
              const s = (mag(a, b) + mag(c2, d)) / 2;
              if (Number.isFinite(s) && s > 0) st.scale *= s;
            }
            break;
          }
          case 'rg': case 'RG': {
            rgbOps++;
            st.space = 'rgb';
            st.color = nums.slice(-3);
            break;
          }
          case 'g': case 'G': {
            grayOps++;
            st.space = 'gray';
            st.color = nums.slice(-1);
            break;
          }
          case 'k': case 'K': {
            st.space = 'cmyk';
            st.color = nums.slice(-4);
            if (st.color.length === 4) record(st.color, inText && op === 'k', op === 'k');
            break;
          }
          case 'cs': case 'CS': {
            if (lastName === 'DeviceCMYK') st.space = 'cmyk';
            else if (lastName === 'DeviceRGB') st.space = 'rgb';
            else if (lastName === 'DeviceGray') st.space = 'gray';
            else if (lastName && csNames[lastName]) {
              const k = csNames[lastName].kind;
              st.space = k === 'cmyk' ? 'cmyk' : k === 'rgb' ? 'rgb' : k === 'gray' ? 'gray' : 'other';
            } else st.space = 'other';
            break;
          }
          case 'sc': case 'scn': {
            if (st.space === 'cmyk' && nums.length >= 4) {
              st.color = nums.slice(-4);
              record(st.color, inText, true);
            } else if (st.space === 'rgb' && nums.length >= 3) {
              rgbOps++;
              st.color = nums.slice(-3);
            } else if (st.space === 'other' && !lastName) {
              // unresolved colorspace: classify by operand count
              // (4 -> CMYK-like, 3 -> RGB-like; 1 could be a spot tint, skip)
              if (nums.length === 4) {
                st.color = nums.slice(-4);
                record(st.color, inText, true);
              } else if (nums.length === 3) {
                rgbOps++;
                st.color = nums.slice(-3);
                st.space = 'rgb';
              }
            }
            break;
          }
          case 'gs': st.gsActive = true; break;
          case 'w': {
            const v = nums[nums.length - 1];
            if (Number.isFinite(v)) st.lineWidth = v;
            break;
          }
          case 'S': case 's': {
            const eff = st.lineWidth * st.scale;
            if (eff > 0 && eff < 0.25) hairlineCount++;
            if (st.lineWidth > 0) minLW = minLW === null ? eff : Math.min(minLW, eff);
            break;
          }
          case 'BT': inText = true; break;
          case 'ET': inText = false; break;
          case 'Tj': case 'TJ': case "'": case '"': {
            if (st.space === 'cmyk' && st.color.length === 4) record(st.color, true, true);
            break;
          }
          case 'f': case 'F': case 'B': case 'b': {
            const isWhite =
              (st.space === 'cmyk' && st.color.length === 4 && st.color.every((v) => v <= 0.001)) ||
              (st.space === 'rgb' && st.color.length === 3 && st.color.every((v) => v >= 0.999)) ||
              (st.space === 'gray' && st.color[0] >= 0.999);
            if (isWhite && st.gsActive && docHasOverprint) whiteFillWithGs++;
            break;
          }
          default: break;
        }
        nums.length = 0;
        lastName = null;
      }
    } catch {
      // tolerate malformed streams — partial stats are still useful
    }
  }

  return {
    rgbOps,
    grayOps,
    cmykFills: [...cmykMap.values()],
    richBlackText: richText,
    overTacColors: [],
    whiteFillWithGs,
    minLineWidthPt: minLW,
    hairlineCount,
  };
}
