
# SlipStream

レシートプリンターをハックする

## 使い方

ReceiptLine原稿の変換からUSB送信までTypeScriptで実装し、Node.jsで実行できます。
Node.js 26.x（本環境は26.13.1）・pnpm 12.21.0、LinuxのUSBアクセス権限が必要です。

```sh
pnpm install --frozen-lockfile

# 接続・ステータスだけ確認
pnpm run print status

# ReceiptLine原稿を印刷せずに変換・プレビュー
pnpm run print receipt examples/demo.receipt --preview /tmp/receipt.svg --output /tmp/receipt.bin

# 原稿から印刷
pnpm run print receipt examples/demo.receipt --ignore-paper-status

# 80mm用のプレビュー（本体の紙幅設定は変更しない）
pnpm run print receipt examples/demo.receipt --paper-width=80 --preview /tmp/receipt-80.svg
```

USB権限がない場合、印刷・接続確認のコマンドは `sudo "$(command -v node)" cli.ts ...` で実行できます。
依存パッケージのインストールは通常ユーザーで実行してください。
USB権限の設定やこの個体のステータス・用紙・コマンドの知見は [CONNECTION.md](CONNECTION.md) を参照してください。
この作業環境のNodeは以下に配置しました。PATHにNodeがない場合は先に設定します。

```sh
export PATH="$HOME/.local/share/slipstream/node-v26.13.1-linux-x64/bin:$PATH"
```

本環境では、PATHに含まれる `~/.local/bin/node` と `~/.local/bin/pnpm` からも呼べるように
リンクを作成済みです。通常のzshでは上記のPATH設定を追加せずに実行できます。

### CLI

| コマンド | 内容 |
| --- | --- |
| `node cli.ts status` | USBステータス確認のみ |
| `node cli.ts samples` | 従来と同じ英数字サイズ・日本語・SII内蔵QRの見本 |
| `node cli.ts samples --section japanese-qr` | 日本語とQRだけの見本 |
| `node cli.ts receipt examples/demo.receipt` | UTF-8のReceiptLine原稿を変換して印刷 |
| `node cli.ts image image.png` | 画像を白地合成・縮小・網点変換して印刷（JPEG等も対応） |
| `node cli.ts raw /tmp/receipt.bin` | 生成済みの印刷バイナリーをそのまま送信 |

印刷コマンドには必要に応じて `--ignore-paper-status` を付けます。
この個体で印刷できる状態でも立つUSBの紙ステータスビットだけを回避する指定です。
エラーを示すビット状態での停止は回避しません。
`--dry-run`、`--output <file>`、`--preview <file.svg>` はどれも印刷せずに終了します。
`--preview` は `receipt` のみ対応し、ブラウザー用SVGを保存します。
プレビューの日本語書体は閲覧環境・Webフォントの読み込みに依存し、実機の内蔵書体とは異なります。

`receipt` と `image` の幅指定は共通の `--paper-width=58|80`（mm）です。省略時は58です。
従来の `--cpl` と `--width` はこのオプションに統一しました。

| 用紙幅 | アプリの印字幅 | 半角文字数/行 |
| --- | --- | --- |
| 58mm（初期値） | 360ドット | 30桁 |
| 80mm | 576ドット | 48桁 |

58mmは実機確認済みのレイアウトを維持します。80mmは本体が80mm・576ドット設定の場合を想定しています。
この指定はデータ生成の幅を切り替えるもので、プリンター本体の紙幅やメモリスイッチは変更しません。
80mmでの実機印刷は未確認です。ReceiptLineの出力方式は `sii`、文字コードは `shiftjis` を使います。

### 原稿と実装

[examples/demo.receipt](examples/demo.receipt) を編集すれば、プログラムや印刷コマンドを書かずに
レシートを作れます。記法は [ReceiptLine](https://github.com/receiptline/receiptline) を参照してください。

デモ先頭の横長ロゴは、本プロジェクト用に図形と文字のパスから作成した画像です。
原本は [SVG](examples/assets/slipstream-shop.svg)、印刷用は [PNG](examples/assets/slipstream-shop.png) で、
外部の画像やフォントは使用していません。

本CLIでは、独立した1行の `{image:@assets/slipstream-shop.png}` でPNGを参照できます。
これはCLI独自の拡張で、パスは原稿ファイルのあるフォルダーを基準に解決します。
読み込み時にReceiptLine標準の `{image:Base64データ}` に変換し、プレビュー・印刷の両方に使います。
原稿内の画像（Base64の直接指定を含む）と単独画像は、向き補正・白地合成・PNG化を共通処理で行います。
選んだ印字幅を超える画像だけを縦横比を保って縮小し、小さい画像は拡大しません。

- `src/receipt.ts`: ReceiptLine変換とsharpによる画像の前処理。
- `src/paper.ts`: 58mm/80mmの印字幅・行幅の対応。
- `src/samples.ts`: 実機確認済みの文字サイズ・日本語・SII QR見本をNodeへ移植。
- `src/usb.ts`: USB接続・ステータス確認・送信・解放。
- `cli.ts`: 上記を呼び出すCLI。

USBは `usb` のlibusb版（2.x）を使い、転送タイムアウトと実転送バイト数を確認します。
最大4096バイトずつ順番に送り、途中エラー・短い転送では停止し、自動再送しません。
カーネルドライバーの自動切り離しは行いません。
ReceiptLine出力はバイナリー文字列なので `Buffer.from(data, 'latin1')` で保持します。
ReceiptLineのSII向けQRはライブラリ側で画像を生成します。
`samples` は従来と同じSII内蔵QRコマンドで、両者は別の印刷経路です。

Node 26の型除去機能で `.ts` を直接実行します。ビルドやtsxは不要です。
`.node-version` と `engines.node` でNode 26系を指定し、pnpmの `engineStrict` でも確認します。
pnpmは `packageManager` で12.21.0に固定し、依存バージョンは `pnpm-lock.yaml` で管理します。
pnpm未導入の場合は [pnpmの導入手順](https://pnpm.io/installation) を参照してください。
この環境ではNode 26のbinディレクトリーにpnpmコマンドも配置済みです。
`pnpm-workspace.yaml` はUSBネイティブモジュールのビルドを許可しています。

### 確認結果

`pnpm typecheck` でstrictの型チェック、`pnpm test` でテストを実行できます。
紙ステータス・実エラーによる停止、転送分割とバイト保持、途中エラー時の再送防止、USB解放、
Shift JIS変換、QR画像生成、透明画像の白地合成を確認しています。
`samples` のデータは、実機確認済みデータのハッシュと一致することをテストしています。
見本の英数字・日本語・SII内蔵QRは、ユーザーによる印字・QR読み取りの確認済みです。
実機のステータス `0x38` を取得し、ロゴ追加後のデモ原稿全7202バイトのUSB送信に成功しました。
pnpm・TypeScript・Node 26.13.1で型チェックと19件のテストを確認済みです。
紙幅指定の追加後も、58mmデモは従来と同じ7202バイトのデータです。
80mmのプレビュー・バイナリー生成と、両幅での画像縮小をテストしています。
Node版デモの紙の出力・QR読み取りはユーザーによる確認待ちです。
