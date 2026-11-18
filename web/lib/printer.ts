export const VENDOR_ID = 0x0619;
export const PRODUCT_ID = 0x0123;
const INTERFACE = 0;

type Log = (message: string) => void;

const pendingCleanup = new Set<PrinterSession>();
const recoveryMessage = '紙の出力を確認してから再接続してください。接続できない場合はUSBを抜き差しするか、ページを再読み込みしてください。';

function within<T>(operation: Promise<T>, timeoutMs: number, onTimeout: () => Error): Promise<T> {
  let timer: ReturnType<typeof setTimeout>;
  return Promise.race([operation, new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => reject(onTimeout()), timeoutMs);
  })]).finally(() => clearTimeout(timer));
}

export class PrinterSession {
  private retired = false;
  private cleanup?: Promise<void>;

  constructor(readonly device: USBDevice) {}

  async execute<T>(label: string, action: () => Promise<T>, timeoutMs = 15_000): Promise<T> {
    if (this.retired) throw new Error(`このUSB接続は使用できません。${recoveryMessage}`);
    const operation = action();
    return within(operation, timeoutMs, () => {
      this.retire(operation);
      return new Error(`${label}がタイムアウトしました。自動再送は行いません。${recoveryMessage}`);
    });
  }

  private retire(operation: Promise<unknown>) {
    this.retired = true;
    pendingCleanup.add(this);
    // タイムアウトはUSB処理自体を中断できないため、閉じる処理も開始して応答を待つ。
    // 遅れてopenが完了した場合も閉じる。後処理の完了までは新しい接続を開始しない。
    const closing = this.device.close();
    this.cleanup = Promise.allSettled([operation, closing]).then(async () => {
      if (this.device.opened) await this.device.close();
    }).finally(() => pendingCleanup.delete(this));
    void this.cleanup.catch(() => {});
  }

  async close() {
    if (!this.cleanup) {
      this.retired = true;
      pendingCleanup.add(this);
      // closeで占有中のインターフェースも解放する。無応答でも画面は下の期限で復帰させる。
      this.cleanup = (async () => {
        if (this.device.opened) await this.device.close();
      })().finally(() => pendingCleanup.delete(this));
    }
    await within(this.cleanup, 2_000, () => new Error(`USBの終了処理が応答待ちです。${recoveryMessage}`));
  }
}

export async function connectPrinter(log: Log): Promise<PrinterSession> {
  if (!navigator.usb) throw new Error('WebUSB対応のChrome / Edgeで開いてください。');
  if (pendingCleanup.size) throw new Error(`前のUSB接続が終了処理中です。${recoveryMessage}`);
  const known = await navigator.usb.getDevices();
  const matches = known.filter(d => d.vendorId === VENDOR_ID && d.productId === PRODUCT_ID);
  // 保存済みの許可や管理ポリシーがあれば、機器選択画面なしでヘッドレス接続できる。
  const device = matches.length === 1 ? matches[0] : await navigator.usb.requestDevice({
    filters: [{ vendorId: VENDOR_ID, productId: PRODUCT_ID }],
  });
  const session = new PrinterSession(device);
  try {
    await session.execute('USB接続', () => device.open());
    if (device.configuration?.configurationValue !== 1) {
      await session.execute('USB構成の選択', () => device.selectConfiguration(1));
    }
    await session.execute('USBインターフェースの占有', () => device.claimInterface(INTERFACE));
    const iface = device.configuration!.interfaces.find(i => i.interfaceNumber === INTERFACE);
    if (!iface?.alternate.endpoints.some(e => e.direction === 'out' && e.endpointNumber === 1 && e.type === 'bulk')) {
      throw new Error('Bulk OUT endpoint 1が見つかりません。');
    }
    log(`Connected: ${device.productName} (0619:0123), interface 0`);
    return session;
  } catch (error) {
    await session.close().catch(() => {});
    throw error;
  }
}

export async function readStatus(session: PrinterSession, log: Log): Promise<number | null> {
  const result = await session.execute('USBステータス取得', () => session.device.controlTransferIn({
    requestType: 'class', recipient: 'interface', request: 1, value: 0, index: INTERFACE,
  }, 1), 2_000);
  if (result.status === 'stall') {
    log('GET_PORT_STATUS: stall (取得非対応)');
    return null;
  }
  if (result.status !== 'ok' || result.data?.byteLength !== 1) throw new Error('USB status response invalid');
  const status = result.data.getUint8(0);
  log(`GET_PORT_STATUS: 0x${status.toString(16).padStart(2, '0')}`);
  return status;
}

export async function sendBytes(session: PrinterSession, payload: Uint8Array<ArrayBuffer>, ignorePaper: boolean, log: Log) {
  if (!payload.length) throw new Error('印刷データが空です。');
  const status = await readStatus(session, log);
  if (status !== null) {
    if (!(status & 0x08)) throw new Error('プリンターがエラーを報告しています。送信を停止しました。');
    if ((status & 0x20) && !ignorePaper) throw new Error('紙ステータス0x20が立っています。用紙確認後にチェックを入れてください。');
  }
  let accepted = 0;
  for (let offset = 0; offset < payload.length; offset += 4096) {
    const chunk = payload.subarray(offset, offset + 4096);
    const result = await session.execute('USB送信', () => session.device.transferOut(1, chunk));
    if (result.status !== 'ok' || result.bytesWritten !== chunk.length) {
      throw new Error(`USB transfer incomplete: ${accepted} bytes accepted before this chunk, ${result.bytesWritten}/${chunk.length} in chunk. 紙を確認してから再実行してください。`);
    }
    accepted += result.bytesWritten;
    log(`USB accepted ${accepted}/${payload.length} bytes`);
  }
  return accepted;
}

export async function closePrinter(session: PrinterSession) {
  await session.close();
}
