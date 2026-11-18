import QRCode from 'qrcode';
import type { CSSProperties, Ref } from 'react';
import type { LabelDraft } from '@/lib/label';
import { labelContentBox, labelSize } from '@/lib/label';
import { BitmapText } from './bitmap-text';

function LabelText({ part, text, style }: { part: string; text: string; style: CSSProperties }) {
  return <span data-label-part={part} data-label-text style={style}>
    {/* CanvasにもDOMと同じ文字のベースラインを渡す。 */}
    <span data-text-baseline style={{ display: 'inline-block', width: 0, height: 0, verticalAlign: 'baseline' }} />{text}
  </span>;
}

function Qr({ value }: { value: string }) {
  const { modules } = QRCode.create(value || ' ', { errorCorrectionLevel: 'M' });
  const size = (modules.size + 8) * 3;
  let path = '';
  for (let y = 0; y < modules.size; y++) for (let x = 0; x < modules.size; x++) {
    if (modules.get(y, x)) path += `M${12 + x * 3} ${12 + y * 3}h3v3h-3z`;
  }
  return <svg data-label-part="QR" aria-label="QRコード" width={size} height={size}
    viewBox={`0 0 ${size} ${size}`} shapeRendering="crispEdges"
    style={{ position: 'absolute', top: 0, right: 0 }}>
    <rect width={size} height={size} fill="white" /><path d={path} fill="black" />
  </svg>;
}

export function AddressLabel({ draft, ref }: { draft: LabelDraft; ref?: Ref<HTMLDivElement> }) {
  const size = labelSize(draft);
  const { error, ...contentBox } = labelContentBox(draft);
  return <div ref={ref} data-testid="label-component" data-layout-error={error || undefined} aria-label="宛名の印刷プレビュー"
    style={{ ...size, position: 'relative', overflow: 'hidden', backgroundColor: '#fff', color: '#000',
      fontFamily: '"Noto Sans JP Variable", sans-serif',
      fontWeight: draft.bold ? 700 : 500, fontStyle: 'normal', letterSpacing: 0, textAlign: 'left' }}>
    <div data-label-content style={{ ...contentBox, position: 'absolute' }}>
    {draft.textRenderer === 'bitmap' ? <>
      <BitmapText key={`postal:${draft.postal}`} part="郵便番号" text={draft.postal} scale={1} lineHeight={16}
        style={{ position: 'absolute', left: 0, top: 16 }} />
      <BitmapText key={`address:${draft.address}:${draft.bitmapScale}`} part="住所" text={draft.address}
        scale={draft.bitmapScale} lineHeight={Math.round(16 * draft.bitmapScale * 1.8)}
        style={{ position: 'absolute', left: 0, top: 69 }} />
      <BitmapText key={`recipient:${draft.recipient}:${draft.bitmapNameScale}`} part="氏名" text={draft.recipient}
        scale={draft.bitmapNameScale} lineHeight={16 * draft.bitmapNameScale}
        style={{ position: 'absolute', left: 0, bottom: 38 }} />
    </> : <>
    <LabelText part="郵便番号" text={draft.postal} style={{ position: 'absolute', left: 0, top: 16, fontSize: 20, lineHeight: '28px', whiteSpace: 'pre' }} />
    <LabelText part="住所" text={draft.address} style={{ position: 'absolute', left: 0, top: 69,
      fontSize: draft.fontSize, lineHeight: '1.8', whiteSpace: 'pre', width: 'max-content' }} />
    <LabelText part="氏名" text={draft.recipient} style={{ position: 'absolute', left: 0, bottom: 38,
      fontSize: draft.nameSize, lineHeight: '36px', whiteSpace: 'pre', width: 'max-content' }} />
    </>}
    {draft.showQr && <Qr value={draft.qrValue} />}
    {/* ラスタライズ時に同じoriginのSVGを埋め込むため、画像の最適化は使用しない。 */}
    {/* eslint-disable-next-line @next/next/no-img-element */}
    {draft.showLogo && <img data-label-part="ロゴ" src="/label-logo.svg" alt="SlipStream"
      style={{ position: 'absolute', right: 0, bottom: 6, width: 120, height: 'auto', display: 'block' }} />}
    </div>
  </div>;
}
