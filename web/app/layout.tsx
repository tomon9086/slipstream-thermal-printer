import type { Metadata } from 'next';
import '@fontsource-variable/noto-sans-jp';
import './globals.css';

export const metadata: Metadata = {
  title: 'RP-E11 WebUSB Test',
  description: 'RP-E11へブラウザから直接印刷するための検証アプリ',
};

export default function RootLayout({ children }: LayoutProps<'/'>) {
  return <html lang="ja"><body>{children}</body></html>;
}
