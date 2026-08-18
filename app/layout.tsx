import type { Metadata, Viewport } from 'next';
import './globals.css';

export const metadata: Metadata = {
  title: 'Preflight Pro — 入稿データチェック・校正ツール',
  description:
    'PDF / Illustrator / JPEG / PNG の印刷入稿データをブラウザ内でプリフライトチェック。RGB検出・総インキ量・塗り足し・オーバープリント・解像度などを解析し、3Dプレビューで確認できます。',
};

export const viewport: Viewport = {
  width: 'device-width',
  initialScale: 1,
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="ja" suppressHydrationWarning>
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
