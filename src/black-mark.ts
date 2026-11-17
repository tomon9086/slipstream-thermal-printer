import type { PrinterIO } from './usb.ts';

export interface MarkedJob { setup: Buffer; body: Buffer }
type Reply = { kind: 'hex'; data: Buffer } | { kind: 'status'; value: number }
  | { kind: 'execution'; value: number };

const ALIGN = Buffer.from([0x1d, 0x3c]);
const FORM_FEED = Buffer.from([0x1d, 0x0c]);
const CUT = Buffer.from([0x1d, 0x56, 1]);
const completion = (tag: number) => Buffer.from([0x12, 0x71, tag]);

export function markAlignmentBytes(offsetMm?: number): Buffer {
  if (offsetMm === undefined) return ALIGN;
  if (!Number.isFinite(offsetMm) || offsetMm < -9.25 || offsetMm > 31.875) {
    throw new Error('--mark-offset-mm must be between -9.25 and 31.875');
  }
  const dots = Math.round(Math.abs(offsetMm) * 8);
  // Pin the default 1/203-inch pitch: each unit resolves to one 0.125mm dot.
  // GS A must immediately follow GS <, before any completion/status requests.
  return Buffer.concat([Buffer.from([0x1d, 0x50, 0, 203]), ALIGN,
    Buffer.from([0x1d, 0x41, offsetMm < 0 ? 1 : 0, dots])]);
}

// SII technical reference 6-14: responses are a stream, not one USB packet each.
export class SiiReplyDecoder {
  private pending: Buffer = Buffer.alloc(0);

  push(chunk: Buffer): Reply[] {
    this.pending = Buffer.concat([this.pending, chunk]);
    if (this.pending.length > 4096) throw new Error('SII response frame is too large');
    const replies: Reply[] = [];
    while (this.pending.length) {
      const first = this.pending[0];
      if ([0x0e, 0x02, 0x0f].includes(first)) {
        const end = this.pending.indexOf(0, 1);
        if (end < 0) break;
        if (first === 0x0e) {
          const encoded = this.pending.subarray(1, end);
          if (encoded.length % 2) throw new Error('Malformed SII HEX response');
          const data = Buffer.alloc(encoded.length / 2);
          for (let i = 0; i < encoded.length; i += 2) {
            if ((encoded[i] & 0xf0) !== 0xe0 || (encoded[i + 1] & 0xf0) !== 0xf0) {
              throw new Error('Malformed SII HEX response');
            }
            data[i / 2] = (encoded[i] & 15) | ((encoded[i + 1] & 15) << 4);
          }
          replies.push({ kind: 'hex', data });
        }
        this.pending = this.pending.subarray(end + 1);
      } else if ((first & 0xf0) === 0xc0) {
        // Automatic status is an eight-byte record; do not mistake it for a reply.
        if (this.pending.length < 8) break;
        if (!this.pending.subarray(1, 8).every(byte => (byte & 0xf0) === 0xd0)) {
          throw new Error('Malformed SII automatic status response');
        }
        this.pending = this.pending.subarray(8);
      } else {
        if ((first & 0xf0) === 0xa0) replies.push({ kind: 'status', value: first & 15 });
        if ((first & 0xf0) === 0x80) replies.push({ kind: 'execution', value: first & 15 });
        // Ignore initialization, progress, and serial flow-control bytes.
        this.pending = this.pending.subarray(1);
      }
    }
    return replies;
  }
}

class SiiClient {
  private decoder = new SiiReplyDecoder();
  private replies: Reply[] = [];
  private tag = 0;
  private io: PrinterIO;
  private timeoutMs: number;

  constructor(io: PrinterIO, timeoutMs = 5000) {
    this.io = io;
    this.timeoutMs = timeoutMs;
  }

