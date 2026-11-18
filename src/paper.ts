// レイアウトのプリセット。本体のメモリースイッチ設定とは別で、検証済みの58mmレイアウトを維持する。
export function paperLayout(paperWidth = 58) {
  switch (paperWidth) {
    case 58: return { dots: 360, cpl: 30 };
    case 80: return { dots: 576, cpl: 48 };
    default: throw new Error('paper-width must be 58 or 80 (mm)');
  }
}
