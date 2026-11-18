import { useEffect, useRef, useState, type RefObject } from 'react';
import { rasterizeLabel, type LabelDraft, type RasterLabel } from './label';

type PreviewResult = { draft: LabelDraft; raster: RasterLabel | null; error: string; durationMs: number };

export function useRasterPreview(node: RefObject<HTMLDivElement | null>, draft: LabelDraft) {
  const [result, setResult] = useState<PreviewResult | null>(null);
  const processing = useRef<Promise<void> | null>(null);

  useEffect(() => {
    let active = true;
    const controller = new AbortController();
    const timer = setTimeout(async () => {
      // 途中の編集を積み上げず、実行中の画像化が終わってから最新の内容だけを処理する。
      await processing.current;
      if (!active || !node.current) return;
      const element = node.current;
      processing.current = (async () => {
        const started = performance.now();
        try {
          const raster = await rasterizeLabel(element, draft, controller.signal);
          if (active) setResult({ draft, raster, error: '', durationMs: performance.now() - started });
        } catch (cause) {
          if (active) setResult({ draft, raster: null, error: cause instanceof Error ? cause.message : String(cause), durationMs: 0 });
        }
      })();
    }, 180);
    return () => { active = false; clearTimeout(timer); controller.abort(); };
  }, [node, draft]);

  // 編集と同じ描画で旧画像を無効にし、古い内容の保存・印刷を防ぐ。
  const current = result?.draft === draft;
  return {
    raster: current ? result.raster : null,
    previousRaster: result?.raster ?? null,
    error: current ? result.error : '',
    pending: !current,
    durationMs: current ? result.durationMs : null,
  };
}
