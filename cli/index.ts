#!/usr/bin/env node
import { parseArgs } from 'node:util';
import { readFile, writeFile } from 'node:fs/promises';
import { compileReceipt, compileImage, loadReceipt } from './src/receipt.ts';
import { makeSamples } from './src/samples.ts';
import { sendToPrinter } from './src/usb.ts';
import { paperLayout } from './src/paper.ts';

const help = `使い方: pnpm run print <command> [file] [options]
実行例:
  リポジトリルート: pnpm run print receipt examples/demo.receipt --dry-run
  cli/ 内:         pnpm run print receipt ../examples/demo.receipt --dry-run
  入出力ファイルの相対パスは、実行時の作業ディレクトリを基準に解決します。
コマンド:
  status                 印刷せずにUSBステータスを取得
  samples                文字サイズ・日本語・内蔵QRの見本を印刷
  receipt <file>         UTF-8のReceiptLine原稿を印刷
  image <file>           画像を縮小・白地合成して印刷
  raw <file>             既存のESC/POSバイナリーを1回送信
オプション:
  --ignore-paper-status  用紙確認後、この個体の紙ステータス0x20を無視
  --dry-run              USBに接続せずデータを生成
  --output <file>        印刷せずバイナリーを保存
  --preview <file.svg>   印刷せずSVGプレビューを保存（receiptのみ）
  --paper-width <mm>     用紙幅: 58（初期値）または80（receipt/imageのみ）
  --section <section>    見本: all（初期値）またはjapanese-qr（samplesのみ）
  --help                 このヘルプを表示`;

async function main() {
  const { values, positionals } = parseArgs({ allowPositionals: true, options: {
    'ignore-paper-status': { type: 'boolean' }, 'dry-run': { type: 'boolean' },
    output: { type: 'string' }, preview: { type: 'string' },
    'paper-width': { type: 'string' }, section: { type: 'string' },
    help: { type: 'boolean' },
  } });
  if (values.help || positionals.length === 0) { console.log(help); return; }
  const [command, file] = positionals;
  const needsFile = ['receipt', 'image', 'raw'].includes(command);
  if (!['status', 'samples', 'receipt', 'image', 'raw'].includes(command)
      || positionals.length !== (needsFile ? 2 : 1)) throw new Error(help);
  for (const [option, valid] of [['preview', command === 'receipt'],
    ['paper-width', command === 'receipt' || command === 'image'],
    ['section', command === 'samples'], ['output', command !== 'status']] as const) {
    if (values[option] !== undefined && !valid) throw new Error(`--${option} is not valid for ${command}`);
  }
  const paperWidth = Number(values['paper-width'] ?? 58);
  paperLayout(paperWidth);
  if (command === 'status') {
    if (values['dry-run']) throw new Error('status requires a USB connection');
    return sendToPrinter(null, { statusOnly: true });
  }
  let payload: Buffer;
  switch (command) {
    case 'samples': payload = makeSamples(values.section); break;
    case 'raw': payload = await readFile(file); break;
    case 'image': payload = await compileImage(file, { paperWidth }); break;
    case 'receipt': {
      const document = await loadReceipt(file, { paperWidth });
      const options = { paperWidth };
      payload = compileReceipt(document, options);
      if (values.preview) await writeFile(values.preview, compileReceipt(document, { ...options, svg: true }));
      break;
    }
    default: throw new Error(help);
  }
  console.log(`Prepared ${payload.length} bytes (${command})`);
  if (values.output) await writeFile(values.output, payload);
  if (values['dry-run'] || values.output || values.preview) return;
  await sendToPrinter(payload, { ignorePaperStatus: values['ignore-paper-status'] });
}

main().catch(error => {
  console.error(`Error: ${error.message}`);
  if (error.cause) console.error(`Cause: ${error.cause.message}`);
  process.exitCode = 1;
});
