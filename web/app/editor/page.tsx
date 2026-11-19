'use client';

import Link from 'next/link';
import { useEffect, useRef, useState } from 'react';
import { AddressLabel } from '@/components/address-label';
import { initialLabel, labelSize, layoutErrors, type LabelDraft } from '@/lib/label';
import { useRasterPreview } from '@/lib/use-raster-preview';
import { closePrinter, connectPrinter, type PrinterSession } from '@/lib/printer';
import { DEFAULT_MARK_SEARCH_LIMIT, printOptionError, printRasterLabel, type PrintLabelOptions } from '@/lib/print-label';
import styles from './page.module.css';

const marginFields = [
  ['marginTopMm', '上'], ['marginBottomMm', '下'], ['marginLeftMm', '左'], ['marginRightMm', '右'],
] as const;

export default function EditorPage() {
  const [draft, setDraft] = useState<LabelDraft>(initialLabel);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [warnings, setWarnings] = useState<string[]>([]);
  const [connected, setConnected] = useState(false);
  const [marked, setMarked] = useState(false);
  const [cut, setCut] = useState(true);
  const [ignorePaper, setIgnorePaper] = useState(false);
  const [copies, setCopies] = useState(1);
  const [cutAdjust, setCutAdjust] = useState(-1.5);
  const [markSearchLimit, setMarkSearchLimit] = useState(DEFAULT_MARK_SEARCH_LIMIT);
  const [position, setPosition] = useState<'unknown' | 'after-cut'>('unknown');
  const [logs, setLogs] = useState<string[]>([]);
  const [zoom, setZoom] = useState(1);
  const label = useRef<HTMLDivElement>(null);
  const printer = useRef<PrinterSession | null>(null);
  const running = useRef(false);
  const preview = useRasterPreview(label, draft);
  const raster = preview.raster;
  const displayedRaster = warnings.length || preview.error ? null : raster ?? preview.previousRaster;
  const size = labelSize(draft);
  const options: PrintLabelOptions = { paperWidth: draft.paperWidth, marked, cut, ignorePaper, copies,
    cutAdjustMm: cutAdjust, position, markSearchLimit };
  const optionError = printOptionError(size.height, options);
  const log = (message: string) => setLogs(previous => [...previous.slice(-99), `${new Date().toLocaleTimeString('ja-JP')}  ${message}`]);

  useEffect(() => {
    let active = true;
    const update = () => { if (active && label.current) setWarnings(layoutErrors(label.current)); };
    const observer = new ResizeObserver(update);
    const mutations = new MutationObserver(update);
    if (label.current) {
      observer.observe(label.current);
      label.current.querySelectorAll('[data-label-part]').forEach(element => observer.observe(element));
      mutations.observe(label.current, { subtree: true, attributes: true, attributeFilter: ['data-bitmap-state', 'data-bitmap-error'] });
    }
    void document.fonts.ready.then(update);
    return () => { active = false; observer.disconnect(); mutations.disconnect(); };
  }, [draft]);

  useEffect(() => {
    const disconnect = (event: USBConnectionEvent) => {
      if (event.device !== printer.current?.device) return;
      printer.current = null; setConnected(false); setPosition('unknown'); setIgnorePaper(false);
      setNotice('USB接続が切れました。再接続後は用紙位置を確認してください。');
    };
    navigator.usb?.addEventListener('disconnect', disconnect);
    return () => {
      navigator.usb?.removeEventListener('disconnect', disconnect);
      if (printer.current) void closePrinter(printer.current).catch(() => {});
    };
  }, []);

  function edit<K extends keyof LabelDraft>(key: K, value: LabelDraft[K]) {
    setDraft(previous => ({ ...previous, [key]: value }));
    setNotice(''); setError('');
    if (key === 'paperWidth') setPosition('unknown');
  }

  async function run(action: () => Promise<void>, usb = false) {
    if (running.current) return;
    running.current = true; setBusy(true); setError(''); setNotice('');
    try { await action(); }
    catch (cause) {
      const message = cause instanceof Error ? cause.message : String(cause);
      setError(message); log(`エラー：${message}`);
      if (usb) {
        const session = printer.current;
        printer.current = null; setConnected(false); setPosition('unknown'); setIgnorePaper(false);
        if (session) await closePrinter(session).catch(() => {});
      }
    } finally { running.current = false; setBusy(false); }
  }

  function download() {
    if (!raster) return;
    const anchor = document.createElement('a');
    anchor.href = raster.dataUrl; anchor.download = `label-${raster.width}x${raster.height}.png`; anchor.click();
  }

  return <main className={styles.editor}>
    <header className={styles.header}>
      <Link href="/" className={styles.brand}><span className={styles.brandIcon}>S</span> SLIPSTREAM</Link>
      <Link href="/" className={styles.labLink}>USBテスト画面 ↗</Link>
    </header>
    <div className={styles.intro}>
      <div><p className={styles.eyebrow}>LABEL EDITOR</p><h1>宛名ラベルを編集</h1>
        <p>Reactでレイアウト。仕上がりを確認して、そのままプリント。</p></div>
      <span className={styles.localBadge}>● 文面・画像はブラウザ内で処理</span>
    </div>

    <div className={styles.workspace}>
      <aside className={styles.settings}>
        <fieldset disabled={busy} className={styles.fieldset}>
          <div className={styles.sectionTitle}><span>01</span><h2>ラベルの内容</h2></div>
          <label>郵便番号<input value={draft.postal} maxLength={24} onChange={event => edit('postal', event.target.value)} /></label>
          <label>住所<textarea rows={3} value={draft.address} maxLength={240} onChange={event => edit('address', event.target.value)} /></label>
          <label>氏名・宛名<input value={draft.recipient} maxLength={64} onChange={event => edit('recipient', event.target.value)} /></label>
          <label className={styles.toggle}><input type="checkbox" checked={draft.showQr} onChange={event => edit('showQr', event.target.checked)} />QRコードを表示</label>
          {draft.showQr && <label>QRの内容<input value={draft.qrValue} maxLength={160} onChange={event => edit('qrValue', event.target.value)} /></label>}
          <label className={styles.toggle}><input type="checkbox" checked={draft.showLogo} onChange={event => edit('showLogo', event.target.checked)} />SlipStreamロゴを表示</label>
          <div className={styles.divider} />
          <div className={styles.sectionTitle}><span>02</span><h2>用紙と文字</h2></div>
          <div className={styles.twoColumns}>
            <label>用紙幅<select value={draft.paperWidth} onChange={event => edit('paperWidth', Number(event.target.value) as 58 | 80)}>
              <option value={58}>58mmロール</option><option value={80}>80mmロール</option>
            </select></label>
            <label>印刷高さ<select value={draft.heightMm} onChange={event => edit('heightMm', Number(event.target.value))}>
              {[30, 34, 38, 40, 46, 60].map(height => <option key={height} value={height}>{height}mm</option>)}
            </select></label>
          </div>
          <fieldset className={styles.marginSettings}>
            <legend>画像内の余白</legend>
            <div className={styles.marginGrid}>
              {marginFields.map(([key, side]) => <label key={key}>{side}余白（mm）<input type="number" min={0} max={20} step={0.125}
                value={Number.isFinite(draft[key]) ? draft[key] : ''} onChange={event => edit(key, event.target.valueAsNumber)} /></label>)}
            </div>
          </fieldset>
          <p className={styles.hint}>画像内の余白です。0.125mm（1ドット）刻み。本体の印刷できない余白（58mmロールでは左右各約2mm）が別に付きます。</p>
          <label>文字の描き方<select value={draft.textRenderer} onChange={event => edit('textRenderer', event.target.value as LabelDraft['textRenderer'])}>
            <option value="outline">通常フォント（Noto Sans JP）</option><option value="bitmap">ドットフォント（Unifont JP）</option>
          </select></label>
          {draft.textRenderer === 'bitmap' ? <>
            <label>住所のドットサイズ<select value={draft.bitmapScale} onChange={event => edit('bitmapScale', Number(event.target.value) as LabelDraft['bitmapScale'])}>
              <option value={1}>16px（原寸）</option><option value={2}>32px（2倍）</option>
            </select></label>
            <label>氏名のドットサイズ<select value={draft.bitmapNameScale} onChange={event => edit('bitmapNameScale', Number(event.target.value) as LabelDraft['bitmapNameScale'])}>
              <option value={1}>16px（原寸）</option><option value={2}>32px（2倍）</option><option value={3}>48px（3倍）</option>
            </select></label>
            <p className={styles.hint}>16ドットの字形を整数倍で描きます。郵便番号は16px固定。太字・文字の白黒しきい値は適用しません。<a href="/fonts/README.txt" target="_blank" rel="noreferrer">フォント情報</a></p>
          </> : <>
          <label htmlFor="address-font-size">住所の文字サイズ <output>{draft.fontSize}px</output><input id="address-font-size" type="range" min={16} max={26} step={1} value={draft.fontSize} onChange={event => edit('fontSize', Number(event.target.value))} /></label>
          <label htmlFor="recipient-font-size">氏名の文字サイズ <output>{draft.nameSize}px</output><input id="recipient-font-size" type="range" min={20} max={40} step={1} value={draft.nameSize} onChange={event => edit('nameSize', Number(event.target.value))} /></label>
          <label className={styles.toggle}><input type="checkbox" checked={draft.bold} onChange={event => edit('bold', event.target.checked)} />文字を太くする</label>
          </>}
          <label htmlFor="raster-threshold">白黒のしきい値 <output>{draft.threshold}</output><input id="raster-threshold" type="range" min={64} max={220} value={draft.threshold} onChange={event => edit('threshold', Number(event.target.value))} /></label>
          <p className={styles.hint}>{draft.textRenderer === 'bitmap' ? 'しきい値はロゴなどの画像部分に適用します。' : '数値を上げると、薄い線も黒く印刷します。'}</p>
          <button type="button" className={styles.textButton} onClick={() => { setDraft({ ...initialLabel }); setPosition('unknown'); setNotice(''); setError(''); }}>見本の内容に戻す</button>
        </fieldset>
      </aside>

      <div className={styles.rightColumn}>
        <div className={styles.captureSource} aria-hidden="true" inert>
          <AddressLabel draft={draft} ref={label} />
        </div>
        <section className={styles.previewPanel} data-testid="raster-preview-panel"
          data-preview-state={warnings.length || preview.error ? 'error' : preview.pending ? 'pending' : 'ready'}
          data-raster-duration-ms={preview.durationMs}>
          <div className={styles.previewHeading}><div><span className={styles.dot} /> 印刷プレビュー</div>
            <label className={styles.zoom}>表示倍率<select aria-label="表示倍率" value={zoom} onChange={event => setZoom(Number(event.target.value))}>
              <option value={1}>100%</option><option value={1.5}>150%</option><option value={2}>200%</option>
            </select></label></div>
          <div className={styles.previewViewport}>
            <div className={styles.ruler}>{size.width / 8}mm / {size.width} dots</div>
            <div className={styles.paper} aria-busy={preview.pending} style={{ width: size.width * zoom, height: size.height * zoom }}>
              {displayedRaster && <>
                {/* 生成済みの白黒画像を表示し、編集中は前回画像を薄くして更新を待つ。 */}
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img src={displayedRaster.dataUrl} alt={preview.pending ? '更新前の印刷用画像' : '白黒の印刷用画像'}
                  width={displayedRaster.width} height={displayedRaster.height} data-testid="raster-preview"
                  style={{ display: 'block', width: displayedRaster.width * zoom, height: displayedRaster.height * zoom,
                    imageRendering: 'pixelated', opacity: preview.pending ? .35 : 1 }} />
              </>}
              {(preview.pending || !displayedRaster) && <div className={styles.previewPlaceholder}>
                {warnings.length || preview.error ? '入力内容を確認してください' : 'プレビューを更新中…'}
              </div>}
            </div>
            <p className={styles.dimension}>{size.width} × {size.height}px <span>·</span> {size.width / 8} × {draft.heightMm}mm <span>·</span> 203dpi</p>
          </div>
          <div className={styles.previewFooter}>
            <span role="status" aria-label="プレビューの状態">{warnings.length || preview.error ? 'プレビューを更新できません。' : preview.pending ? 'プレビューを更新中…' : '編集内容を自動更新 · 白黒2値'}</span>
            <br />印刷時は1ピクセル＝1ドット。表示倍率は画像サイズに影響しません。
          </div>
        </section>
        {warnings.length > 0 && <div role="alert" className={styles.warning}>{warnings.map(warning => <p key={warning}>{warning}</p>)}</div>}
        {preview.error && !warnings.length && <p role="alert" className={styles.warning}>{preview.error}</p>}

        <section className={styles.outputPanel}>
          <div className={styles.sectionTitle}><span>03</span><h2>画像を確認して印刷</h2></div>
          <div className={styles.exportRow}>
            <p>表示中の白黒画像を、そのまま保存・印刷します。</p>
            <div className={styles.buttonRow}><button className={styles.secondary} disabled={busy || !raster || warnings.length > 0} onClick={download}>PNGを保存 ↓</button></div>
          </div>
          {notice && <p role="status" aria-label="処理結果" className={styles.notice}>{notice}</p>}
          {error && <p role="alert" className={styles.warning}>{error}</p>}
          <div className={styles.divider} />
          <div className={styles.printerHeading}><h3>プリンター</h3><span className={connected ? styles.connected : styles.disconnected}>{connected ? '● 接続済み' : '○ 未接続'}</span></div>
          <div className={styles.buttonRow}>
            <button className={styles.secondary} disabled={busy || connected} onClick={() => run(async () => {
              printer.current = await connectPrinter(log); setConnected(true); setPosition('unknown'); setNotice('プリンターに接続しました。');
            }, true)}>USB接続</button>
            <button className={styles.textButton} disabled={busy || !connected} onClick={() => run(async () => {
              await closePrinter(printer.current!); printer.current = null; setConnected(false); setPosition('unknown'); setIgnorePaper(false);
            }, true)}>切断</button>
          </div>
          <fieldset disabled={busy} className={styles.fieldset}>
            <div className={styles.twoColumns}>
              <label>用紙の種類<select value={marked ? 'marked' : 'roll'} onChange={event => { setMarked(event.target.value === 'marked'); setPosition('unknown'); }}>
                <option value="roll">通常ロール</option><option value="marked">ブラックマーク付き（49mmピッチ）</option>
              </select></label>
              <label>枚数<select value={copies} onChange={event => setCopies(Number(event.target.value))}>
                {[1, 2, 3, 5, 10].map(number => <option key={number} value={number}>{number}枚</option>)}
              </select></label>
            </div>
            <label className={styles.toggle}><input type="checkbox" checked={cut} onChange={event => setCut(event.target.checked)} />1枚ごとにカットする</label>
            {marked && <>
              <p className={styles.hint}>{position === 'after-cut' ? '前回のカット位置から再開します。開始時の空送りはしません。' : '最初に黒帯へ位置を合わせます。白い部分からは最大9.25mm戻して探し、見つからなければ前へ送ります。未使用区画を送る場合があります。'}</p>
            </>}
            {!marked && <p className={styles.hint}>{position === 'after-cut'
              ? '前回のカット位置から9.25mm戻し、上余白を減らして再開します。'
              : '位置が不明な最初の1枚には、画像の上余白に加えて約12mmの余白が付きます。カット後の次の紙は9.25mm戻して余白を減らします。'}</p>}
            <button className={styles.textButton} type="button" onClick={() => { setPosition('unknown'); setNotice(marked ? '次回印刷時に頭出しします。' : '用紙位置を不明に戻しました。次回の最初の1枚は逆送りしません。'); }}>紙を交換・手動で動かした</button>
            <details className={styles.advanced}><summary>印刷の詳細設定</summary>
              {marked && <>
                <label>黒帯の探索上限（mm）<input type="number" min={1} step={1}
                  value={Number.isFinite(markSearchLimit) ? markSearchLimit : ''}
                  onChange={event => setMarkSearchLimit(event.target.valueAsNumber)} /></label>
                <p className={styles.hint}>1回の探索で送る最大距離です。用紙に合わせて1mm単位で指定します。見つからない場合はカットせず停止します。探索中は左端に細い印が付きます。</p>
                <label>カット位置の補正（mm）<input type="number" min={-5} max={5} step={0.125} value={cutAdjust}
                  onChange={event => { setCutAdjust(Number(event.target.value)); setPosition('unknown'); }} /></label>
              </>}
              <label className={styles.toggle}><input type="checkbox" checked={ignorePaper} onChange={event => setIgnorePaper(event.target.checked)} />紙を確認済み：この個体の状態ビット0x20を無視</label>
              <p className={styles.hint}>用紙交換・再接続後は頭出しします。画像・カットの完了応答まで確認し、失敗時は自動再送しません。</p>
            </details>
          </fieldset>
          {optionError && <p className={styles.warning}>{optionError}</p>}
          <button className={styles.printButton} disabled={busy || !connected || !raster || warnings.length > 0 || Boolean(optionError)} onClick={() => run(async () => {
            const session = printer.current;
            if (!session) throw new Error('プリンターに接続してください。');
            if (!raster) throw new Error('プレビューの更新を待ってください。');
            setPosition('unknown');
            const nextPosition = await printRasterLabel(session, raster, options, log);
            if (printer.current === session) setPosition(nextPosition);
            setNotice(`${copies}枚の印字${cut ? '・カット' : ''}の完了応答を確認しました。実紙をご確認ください。`);
          }, true)}>このラベルを{copies}枚印刷する →</button>
          <details className={styles.communication}><summary>通信ログ {logs.length > 0 && `(${logs.length})`}</summary><pre>{logs.join('\n') || '操作待ち'}</pre></details>
        </section>
      </div>
    </div>
    <footer className={styles.footer}>SLIPSTREAM <span>React → PNG → SII RP-E11</span></footer>
  </main>;
}
