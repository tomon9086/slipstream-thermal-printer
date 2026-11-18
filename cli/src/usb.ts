// USB transport for the observed RP-E11. Never detach a driver or retry a send.
export type UsbError = Error & { code?: string; errno?: number };
export interface PrinterOutEndpoint {
  direction: 'out';
  timeout: number;
  transfer(data: Buffer, callback: (error?: Error | null, actual?: number) => void): unknown;
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

export async function sendToPrinter(payload: Buffer | null, {
  statusOnly = false,
  ignorePaperStatus = false,
  findDevice,
  log = console.log,
}: SendOptions = {}): Promise<void> {
  if (!statusOnly && (!Buffer.isBuffer(payload) || payload.length === 0)) {
    throw new Error('Print payload must be a non-empty Buffer');
  }
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
          // GET_PORT_STATUS may be unsupported. Only a stalled request is optional.
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
      if (statusOnly) return;
      if (!(status[0] & 0x08)) throw new Error('Printer reports an error; no print sent');
      if ((status[0] & 0x20) && !ignorePaperStatus) {
        throw new Error('USB paper-status bit 0x20 is set; no print sent. This does not '
          + 'confirm paper empty on this model. Check paper, then use --ignore-paper-status');
      }
    }
    if (!payload) throw new Error('No print payload');
    const endpoint = iface.endpoint(0x01);
    if (!isOutEndpoint(endpoint)) throw new Error('Bulk OUT 0x01 missing');
    endpoint.timeout = 15000;
    // Bound transfers below the observed 16KiB receive buffer. No retries, including
    // after a short transfer: some bytes may already have printed.
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
    log(`USB accepted ${accepted}/${payload.length} bytes`);
    log('Print data sent; check the physical receipt.');
  } catch (error) {
    failure = error;
    if (error instanceof Error && (('code' in error && error.code === 'LIBUSB_ERROR_ACCESS')
      || ('errno' in error && error.errno === -3))) {
      throw new Error('USB access denied; use a udev rule or sudo node ...', { cause: error });
    }
    throw error;
  } finally {
    // Always close even if release fails, retaining the original transfer failure.
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
