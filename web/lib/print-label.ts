import { readStatus, writeBytes, type PrinterSession } from './printer';
import { labelWidth, rasterBytes, type RasterLabel } from './label';

type Reply = { kind: 'hex'; data: Uint8Array } | { kind: 'status' | 'execution'; value: number };
type Position = 'unknown' | 'after-cut';
export const DEFAULT_MARK_SEARCH_LIMIT = 60;
export type PrintLabelOptions = {
  paperWidth: 58 | 80; marked: boolean; cut: boolean; ignorePaper: boolean;
  position: Position; cutAdjustMm: number; copies: number;
  markSearchLimit?: number;
};
const pause = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
// 同じ接続でジョブを続けて実行した場合も、カット間隔を維持する。
const lastCutByDevice = new WeakMap<USBDevice, number>();
const join = (...parts: Uint8Array[]) => {
  const result = new Uint8Array(parts.reduce((sum, part) => sum + part.length, 0));
  let offset = 0;
  for (const part of parts) { result.set(part, offset); offset += part.length; }
  return result;
};

class Sii {
  private pending = new Uint8Array();
  private replies: Reply[] = [];
  private tag = 0;
  writeFailed = false;
  constructor(private session: PrinterSession) {}

  async write(bytes: Uint8Array) {
    try { await writeBytes(this.session, new Uint8Array(bytes)); }
    catch (error) { this.writeFailed = true; throw error; }
  }
  private decode(chunk: Uint8Array) {
    this.pending = join(this.pending, chunk);
    if (this.pending.length > 4096) throw new Error('本体の応答が長すぎます。');
    while (this.pending.length) {
      const first = this.pending[0];
      if ([14, 2, 15].includes(first)) {
        const end = this.pending.indexOf(0, 1);
        if (end < 0) break;
        if (first === 14) {
          const encoded = this.pending.slice(1, end);
          if (encoded.length % 2) throw new Error('HEX応答が不正です。');
          const data = new Uint8Array(encoded.length / 2);
          for (let i = 0; i < encoded.length; i += 2) {
            if ((encoded[i] & 240) !== 224 || (encoded[i + 1] & 240) !== 240) throw new Error('HEX応答が不正です。');
            data[i / 2] = (encoded[i] & 15) | ((encoded[i + 1] & 15) << 4);
          }
          this.replies.push({ kind: 'hex', data });
        }
        this.pending = this.pending.slice(end + 1);
      } else if ((first & 240) === 192) {
        if (this.pending.length < 8) break;
        if (!this.pending.slice(1, 8).every(byte => (byte & 240) === 208)) throw new Error('自動ステータス応答が不正です。');
        this.pending = this.pending.slice(8);
      } else {
        if ((first & 240) === 160) this.replies.push({ kind: 'status', value: first & 15 });
        if ((first & 240) === 128) this.replies.push({ kind: 'execution', value: first & 15 });
        this.pending = this.pending.slice(1);
      }
    }
  }
  private async receive(kind: Reply['kind'], value?: number): Promise<Reply> {
    const deadline = Date.now() + 5000;
    for (;;) {
      const index = this.replies.findIndex(reply => reply.kind === kind && (value === undefined || ('value' in reply && reply.value === value)));
      if (index >= 0) return this.replies.splice(0, index + 1).at(-1)!;
      this.replies = [];
      const remaining = deadline - Date.now();
      if (remaining <= 0) throw new Error('本体の完了応答がありません。紙を確認してください。');
      const response = await this.session.execute('本体応答の受信', () => this.session.device.transferIn(2, 64), remaining);
      if (response.status !== 'ok' || !response.data) throw new Error('本体の応答を受信できませんでした。');
      this.decode(new Uint8Array(response.data.buffer, response.data.byteOffset, response.data.byteLength));
    }
  }
  async synchronize() {
    await this.write(new Uint8Array([0x12, 0x71, 15]));
    await this.receive('execution', 15);
  }
  async execute(bytes: Uint8Array | number[]) {
    this.tag = this.tag % 14 + 1;
    await this.write(join(new Uint8Array(bytes), new Uint8Array([0x12, 0x71, this.tag])));
    await this.receive('execution', this.tag);
  }
  async settings() {
    await this.write(new Uint8Array([0x12, 0x6c, 0]));
    const response = await this.receive('hex');
    if (response.kind !== 'hex' || response.data.length !== 40) throw new Error('本体設定の応答が不正です。');
    return response.data;
  }
  async status(n: number) {
    await this.write(new Uint8Array([0x1d, 0x72, n]));
    const response = await this.receive('status');
    if (!('value' in response)) throw new Error('ステータス応答が不正です。');
    return response.value;
  }
  async ready() {
    const sensors = await this.status(8), errors = await this.status(1), hardware = await this.status(0);
    if ((sensors & 3) || errors || (hardware & 13)) throw new Error(`本体を確認してください（sensor=${sensors}, error=${errors}, hardware=${hardware}）。`);
    return Boolean(sensors & 8);
  }
}

