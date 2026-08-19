import type { MetadataRoute } from 'next';

export default function manifest(): MetadataRoute.Manifest {
  return {
    name: 'Preflight Pro — print data check & proofing',
    short_name: 'Preflight Pro',
    description:
      'Preflight Pro — check print data (PDF / Illustrator / JPEG / PNG) right in your browser.',
    start_url: '/',
    display: 'standalone',
    background_color: '#1e1e1f',
    theme_color: '#1e1e1f',
    icons: [
      { src: '/web-app-manifest-192x192.png', sizes: '192x192', type: 'image/png', purpose: 'maskable' },
      { src: '/web-app-manifest-512x512.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
    ],
  };
}
