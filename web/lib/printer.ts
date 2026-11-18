export const VENDOR_ID = 0x0619;
export const PRODUCT_ID = 0x0123;
const INTERFACE = 0;

type Log = (message: string) => void;

export async function connectPrinter(log: Log): Promise<USBDevice> {
  if (!navigator.usb) throw new Error('WebUSB対応のChrome / Edgeで開いてください。');
  const known = await navigator.usb.getDevices();
  const matches = known.filter(d => d.vendorId === VENDOR_ID && d.productId === PRODUCT_ID);
  // 保存済みの許可や管理ポリシーがあれば、機器選択画面なしでヘッドレス接続できる。
  const device = matches.length === 1 ? matches[0] : await navigator.usb.requestDevice({
    filters: [{ vendorId: VENDOR_ID, productId: PRODUCT_ID }],
  });
  try {
    await device.open();
    if (device.configuration?.configurationValue !== 1) await device.selectConfiguration(1);
    await device.claimInterface(INTERFACE);
    const iface = device.configuration!.interfaces.find(i => i.interfaceNumber === INTERFACE);
    if (!iface?.alternate.endpoints.some(e => e.direction === 'out' && e.endpointNumber === 1 && e.type === 'bulk')) {
      throw new Error('Bulk OUT endpoint 1が見つかりません。');
    }
    log(`Connected: ${device.productName} (0619:0123), interface 0`);
    return device;
  } catch (error) {
    if (device.opened) await device.close().catch(() => {});
    throw error;
  }
}

export async function readStatus(device: USBDevice, log: Log): Promise<number | null> {
  const result = await device.controlTransferIn({
    requestType: 'class', recipient: 'interface', request: 1, value: 0, index: INTERFACE,
  }, 1);
  if (result.status === 'stall') {
    log('GET_PORT_STATUS: stall (取得非対応)');
    return null;
  }
  if (result.status !== 'ok' || result.data?.byteLength !== 1) throw new Error('USB status response invalid');
  const status = result.data.getUint8(0);
  log(`GET_PORT_STATUS: 0x${status.toString(16).padStart(2, '0')}`);
  return status;
}

export async function sendBytes(device: USBDevice, payload: Uint8Array<ArrayBuffer>, ignorePaper: boolean, log: Log) {
  if (!payload.length) throw new Error('印刷データが空です。');
  const status = await readStatus(device, log);
  if (status !== null) {
    if (!(status & 0x08)) throw new Error('プリンターがエラーを報告しています。送信を停止しました。');
    if ((status & 0x20) && !ignorePaper) throw new Error('紙ステータス0x20が立っています。用紙確認後にチェックを入れてください。');
  }
  let accepted = 0;
  for (let offset = 0; offset < payload.length; offset += 4096) {
    const chunk = payload.subarray(offset, offset + 4096);
    const result = await device.transferOut(1, chunk);
    if (result.status !== 'ok' || result.bytesWritten !== chunk.length) {
      throw new Error(`USB transfer incomplete: ${accepted} bytes accepted before this chunk, ${result.bytesWritten}/${chunk.length} in chunk. 紙を確認してから再実行してください。`);
    }
    accepted += result.bytesWritten;
    log(`USB accepted ${accepted}/${payload.length} bytes`);
  }
  return accepted;
}

export async function closePrinter(device: USBDevice) {
  if (!device.opened) return;
  try {
    if (device.configuration?.interfaces.some(i => i.interfaceNumber === INTERFACE && i.claimed)) {
      await device.releaseInterface(INTERFACE);
    }
  } finally {
    await device.close();
  }
}
