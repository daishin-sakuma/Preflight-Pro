import type { Metadata, Viewport } from 'next';
import { Figtree } from 'next/font/google';
import './globals.css';

const figtree = Figtree({
  subsets: ['latin'],
  display: 'swap',
  variable: '--font-figtree',
});

export const metadata: Metadata = {
  title: 'Preflight — print data check & proofing',
  description:
    'Preflight PDF / Illustrator / JPEG / PNG print data right in your browser. Checks RGB, total ink coverage, bleed, overprint, resolution and more, with a 3D preview.',
};

export const viewport: Viewport = {
  width: 'device-width',
  initialScale: 1,
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" className={figtree.variable} suppressHydrationWarning>
      <body>
        {/* apply the stored theme before first paint (no flash of wrong theme) */}
        <script
          dangerouslySetInnerHTML={{
            __html:
              "try{if(localStorage.getItem('preflight-pro:theme')==='light')document.documentElement.dataset.theme='light';}catch(e){}",
          }}
        />
        {children}
      </body>
    </html>
  );
}
