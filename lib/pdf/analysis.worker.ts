// Web Worker entry: byte-level PDF scanning + content-stream interpretation +
// the upload pre-check. These are regex/string-heavy passes that can take
// seconds on large files, so they run off the main thread to keep the UI
// responsive (see lib/analysisWorker.ts for the calling wrapper).

import { rawScanPdf } from './rawScan.ts';
import { interpretContent } from './contentInterp.ts';
import { precheckFile } from '../estimateSize.ts';

self.addEventListener('message', (e: MessageEvent) => {
  const { id, type, buf, bleedMm } = (e.data ?? {}) as {
    id: number; type: 'scan' | 'precheck'; buf: ArrayBuffer; bleedMm?: number;
  };
  const reply = (msg: unknown) => (self as unknown as { postMessage(m: unknown): void }).postMessage(msg);
  try {
    const bytes = new Uint8Array(buf);
    if (type === 'precheck') {
      reply({ id, ok: true, result: precheckFile(bytes, bleedMm) });
      return;
    }
    const raw = rawScanPdf(bytes);
    const content = interpretContent(
      raw.contentStreams, raw.scan.overprintTrue, raw.csNames, raw.fontNames, raw.gsNames,
    );
    reply({
      id, ok: true,
      result: {
        scan: raw.scan,
        boxes: raw.boxes,
        aiArtboard: raw.aiArtboard,
        gradientCmyk: raw.gradientCmyk,
        content,
      },
    });
  } catch (err) {
    reply({ id, ok: false, error: String(err) });
  }
});
