// 実機確認したRP-E11用のUSB転送。ドライバーの切り離しや送信の再試行は行わない。
export type UsbError = Error & { code?: string; errno?: number };
export interface PrinterOutEndpoint {
  direction: 'out';
  timeout: number;
  transfer(data: Buffer, callback: (error?: Error | null, actual?: number) => void): unknown;
}
export interface PrinterInEndpoint {
  direction: 'in';
  timeout: number;
  transfer(length: number, callback: (error?: Error | null, data?: Buffer) => void): unknown;
}
export interface PrinterIO {
  write(payload: Buffer): Promise<void>;
  read(timeoutMs?: number): Promise<Buffer>;
}
export interface PrinterInterface {
  claim(): void;
  release(callback: (error?: Error) => void): void;
  endpoint(address: number): unknown;
}
export interface PrinterDevice {
  timeout: number;
  open(): void;
  close(): void;
  interface(index: number): PrinterInterface;
  controlTransfer(type: number, request: number, value: number, index: number,
    length: number, callback: (error?: UsbError, data?: unknown) => void): void;
}
export interface SendOptions {
  statusOnly?: boolean;
  ignorePaperStatus?: boolean;
  findDevice?: (vid: number, pid: number) => PrinterDevice | undefined;
  log?: (message: string) => void;
}

function isOutEndpoint(endpoint: unknown): endpoint is PrinterOutEndpoint {
  return typeof endpoint === 'object' && endpoint !== null
    && 'direction' in endpoint && endpoint.direction === 'out'
    && 'transfer' in endpoint && typeof endpoint.transfer === 'function';
}

export async function sendToPrinter(payload: Buffer | null, options: SendOptions = {}): Promise<void> {
  if (!options.statusOnly && (!Buffer.isBuffer(payload) || payload.length === 0)) {
    throw new Error('Print payload must be a non-empty Buffer');
  }
  await withPrinter(async io => {
    if (options.statusOnly) return;
    await io.write(payload!);
    (options.log ?? console.log)(`USB accepted ${payload!.length}/${payload!.length} bytes`);
    (options.log ?? console.log)('Print data sent; check the physical receipt.');
  }, options);
}

// 一連の要求と応答で、一度確保したインターフェースを開いたまま使う。
export async function withPrinter<T>(operation: (io: PrinterIO) => Promise<T>, {
  statusOnly = false,
  ignorePaperStatus = false,
  findDevice,
  log = console.log,
}: SendOptions = {}): Promise<T> {
  const find = findDevice ?? (await import('usb')).findByIds;
  const device: PrinterDevice | undefined = find(0x0619, 0x0123);
  if (!device) throw new Error('SII 0619:0123 not found; check power and USB connection');
  let opened = false;
  let claimed = false;
  let iface: PrinterInterface | undefined;
  let failure: unknown;
  try {
    device.open();
    opened = true;
    device.timeout = 2000;
    iface = device.interface(0);
    iface.claim();
    claimed = true;
    log('Connected to SII 0619:0123, interface 0');
    const status = await new Promise<unknown>((resolve, reject) => {
      device.controlTransfer(0xa1, 1, 0, 0, 1, (error, data) => {
        if (error) {
          // GET_PORT_STATUSは非対応の場合がある。STALLの場合だけ状態取得を省略できる。
          if (error.code === 'LIBUSB_ERROR_PIPE' || error.errno === -9) resolve(null);
          else reject(error);
        } else resolve(data);
      });
    });
    if (status === null) {
      log('USB printer status unavailable (request stalled)');
      if (statusOnly) throw new Error('Connected, but could not read USB printer status');
    } else {
      if (!Buffer.isBuffer(status) || status.length !== 1) {
        throw new Error('Unexpected USB status response length');
      }
      log(`USB printer status: 0x${status[0].toString(16).padStart(2, '0')}`);
      if (!statusOnly && !(status[0] & 0x08)) throw new Error('Printer reports an error; no print sent');
      if (!statusOnly && (status[0] & 0x20) && !ignorePaperStatus) {
        throw new Error('USB paper-status bit 0x20 is set; no print sent. This does not '
          + 'confirm paper empty on this model. Check paper, then use --ignore-paper-status');
      }
    }
    const claimedInterface = iface;
    const io: PrinterIO = {
      async write(payload) {
        if (!Buffer.isBuffer(payload) || payload.length === 0) throw new Error('Empty USB write');
        const endpoint = claimedInterface.endpoint(0x01);
        if (!isOutEndpoint(endpoint)) throw new Error('Bulk OUT 0x01 missing');
        endpoint.timeout = 15000;
        // 実機の16KiB受信バッファより小さく分割して転送する。一部が印字済みの可能性があるため、
        // 部分転送の場合も再試行しない。
        let accepted = 0;
        for (let offset = 0; offset < payload.length; offset += 4096) {
          const chunk = payload.subarray(offset, offset + 4096);
          await new Promise<void>((resolve, reject) => {
            endpoint.transfer(chunk, (error, actual) => {
              if (error || actual !== chunk.length) {
                reject(new Error(`USB transfer incomplete (${accepted} bytes previously accepted, `
                  + `${actual ?? 'unknown'}/${chunk.length} in this chunk). Inspect receipt before retrying`,
                error ? { cause: error } : undefined));
              } else {
                accepted += actual;
                resolve();
              }
            });
          });
        }
      },
      async read(timeoutMs = 2000) {
        const candidate = claimedInterface.endpoint(0x82);
        if (typeof candidate !== 'object' || candidate === null || !('direction' in candidate)
          || candidate.direction !== 'in' || !('transfer' in candidate)
          || typeof candidate.transfer !== 'function') throw new Error('Bulk IN 0x82 missing');
        const endpoint = candidate as PrinterInEndpoint;
        let remaining = Math.max(1, Math.ceil(timeoutMs));
        const deadline = Date.now() + remaining;
        while (remaining > 0) {
          endpoint.timeout = remaining;
          const data = await new Promise<Buffer>((resolve, reject) => {
            // 最大パケット1個分を要求し、ちょうど64バイトの応答断片でも受信が完了するようにする。
            endpoint.transfer(64, (error, data) => {
              if (error) reject(error);
              else if (!Buffer.isBuffer(data)) reject(new Error('Invalid USB response'));
              else resolve(data);
            });
          });
          if (data.length) return data;
          // RP-E11はコマンドの処理中に長さゼロのパケットを送る。元の期限内で同じ応答の
          // 受信を続け、コマンドは再送しない。
          remaining = deadline - Date.now();
        }
        throw new Error('Timed out waiting for USB response data');
      },
    };
    return await operation(io);
  } catch (error) {
    failure = error;
    if (error instanceof Error && (('code' in error && error.code === 'LIBUSB_ERROR_ACCESS')
      || ('errno' in error && error.errno === -3))) {
      throw new Error('USB access denied; use a udev rule or sudo node ...', { cause: error });
    }
    throw error;
  } finally {
    // 解放に失敗しても必ず閉じ、元の転送エラーを保持する。
    let cleanupError: unknown;
    if (claimed && iface) {
      const claimedInterface = iface;
      try {
        await new Promise<void>((resolve, reject) => claimedInterface.release(error => error ? reject(error) : resolve()));
      } catch (error) { cleanupError = error; }
    }
    if (opened) {
      try { device.close(); } catch (error) { cleanupError ??= error; }
    }
    if (cleanupError && !failure) throw cleanupError;
  }
}
