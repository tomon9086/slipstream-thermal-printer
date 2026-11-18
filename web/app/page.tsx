'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { closePrinter, connectPrinter, readStatus, sendBytes } from '@/lib/printer';
import type { PrinterSession } from '@/lib/printer';

export default function Page() {
  const printer = useRef<PrinterSession | null>(null);
  const running = useRef(false);
  const [connected, setConnected] = useState(false);
  const [busy, setBusy] = useState(false);
  const [ignorePaper, setIgnorePaper] = useState(false);
  const [fixture, setFixture] = useState('japanese-qr');
  const [state, setState] = useState('idle');
  const [logs, setLogs] = useState<string[]>([]);
  const [errorMessage, setErrorMessage] = useState('');
  const log = useCallback((text: string) => {
    setLogs(old => [...old, `${new Date().toISOString()} ${text}`]);
  }, []);

  useEffect(() => {
    const disconnected = (event: USBConnectionEvent) => {
      if (event.device === printer.current?.device) {
        printer.current = null;
        setConnected(false);
        setState('disconnected');
        log('USB disconnected');
      }
    };
    navigator.usb?.addEventListener('disconnect', disconnected);
    return () => {
      navigator.usb?.removeEventListener('disconnect', disconnected);
      if (printer.current) void closePrinter(printer.current).catch(() => {});
    };
  }, [log]);

  async function run(action: () => Promise<void>) {
    if (running.current) return;
    running.current = true;
    setBusy(true);
    setErrorMessage('');
    try { await action(); }
    catch (error) {
      setState('error');
      const message = error instanceof Error ? error.message : String(error);
      setErrorMessage(message);
      log(`ERROR: ${message}`);
      const device = printer.current;
      printer.current = null;
      setConnected(false);
      setIgnorePaper(false);
      if (device) await closePrinter(device).catch(e => log(`Close: ${String(e)}`));
    } finally {
      running.current = false;
      setBusy(false);
    }
  }

  return <main>
    <p className="eyebrow">SLIPSTREAM / USB LAB</p>
    <h1>RP-E11 WebUSB Test</h1>
    <p>ブラウザからUSBへ直接送信します。接続するプリンターはSII 0619:0123です。</p>
    <section>
      <h2>1. 接続</h2>
      <div className="actions">
        <button disabled={busy || connected} onClick={() => run(async () => {
          printer.current = await connectPrinter(log);
          setConnected(true);
          setState('connected');
        })}>USB接続</button>
        <button disabled={busy || !connected} onClick={() => run(async () => {
          const value = await readStatus(printer.current!, log);
          if (value === null) throw new Error('ステータスを取得できませんでした。');
          setState('status-read');
        })}>ステータス取得</button>
        <button disabled={busy || !connected} onClick={() => run(async () => {
          await closePrinter(printer.current!);
          printer.current = null;
          setConnected(false);
          setState('disconnected');
          log('USB closed');
        })}>切断</button>
      </div>
    </section>
    <section>
      <h2>2. テスト印刷</h2>
      <label>印刷内容 <select value={fixture} disabled={busy} onChange={e => setFixture(e.target.value)}>
        <option value="japanese-qr">日本語・SII内蔵QR見本</option>
        <option value="demo">ロゴ・ReceiptLineデモ（58mm）</option>
      </select></label>
      <label className="check"><input type="checkbox" checked={ignorePaper} disabled={busy}
        onChange={e => setIgnorePaper(e.target.checked)} />用紙を確認済み：この個体の紙ステータス0x20を無視する</label>
      <p>実物の紙へ印刷し、最後にカットします。途中失敗時は自動再送しません。</p>
      <button disabled={busy || !connected} onClick={() => run(async () => {
        setState('printing');
        const response = await fetch(`/fixtures/${fixture}.bin`);
        if (!response.ok) throw new Error(`印刷データ取得失敗: ${response.status}`);
        const bytes = new Uint8Array(await response.arrayBuffer());
        const digest = await crypto.subtle.digest('SHA-256', bytes);
        const hash = Array.from(new Uint8Array(digest), n => n.toString(16).padStart(2, '0')).join('');
        log(`Payload: ${fixture}, ${bytes.length} bytes, SHA-256 ${hash}`);
        await sendBytes(printer.current!, bytes, ignorePaper, log);
        setState('sent');
        log('送信完了。紙の印字とQRの読み取りを確認してください。');
      })}>1回印刷する</button>
    </section>
    <section>
      <h2>通信ログ</h2>
      <p role="status" data-testid="state">{state}</p>
      {errorMessage && <p role="alert" data-testid="error">{errorMessage}</p>}
      <pre data-testid="log" aria-live="polite">{logs.join('\n') || '操作待ち'}</pre>
      <button onClick={() => {
        const url = URL.createObjectURL(new Blob([logs.join('\n')], { type: 'text/plain' }));
        const a = document.createElement('a'); a.href = url; a.download = 'rp-e11-webusb.log'; a.click();
        URL.revokeObjectURL(url);
      }}>ログを保存</button>
    </section>
  </main>;
}
