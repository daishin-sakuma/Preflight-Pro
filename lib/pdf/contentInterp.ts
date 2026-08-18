// Minimal PDF content-stream interpreter.
// pdf.js normalizes all colors to RGB in its operator list, so raw CMYK values
// (needed for exact TAC / rich-black / registration checks) must be read from
// the content streams directly. Tracks graphics state (CTM, colors, text
// position, ExtGState, line width) and records LOCATIONS of problem drawing
// operations as markers for the 2D proof view.

import type { CmykUsage, ContentStats, Marker, MarkerKind } from '../types.ts';

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

type Mat = [number, number, number, number, number, number];
const IDENT: Mat = [1, 0, 0, 1, 0, 0];
const mul = (m: Mat, n: Mat): Mat => [
  m[0] * n[0] + m[1] * n[2],
  m[0] * n[1] + m[1] * n[3],
  m[2] * n[0] + m[3] * n[2],
  m[2] * n[1] + m[3] * n[3],
  m[4] * n[0] + m[5] * n[2] + n[4],
  m[4] * n[1] + m[5] * n[3] + n[5],
];
const apply = (m: Mat, x: number, y: number): [number, number] =>
  [m[0] * x + m[2] * y + m[4], m[1] * x + m[3] * y + m[5]];

interface BBox { x0: number; y0: number; x1: number; y1: number; n: number }
const newBox = (): BBox => ({ x0: Infinity, y0: Infinity, x1: -Infinity, y1: -Infinity, n: 0 });

interface GState {
  ctm: Mat;
  space: 'rgb' | 'cmyk' | 'gray' | 'other';
  color: number[];
  gsActive: boolean;
  overprintOn: boolean;   // resolved from gsNames when available
  lineWidth: number;
}

export type ContentStreamInput = string | { text: string; page: number };

const MAX_PER_KIND = 60;

