import { SiiClient } from './black-mark.ts';
import type { PrinterIO } from './usb.ts';

const modeBits = { off: 0, 'initial-cut': 0x40, 'stamp-cut': 0x20 } as const;
export type PaperSetMode = keyof typeof modeBits;

export function parsePaperSetMode(value: string): PaperSetMode {
  if (!Object.hasOwn(modeBits, value)) {
    throw new Error('Paper Set Handle mode must be off, initial-cut, or stamp-cut');
  }
  return value as PaperSetMode;
}

function describe(settings: Buffer) {
  const bits = settings[4] & 0x60;
  // MS5-6〜7は00と11のどちらも無効。変更時は00に統一する。
  const mode: PaperSetMode = bits === 0x40 ? 'initial-cut' : bits === 0x20 ? 'stamp-cut' : 'off';
  return { mode, ms5: `0x${settings[4].toString(16).padStart(2, '0')}` };
}

export async function inspectPaperSetHandle(io: PrinterIO) {
  // 用紙交換中は実行応答要求が破棄されるため、同期タグを待たず設定を直接読む。
  return describe(await new SiiClient(io).settings());
}

export async function setPaperSetHandle(io: PrinterIO, mode: PaperSetMode, save = false) {
  parsePaperSetMode(mode);
  const client = new SiiClient(io);
  const before = await client.settings();
  const expected = Buffer.from(before);
  // MS5-6〜7だけを変更し、自動応答やカット方式などの設定を保持する。
  expected[4] = (before[4] & ~0x60) | modeBits[mode];
  const changed = !expected.equals(before);
  if (!changed && !save) {
    return { before: describe(before), after: describe(before), saved: false, changed: false };
  }
  const hardware = await client.status(0);
  const paper = await client.status(1);
  // 用紙交換に必要なカバー開放・紙なしは許可し、それ以外の実エラーでは停止する。
  if ((hardware & 13) || (paper & ~9)) {
    throw new Error(`Printer error: hardware=0x${hardware.toString(16)}, paper=0x${paper.toString(16)}`);
  }
  try {
    // 同じ現在値でも、保存を指定した場合はFLASHへ書く。RAMと保存値は一致するとは限らない。
    await io.write(Buffer.from([0x12, 0x77, save ? 0x85 : 5, expected[4], 0]));
    // 設定変更は本体を初期化する。紙を動かさず、後続の読み戻しで処理完了を確認する。
    const after = await client.settings();
    if (!after.equals(expected)) throw new Error('Memory-switch readback did not match expected settings');
    if ((await client.status(4)) & 1) throw new Error('FLASH memory is still being written');
    return { before: describe(before), after: describe(after), saved: save, changed };
  } catch (cause) {
    throw new Error(`Paper Set Handle update could not be verified; no automatic retry. Previous MS5: ${describe(before).ms5}. Read paper-set status before retrying`, { cause });
  }
}