  private async wait<K extends Reply['kind']>(kind: K, tag?: number): Promise<Extract<Reply, { kind: K }>> {
    const deadline = Date.now() + this.timeoutMs;
    while (Date.now() < deadline) {
      const index = this.replies.findIndex(reply => reply.kind === kind
        && (tag === undefined || ('value' in reply && reply.value === tag)));
      if (index >= 0) return this.replies.splice(0, index + 1).at(-1) as Extract<Reply, { kind: K }>;
      this.replies = [];
      try {
        this.replies.push(...this.decoder.push(await this.io.read(deadline - Date.now())));
      } catch (cause) {
        throw new Error(`SII ${kind} response failed; inspect printer before retrying`, { cause });
      }
    }
    throw new Error(`Timed out waiting for SII ${kind} response; no automatic retry`);
  }

  async synchronize() {
    // A fence after older queued commands drains their replies, including ReceiptLine's 0x80.
    await this.io.write(completion(15));
    await this.wait('execution', 15);
  }
  async settings(): Promise<Buffer> {
    await this.io.write(Buffer.from([0x12, 0x6c, 0]));
    const { data } = await this.wait('hex');
    if (data.length !== 40) throw new Error('Expected 40 SII memory-switch bytes');
    return data;
  }
  async status(number: number): Promise<number> {
    await this.io.write(Buffer.from([0x1d, 0x72, number]));
    return (await this.wait('status')).value;
  }
  async execute(data: Buffer) {
    this.tag = this.tag % 14 + 1;
    await this.io.write(Buffer.concat([data, completion(this.tag)]));
    await this.wait('execution', this.tag);
  }
  async assertReady() {
    const hardware = await this.status(0);
    const paper = await this.status(1);
    if (paper & 4) throw new Error('Black mark detection failed (mark-search paper jam); no retry');
    if ((hardware & 13) || paper) {
      throw new Error(`Printer error: hardware=0x${hardware.toString(16)}, paper=0x${paper.toString(16)}`);
    }
  }
}

export async function inspectBlackMark(io: PrinterIO) {
  const client = new SiiClient(io);
  await client.synchronize();
  const settings = await client.settings();
  const sensors = await client.status(8);
  const errors = await client.status(1);
  return { markMode: Boolean(settings[0] & 4), markDetected: Boolean(sensors & 8),
    paperEmpty: Boolean(sensors & 2), nearEnd: Boolean(sensors & 4),
    coverOpen: Boolean(sensors & 1), markError: Boolean(errors & 4), sensors, errors };
}

async function prepare(io: PrinterIO) {
  const client = new SiiClient(io);
  await client.synchronize();
  const settings = await client.settings();
  if (!(settings[0] & 4)) throw new Error('Black mark mode is disabled (MS1-3); configure the printer first. No paper movement sent');
  await client.assertReady();
  return client;
}

export async function feedToMark(io: PrinterIO, offsetMm?: number) {
  const alignment = markAlignmentBytes(offsetMm);
  const client = await prepare(io);
  await client.execute(Buffer.from([0x1b, 0x40]));
  await client.assertReady();
  await client.execute(alignment);
  await client.assertReady();
}

// For dry-run/export only. Actual printing fences and checks each stage separately.
export function markedJobBytes(job: MarkedJob, cut = false, offsetMm?: number): Buffer {
  return Buffer.concat([job.setup, markAlignmentBytes(offsetMm), job.body, FORM_FEED, ...(cut ? [CUT] : [])]);
}

export async function printMarkedJob(io: PrinterIO, job: MarkedJob, cut = false, offsetMm?: number) {
  const alignment = markAlignmentBytes(offsetMm);
  const client = await prepare(io);
  await client.execute(job.setup);
  await client.assertReady();
  await client.execute(alignment);
  await client.assertReady();
  if (job.body.length) {
    await client.execute(job.body);
    await client.assertReady();
  }
  await client.execute(FORM_FEED);
  await client.assertReady();
  if (cut) {
    await client.execute(CUT);
    await client.assertReady();
  }
}