export function interpretContent(
  streams: ContentStreamInput[],
  docHasOverprint: boolean,
  // colorspace resource name -> kind (resolved by rawScan; e.g. CS0 -> cmyk for
  // Illustrator's ICCBased CMYK). Without this, `/CS0 cs 0 0 0 0 scn` would be
  // unclassifiable and AI/InDesign colors would go undetected.
  csNames: Record<string, { kind: 'cmyk' | 'rgb' | 'gray' | 'sep' | 'other' }> = {},
  // font resource name -> embedded? (resolved by rawScan) for locating
  // text drawn with non-embedded fonts.
  fontNames: Record<string, { embedded: boolean; baseFont: string | null }> = {},
  // ExtGState resource name -> overprint flag (resolved by rawScan). When
  // available, overprint state is tracked precisely instead of heuristically.
  gsNames: Record<string, { overprint: boolean }> = {},
): ContentStats {
  const gsResolved = Object.keys(gsNames).length > 0;
  const cmykMap = new Map<string, CmykUsage>();
  const richText: CmykUsage[] = [];
  const markers: Marker[] = [];
  const markerCounts: Partial<Record<MarkerKind, number>> = {};
  const markerSeen = new Set<string>();
  let rgbOps = 0, grayOps = 0, whiteFillWithGs = 0, hairlineCount = 0;
  let minLW: number | null = null;

  const addMarker = (
    kind: MarkerKind, page: number, box: BBox | null,
    label?: string, point = false,
  ) => {
    if (!box || box.n === 0 || !Number.isFinite(box.x0)) return;
    if ((markerCounts[kind] ?? 0) >= MAX_PER_KIND) return;
    const w = Math.max(box.x1 - box.x0, 0.1);
    const h = Math.max(box.y1 - box.y0, 0.1);
    if (w > 20000 || h > 20000) return; // corrupt-coordinate guard
    const key = `${kind}:${page}:${Math.round(box.x0 / 4)}:${Math.round(box.y0 / 4)}:${Math.round(w / 4)}:${Math.round(h / 4)}`;
    if (markerSeen.has(key)) return;
    markerSeen.add(key);
    markerCounts[kind] = (markerCounts[kind] ?? 0) + 1;
    markers.push({ kind, page, rectPt: { x: box.x0, y: box.y0, w, h }, label, point });
  };

  const record = (vals: number[], inText: boolean, isFill: boolean, page: number) => {
    const [c, m, y, k] = vals;
    const key = vals.map((v) => Math.round(v * 100)).join(',') + (inText ? 'T' : '');
    const tac = (c + m + y + k) * 100;
    const prev = cmykMap.get(key);
    if (prev) return prev;
    const u: CmykUsage = { c, m, y, k, tac, inText, page, isFill };
    cmykMap.set(key, u);
    const heavy = vals.filter((v) => v >= 0.7).length;
    if (inText && heavy >= 3) richText.push(u);
    return u;
  };

  for (const input of streams) {
    const src = typeof input === 'string' ? input : input.text;
    const page = typeof input === 'string' ? 1 : Math.max(1, input.page);

    const st: GState = { ctm: IDENT, space: 'other', color: [], gsActive: false, overprintOn: false, lineWidth: 1 };
    const stack: GState[] = [];
    let inText = false;
    let tx = 0, ty = 0, fontSize = 12;
    let curFont: string | null = null;
    let path = newBox();
    const nums: number[] = [];
    let lastName: string | null = null;

    const addPathPoint = (x: number, y: number) => {
      const [px, py] = apply(st.ctm, x, y);
      if (px < path.x0) path.x0 = px;
      if (py < path.y0) path.y0 = py;
      if (px > path.x1) path.x1 = px;
      if (py > path.y1) path.y1 = py;
      path.n++;
    };

    const ctmScale = () =>
      (Math.hypot(st.ctm[0], st.ctm[1]) + Math.hypot(st.ctm[2], st.ctm[3])) / 2;

    const isWhite = () =>
      (st.space === 'cmyk' && st.color.length === 4 && st.color.every((v) => v <= 0.001)) ||
      (st.space === 'rgb' && st.color.length === 3 && st.color.every((v) => v >= 0.999)) ||
      (st.space === 'gray' && st.color[0] >= 0.999);

    const textBox = (): BBox => {
      const box = newBox();
      const [px, py] = apply(st.ctm, tx, ty);
      box.x0 = px; box.y0 = py;
      box.x1 = px + fontSize * 6; box.y1 = py + fontSize * 1.3;
      box.n = 2;
      return box;
    };

    // effective overprint: precise when gs dicts were resolved, else heuristic
    const overprintNow = () =>
      gsResolved ? st.overprintOn : (st.gsActive && docHasOverprint);

    const onPaint = (fills: boolean, strokes: boolean) => {
      if (fills) {
        if (st.space === 'rgb' && !isWhite()) addMarker('rgb', page, path, 'RGB');
        if (isWhite() && overprintNow()) {
          whiteFillWithGs++;
          addMarker('white-op', page, path, '白ノセ疑い');
        } else if (overprintNow()) {
          addMarker('overprint', page, path, 'ノセ設定');
        }
        if (st.space === 'cmyk' && st.color.length === 4) {
          // attach the first drawn location to this CMYK usage (for TAC markers)
          const key = st.color.map((v) => Math.round(v * 100)).join(',') + (inText ? 'T' : '');
          const u = cmykMap.get(key);
          if (u && !u.rectPt && path.n > 0 && Number.isFinite(path.x0)) {
            u.rectPt = {
              x: path.x0, y: path.y0,
              w: Math.max(path.x1 - path.x0, 0.1),
              h: Math.max(path.y1 - path.y0, 0.1),
            };
            u.page = page;
          }
        }
      }
      if (strokes) {
        if (st.space === 'rgb') addMarker('rgb', page, path, 'RGB');
        if (overprintNow() && !isWhite()) addMarker('overprint', page, path, 'ノセ設定');
        const eff = st.lineWidth * ctmScale();
        if (eff > 0 && eff < 0.25) {
          hairlineCount++;
          addMarker('hairline', page, path, `${eff.toFixed(2)}pt`);
        }
        if (st.lineWidth > 0) minLW = minLW === null ? eff : Math.min(minLW, eff);
      }
      path = newBox();
    };

    try {
      for (const tok of tokenize(src)) {
        if (tok.t === 'num') { nums.push(tok.v); if (nums.length > 8) nums.shift(); continue; }
        if (tok.t === 'name') { lastName = tok.v; continue; }
        if (tok.t === 'other') { continue; }
        const op = tok.v;
        switch (op) {
          case 'q': stack.push({ ...st, ctm: [...st.ctm] as Mat, color: [...st.color] }); break;
          case 'Q': { const p = stack.pop(); if (p) Object.assign(st, p); break; }
          case 'cm': {
            if (nums.length >= 6) st.ctm = mul(nums.slice(-6) as Mat, st.ctm);
            break;
          }
          // ---- path construction ----
          case 'm': case 'l': {
            if (nums.length >= 2) addPathPoint(nums[nums.length - 2], nums[nums.length - 1]);
            break;
          }
          case 'c': {
            if (nums.length >= 6) {
              const a = nums.slice(-6);
              addPathPoint(a[0], a[1]); addPathPoint(a[2], a[3]); addPathPoint(a[4], a[5]);
            }
            break;
          }
          case 'v': case 'y': {
            if (nums.length >= 4) {
              const a = nums.slice(-4);
              addPathPoint(a[0], a[1]); addPathPoint(a[2], a[3]);
            }
            break;
          }
          case 're': {
            if (nums.length >= 4) {
              const [x, y, w, h] = nums.slice(-4);
              addPathPoint(x, y); addPathPoint(x + w, y);
              addPathPoint(x, y + h); addPathPoint(x + w, y + h);
            }
            break;
          }
          case 'n': path = newBox(); break;
          // ---- painting ----
          case 'f': case 'F': case 'f*': onPaint(true, false); break;
          case 'B': case 'B*': case 'b': case 'b*': onPaint(true, true); break;
          case 'S': case 's': onPaint(false, true); break;
          // ---- color ----
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
            if (st.color.length === 4) record(st.color, inText && op === 'k', op === 'k', page);
            break;
          }
          case 'cs': case 'CS': {
            if (lastName === 'DeviceCMYK') st.space = 'cmyk';
            else if (lastName === 'DeviceRGB') st.space = 'rgb';
            else if (lastName === 'DeviceGray') st.space = 'gray';
            else if (lastName && csNames[lastName]) {
              const kk = csNames[lastName].kind;
              st.space = kk === 'cmyk' ? 'cmyk' : kk === 'rgb' ? 'rgb' : kk === 'gray' ? 'gray' : 'other';
            } else st.space = 'other';
            break;
          }
          case 'sc': case 'scn': {
            if (st.space === 'cmyk' && nums.length >= 4) {
              st.color = nums.slice(-4);
              record(st.color, inText, true, page);
            } else if (st.space === 'rgb' && nums.length >= 3) {
              rgbOps++;
              st.color = nums.slice(-3);
            } else if (st.space === 'other' && !lastName) {
              // unresolved colorspace: classify by operand count
              if (nums.length === 4) {
                st.color = nums.slice(-4);
                st.space = 'cmyk';
                record(st.color, inText, true, page);
              } else if (nums.length === 3) {
                rgbOps++;
                st.color = nums.slice(-3);
                st.space = 'rgb';
              }
            }
            break;
          }
          case 'gs': {
            st.gsActive = true;
            if (lastName && gsNames[lastName] !== undefined) {
              st.overprintOn = gsNames[lastName].overprint;
            }
            break;
          }
          case 'w': {
            const v = nums[nums.length - 1];
            if (Number.isFinite(v)) st.lineWidth = v;
            break;
          }
          // ---- text ----
          case 'BT': inText = true; tx = 0; ty = 0; break;
          case 'ET': inText = false; break;
          case 'Tf': {
            if (lastName) curFont = lastName;
            const v = nums[nums.length - 1];
            if (Number.isFinite(v) && v > 0) fontSize = v;
            break;
          }
          case 'Tm': {
            if (nums.length >= 6) { tx = nums[nums.length - 2]; ty = nums[nums.length - 1]; }
            break;
          }
          case 'Td': case 'TD': {
            if (nums.length >= 2) { tx += nums[nums.length - 2]; ty += nums[nums.length - 1]; }
            break;
          }
          case 'Tj': case 'TJ': case "'": case '"': {
            if (st.space === 'cmyk' && st.color.length === 4) {
              record(st.color, true, true, page);
              const heavy = st.color.filter((v) => v >= 0.7).length;
              if (heavy >= 3) addMarker('rich-black', page, textBox(), '4C文字', true);
            }
            if (st.space === 'rgb') addMarker('rgb', page, textBox(), 'RGB文字', true);
            if (curFont && fontNames[curFont] && !fontNames[curFont].embedded) {
              addMarker('font', page, textBox(),
                fontNames[curFont].baseFont ?? '未埋め込み', true);
            }
            if (overprintNow() && !isWhite()) {
              addMarker('overprint', page, textBox(), 'ノセ設定 (文字)', true);
            } else if (overprintNow() && isWhite()) {
              whiteFillWithGs++;
              addMarker('white-op', page, textBox(), '白ノセ疑い (文字)', true);
            }
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
    markers,
  };
}
