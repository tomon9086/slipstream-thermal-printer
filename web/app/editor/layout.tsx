import type { Metadata } from 'next';

export const metadata: Metadata = {
  // 印刷画像の白黒が拡張機能の配色変更に巻き込まれないよう、編集画面では変換を止める。
  other: { 'darkreader-lock': 'true' },
};

export default function EditorLayout({ children }: { children: React.ReactNode }) {
  return children;
}
