// Off-main-thread PDF analysis. rawScanPdf + interpretContent decode every
// stream and regex-scan the whole corpus — seconds of blocking work on large
// files — so they run in a dedicated Worker and the UI (progress display,
// scrolling) stays responsive. Falls back to running synchronously in this
// thread when Workers are unavailable or the worker errors.

import type { ContentStats, PdfScan } from './types.ts';
import type { PrecheckInfo } from './estimateSize.ts';

export interface ScanBundle {
  scan: PdfScan;
  boxes: { media: number[][]; trim: number[][]; bleed: number[][]; crop: number[][]; art: number[][] };
  aiArtboard: { wMm: number; hMm: number } | null;
  gradientCmyk: { c: number; m: number; y: number; k: number }[];
  content: ContentStats;
}

let worker: Worker | null = null;
let workerBroken = false;
let reqId = 0;
const pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void }>();

function getWorker(): Worker | null {
  if (workerBroken || typeof Worker === 'undefined') return null;
  if (!worker) {
    try {
      worker = new Worker(new URL('./pdf/analysis.worker.ts', import.meta.url));
      worker.addEventListener('message', (e: MessageEvent) => {
        const { id, ok, result, error } = e.data ?? {};
        const p = pending.get(id);
        if (!p) return;
        pending.delete(id);
        if (ok) p.resolve(result);
        else p.reject(new Error(String(error)));
      });
      worker.addEventListener('error', () => {
        workerBroken = true;
        for (const p of pending.values()) p.reject(new Error('analysis worker failed'));
        pending.clear();
        worker?.terminate();
        worker = null;
      });
    } catch {
      workerBroken = true;
      worker = null;
    }
  }
  return worker;
}

function call<T>(type: 'scan' | 'precheck', bytes: Uint8Array, bleedMm?: number): Promise<T> | null {
  const w = getWorker();
  if (!w) return null;
  const id = ++reqId;
  const copy = bytes.slice(); // transfer a private copy; the caller keeps its view
  return new Promise<T>((resolve, reject) => {
    pending.set(id, { resolve: resolve as (v: unknown) => void, reject });
    w.postMessage({ id, type, buf: copy.buffer, bleedMm }, [copy.buffer]);
  });
}

export async function scanPdfOffThread(bytes: Uint8Array): Promise<ScanBundle> {
  const viaWorker = call<ScanBundle>('scan', bytes);
  if (viaWorker) {
    try { return await viaWorker; } catch { workerBroken = true; }
  }
  const { rawScanPdf } = await import('./pdf/rawScan.ts');
  const { interpretContent } = await import('./pdf/contentInterp.ts');
  const raw = rawScanPdf(bytes);
  return {
    scan: raw.scan,
    boxes: raw.boxes,
    aiArtboard: raw.aiArtboard,
    gradientCmyk: raw.gradientCmyk,
    content: interpretContent(raw.contentStreams, raw.scan.overprintTrue, raw.csNames, raw.fontNames, raw.gsNames),
  };
}

export async function precheckOffThread(bytes: Uint8Array, bleedMm: number): Promise<PrecheckInfo | null> {
  const viaWorker = call<PrecheckInfo | null>('precheck', bytes, bleedMm);
  if (viaWorker) {
    try { return await viaWorker; } catch { workerBroken = true; }
  }
  const { precheckFile } = await import('./estimateSize.ts');
  return precheckFile(bytes, bleedMm);
}
