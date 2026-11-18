import { useEffect, useRef, type CSSProperties } from 'react';
import { loadBitmapFont, paintBitmapText } from '@/lib/bitmap-font';

export function BitmapText({ text, part, scale, lineHeight, style }: {
  text: string; part: string; scale: number; lineHeight: number; style: CSSProperties;
}) {
  const canvas = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    let active = true;
    const node = canvas.current!;
    void loadBitmapFont().then(font => {
      if (!active) return;
      paintBitmapText(node, font, text, scale, lineHeight);
      node.dataset.bitmapState = 'ready';
    }).catch(cause => {
      if (!active) return;
      node.dataset.bitmapError = cause instanceof Error ? cause.message : String(cause);
      node.dataset.bitmapState = 'error';
    });
    return () => { active = false; };
  }, [text, scale, lineHeight]);
  return <canvas ref={canvas} width={1} height={16} data-label-part={part} data-bitmap-state="loading"
    role="img" aria-label={`${part}：${text}`} style={{ ...style, display: 'block', imageRendering: 'pixelated' }}>{text}</canvas>;
}