export function printOptionError(height: number, options: PrintLabelOptions): string | null {
  if (!Number.isInteger(options.copies) || options.copies < 1 || options.copies > 10) return '枚数は1〜10枚で指定してください。';
  if (!Number.isFinite(options.cutAdjustMm) || Math.abs(options.cutAdjustMm) > 5) return 'カット補正は−5〜5mmです。';
  const searchLimitMm = options.markSearchLimit ?? DEFAULT_MARK_SEARCH_LIMIT;
  if (options.marked && (searchLimitMm < 1 || !Number.isSafeInteger(searchLimitMm) || !Number.isSafeInteger(searchLimitMm * 8))) {
    return '黒帯の探索上限は1mm以上の整数で指定してください。';
  }
  if (options.marked && height > 320) return '49mmピッチのマーク紙では、印刷高さを40mm以下にしてください。';
  const reverse = 117 + Math.round(options.cutAdjustMm * 8) + 8 - 44;
  if (options.marked && (reverse < 0 || reverse > 74)) return 'カット後の戻し量が本体の上限9.25mmを超えます。補正値を見直してください。';
  if (options.marked && !options.cut && options.copies > 1) return 'マーク紙の複数枚印刷は、1枚ごとのカットを有効にしてください。';
  return null;
}

export async function printRasterLabel(session: PrinterSession, raster: RasterLabel, options: PrintLabelOptions,
  log: (message: string) => void): Promise<Position> {
  const startedAt = Date.now();
  const invalid = printOptionError(raster.height, options);
  if (invalid) throw new Error(invalid);
  if (raster.width !== labelWidth(options.paperWidth)) throw new Error('画像の幅と用紙設定が一致しません。画像を生成し直してください。');
  const image = rasterBytes(raster);
  const usbStatus = await readStatus(session, log);
  if (usbStatus !== null && (!(usbStatus & 8) || ((usbStatus & 32) && !options.ignorePaper))) throw new Error('プリンターまたは用紙の状態を確認してください。');
  if (!session.device.configuration?.interfaces.some(iface => iface.alternate.endpoints.some(endpoint => endpoint.direction === 'in' && endpoint.endpointNumber === 2))) {
    throw new Error('完了確認用のBulk IN endpoint 2がありません。');
  }
  const sii = new Sii(session);
  await sii.synchronize();
  const original = await sii.settings();
  await sii.ready();
  await sii.execute([0x1b, 0x40]);
  const changed: number[] = [];
  let position: Position = 'unknown';
  const cutFeed = 117 + Math.round(options.cutAdjustMm * 8);
  const feed = async (dots: number) => {
    while (dots > 0) { const n = Math.min(dots, 255); await sii.execute([0x1b, 0x4a, n]); dots -= n; }
    await pause(20);
  };
  const returnFromCut = async () => {
    if (options.marked) {
      await feed(8);
      await sii.execute([0x1b, 0x6a, cutFeed + 8 - 44]);
    } else {
      // カット済みの紙だけを仕様上限9.25mm戻し、ヘッド〜カッター間の上余白を減らす。
      await sii.execute([0x1b, 0x6a, 74]);
    }
    await pause(20);
    await sii.ready();
    log(options.marked ? 'カット位置から戻して再開（開始時のマーク探索なし）' : 'カット位置から9.25mm戻して通常ロールの上余白を削減');
  };
  const rowBytes = raster.width / 8;
  const probe = new Uint8Array(8 + rowBytes * 7 + 3);
  probe.set([0x1d, 0x76, 0x30, 0, rowBytes, 0, 7, 0]);
  for (let y = 0; y < 7; y++) probe[8 + y * rowBytes] = 0x80;
  probe.set([0x1b, 0x4a, 1], probe.length - 3);
  const seek = async () => {
    const searchLimitMm = options.markSearchLimit ?? DEFAULT_MARK_SEARCH_LIMIT;
    const searchLimitDots = searchLimitMm * 8;
    let leading = -1;
    for (let dots = 0; dots <= searchLimitDots; dots += 8) {
      const black = await sii.ready();
      if (black && leading < 0) leading = dots;
      if (!black && leading >= 0) {
        // 市販紙では2〜3mmの検出幅を確認済み。黒帯の途中から探索した場合は残り幅だけを読む。
        if (dots - leading < (leading === 0 ? 8 : 16) || dots - leading > 80) throw new Error('黒帯の幅が想定範囲外です。');
        log(`黒帯終端を${dots / 8}mmで検出`);
        return dots;
      }
      if (dots < searchLimitDots) { await sii.execute(probe); await pause(20); }
    }
    throw new Error(`${searchLimitMm}mm以内に黒帯を検出できませんでした。カットせず停止しました。`);
  };
  try {
    const expected = original.slice();
    for (const [index, value] of [[4, (original[3] & ~24) | (options.paperWidth === 80 ? 24 : 16)],
      [1, options.marked ? original[0] | 4 : original[0] & ~4]]) {
      changed.push(index);
      await sii.execute([0x12, 0x77, index, value, 0]); expected[index - 1] = value;
    }
    if (!(await sii.settings()).every((value, index) => value === expected[index])) throw new Error('用紙設定の確認に失敗しました。');
    await sii.execute([0x1d, 0x50, 0, 203, 0x1d, 0x4c, 0, 0, 0x1d, 0x57, raster.width & 255, raster.width >> 8, 0x1b, 0x61, 0]);
    if (options.position === 'after-cut') await returnFromCut();
    else if (options.marked) { await seek(); await feed(44); }
    for (let number = 1; number <= options.copies; number++) {
      if (number > 1 && options.cut) await returnFromCut();
      await sii.ready();
      await sii.execute(image);
      if (options.marked) {
        await feed(1);
        const remaining = await seek();
        if (Math.abs((44 + raster.height + 1 + remaining) / 8 - 49) > 3) throw new Error('用紙の間隔が49mmから外れています。カットせず停止しました。');
        await feed(cutFeed);
      } else await feed(97);
      if (options.cut) {
        const wait = Math.max(0, (lastCutByDevice.get(session.device) ?? startedAt) + 2000 - Date.now());
        if (wait) await pause(wait);
        await sii.ready();
        await sii.execute([0x1d, 0x56, 1]); lastCutByDevice.set(session.device, Date.now());
        position = 'after-cut';
      }
      await sii.ready();
      log(`${number}/${options.copies}枚：印字${options.cut ? '・カット' : ''}の完了応答を確認`);
    }
  } finally {
    if (sii.writeFailed) throw new Error('USB送信が失敗しました。設定を戻せていないため、本体の電源を入れ直してください。');
    try {
      for (const index of changed.reverse()) await sii.execute([0x12, 0x77, index, original[index - 1], 0]);
      if (!(await sii.settings()).every((value, index) => value === original[index])) throw new Error('復元した値が一致しません。');
      log('本体の元設定40バイトを復元・確認');
    } catch (cause) {
      throw new Error('本体設定の復元を確認できませんでした。電源を入れ直してください。', { cause });
    }
  }
  return position;
}
