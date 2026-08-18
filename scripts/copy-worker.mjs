// Copies the pdf.js worker into /public so it can be served statically.
// Runs on postinstall (locally and on Vercel).
import { copyFileSync, mkdirSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const src = join(root, 'node_modules/pdfjs-dist/build/pdf.worker.min.mjs');
const dstDir = join(root, 'public');
const dst = join(dstDir, 'pdf.worker.min.mjs');

if (existsSync(src)) {
  mkdirSync(dstDir, { recursive: true });
  copyFileSync(src, dst);
  console.log('copied pdf.worker.min.mjs -> public/');
} else {
  console.warn('pdfjs-dist worker not found (install not finished?)');
}
