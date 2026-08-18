import type { Metadata, Viewport } from 'next';
import { Figtree } from 'next/font/google';
import './globals.css';

const figtree = Figtree({
  subsets: ['latin'],
  display: 'swap',
  variable: '--font-figtree',
});

const APP_TITLE = 'Preflight — print data check & proofing';
const APP_DESC =
  'Preflight PDF / Illustrator / JPEG / PNG print data right in your browser. Checks RGB, total ink coverage, bleed, overprint, resolution and more, with a 3D preview.';

export const metadata: Metadata = {
  metadataBase: new URL('https://preflight-pro.vercel.app'),
  title: APP_TITLE,
  description: APP_DESC,
  icons: {
    icon: [
      { url: '/favicon.ico', sizes: 'any' },
      { url: '/favicon.svg', type: 'image/svg+xml' },
      { url: '/favicon-96x96.png', type: 'image/png', sizes: '96x96' },
    ],
    apple: [{ url: '/apple-touch-icon.png', sizes: '180x180', type: 'image/png' }],
  },
  appleWebApp: { capable: true, title: 'Preflight', statusBarStyle: 'default' },
  openGraph: {
    title: APP_TITLE,
    description: APP_DESC,
    type: 'website',
    siteName: 'Preflight',
  },
  twitter: {
    card: 'summary_large_image',
    title: APP_TITLE,
    description: APP_DESC,
  },
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
