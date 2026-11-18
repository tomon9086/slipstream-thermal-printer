import type { ReactNode } from 'react';
import './style.css';

export const metadata = { title: 'RP-E11 WebUSB Test' };

export default function Layout({ children }: { children: ReactNode }) {
  return <html lang="ja"><body>{children}</body></html>;
}
