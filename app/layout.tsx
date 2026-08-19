import type { Metadata, Viewport } from 'next';
import { Figtree } from 'next/font/google';
import './globals.css';

const figtree = Figtree({
  subsets: ['latin'],
  display: 'swap',
  variable: '--font-figtree',
});

const SITE_URL = 'https://preflight-pro.vercel.app';
const APP_TITLE = 'Preflight Pro — print data check & proofing';
// Meta description: kept concise (~150 chars) so it isn't truncated in search results.
const APP_DESC =
  'Free browser-based print preflight: check PDF, AI, JPEG & PNG for RGB/CMYK, ink coverage, bleed, overprint, fonts and DPI — with a 3D preview.';
// Longer copy used only for structured data (no length limit there).
const LONG_DESC =
  'Preflight Pro is a free, browser-based tool to check print data before submission. It checks PDF, Illustrator (.ai), JPEG and PNG for RGB vs CMYK, total ink coverage (TAC), bleed and trim, overprint, embedded fonts and effective resolution, with a 3D paper preview and a 2D proof. All analysis runs locally in your browser — files are never uploaded.';

export const metadata: Metadata = {
  metadataBase: new URL(SITE_URL),
  title: {
    default: APP_TITLE,
    template: '%s · Preflight Pro',
  },
  description: APP_DESC,
  applicationName: 'Preflight Pro',
  authors: [{ name: 'Daishin Sakuma' }],
  creator: 'Daishin Sakuma',
  publisher: 'Preflight Pro',
  category: 'Design tools',
  keywords: [
    'preflight', 'print preflight', 'prepress', 'print data check', 'proofing',
    'PDF preflight', 'Illustrator ai check', 'CMYK check', 'RGB to CMYK',
    'total ink coverage', 'TAC', 'ink limit', 'bleed', 'trim', 'overprint',
    'font embedding', 'image resolution', 'DPI check', '3D print preview',
    'browser preflight', 'client-side', '入稿データチェック', '印刷 プリフライト',
  ],
  alternates: { canonical: '/' },
  robots: {
    index: true,
    follow: true,
    googleBot: {
      index: true,
      follow: true,
      'max-image-preview': 'large',
      'max-snippet': -1,
      'max-video-preview': -1,
    },
  },
  verification: {
    google: 'pVRFM7bCfKvQV0zh60Ucitax5O17wD_4SALwzEsgjv4',
  },
  icons: {
    icon: [
      { url: '/favicon.ico', sizes: 'any' },
      { url: '/favicon.svg', type: 'image/svg+xml' },
      { url: '/favicon-96x96.png', type: 'image/png', sizes: '96x96' },
    ],
    apple: [{ url: '/apple-touch-icon.png', sizes: '180x180', type: 'image/png' }],
  },
  appleWebApp: { capable: true, title: 'Preflight Pro', statusBarStyle: 'default' },
  openGraph: {
    title: APP_TITLE,
    description: APP_DESC,
    url: '/',
    type: 'website',
    siteName: 'Preflight Pro',
    locale: 'en_US',
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
  const jsonLd = {
    '@context': 'https://schema.org',
    '@type': 'WebApplication',
    name: 'Preflight Pro',
    alternateName: APP_TITLE,
    url: SITE_URL,
    description: LONG_DESC,
    applicationCategory: 'DesignApplication',
    operatingSystem: 'Any (web browser)',
    browserRequirements: 'Requires JavaScript. Runs entirely client-side.',
    offers: { '@type': 'Offer', price: '0', priceCurrency: 'USD' },
    featureList: [
      'RGB vs CMYK color check',
      'Total ink coverage (TAC) / ink limit',
      'Bleed and trim size check',
      'Overprint and rich-black detection',
      'Embedded-font check',
      'Effective image resolution (DPI) check',
      '3D paper preview and 2D proof',
      'Client-side — files never leave the browser',
    ],
  };
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
        <script
          type="application/ld+json"
          dangerouslySetInnerHTML={{ __html: JSON.stringify(jsonLd) }}
        />
        {children}
      </body>
    </html>
  );
}
