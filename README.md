
# SlipStream

レシートプリンターをハックする

## Node.js版

ReceiptLine原稿の変換からUSB送信までNode.jsで実行できます。Pythonは不要です。
Node.js 26.x（本環境は26.13.1）・pnpm 12.21.0、LinuxのUSBアクセス権限が必要です。

```sh
pnpm install --frozen-lockfile

# 接続・ステータスだけ確認
pnpm run print status

# ReceiptLine原稿を印刷せずに変換・プレビュー
pnpm run print receipt examples/demo.receipt --preview /tmp/receipt.svg --output /tmp/receipt.bin

# 原稿から印刷
pnpm run print receipt examples/demo.receipt --ignore-paper-status
```

USB権限がない場合、印刷・接続確認のコマンドは `sudo "$(command -v node)" cli.js ...` で実行できます。
依存パッケージのインストールは通常ユーザーで実行してください。
この作業環境のNodeは以下に配置しました。PATHにNodeがない場合は先に設定します。

```sh
export PATH="$HOME/.local/share/slipstream/node-v26.13.1-linux-x64/bin:$PATH"
```

### CLI

| コマンド | 内容 |
| --- | --- |
| `node cli.js status` | USBステータス確認のみ |
| `node cli.js hello` | Hello, World!と紙送り・カット |
| `node cli.js samples` | 従来と同じ英数字サイズ・日本語・SII内蔵QRの見本 |
| `node cli.js samples --section japanese-qr` | 日本語とQRだけの見本 |
| `node cli.js receipt examples/demo.receipt` | UTF-8のReceiptLine原稿を変換して印刷 |
| `node cli.js image image.png` | 画像を白地合成・縮小・網点変換して印刷（JPEG等も対応） |
| `node cli.js raw /tmp/receipt.bin` | 生成済みの印刷バイナリーをそのまま送信 |

印刷コマンドには必要に応じて `--ignore-paper-status` を付けます。
この個体で印刷できる状態でも立つUSBの紙ステータスビットだけを回避する指定です。
エラーを示すビット状態での停止は回避しません。
`--dry-run`、`--output <file>`、`--preview <file.svg>` はどれも印刷せずに終了します。
`--preview` は `receipt` のみ対応し、ブラウザー用SVGを保存します。
プレビューの日本語書体は閲覧環境・Webフォントの読み込みに依存し、実機の内蔵書体とは異なります。

ReceiptLineは `command: 'sii'`、`encoding: 'shiftjis'`、`cpl: 30` が初期値です。
幅は半角文字数で指定し、`receipt --cpl 36` で432ドット設定にも対応します。
`image --width 432` で画像幅も変更できます。初期値は360ドットです。
36桁・432ドット幅はプリンターの印字幅設定が対応している場合に使ってください。

### 原稿と実装

[examples/demo.receipt](examples/demo.receipt) を編集すれば、Pythonや印刷コマンドを書かずに
レシートを作れます。記法は [ReceiptLine](https://github.com/receiptline/receiptline) を参照してください。

- `src/receipt.js`: ReceiptLine変換とsharpによる画像の前処理。
- `src/samples.js`: 実機確認済みの文字サイズ・日本語・SII QR見本をNodeへ移植。
- `src/usb.js`: USB接続・ステータス確認・送信・解放。
- `cli.js`: 上記を呼び出すCLI。

USBは `usb` のlibusb版（2.x）を使い、転送タイムアウトと実転送バイト数を確認します。
最大4096バイトずつ順番に送り、途中エラー・短い転送では停止し、自動再送しません。
カーネルドライバーの自動切り離しは行いません。
ReceiptLine出力はバイナリー文字列なので `Buffer.from(data, 'latin1')` で保持します。
ReceiptLineのSII向けQRはライブラリ側で画像を生成します。
`samples` は従来と同じSII内蔵QRコマンドで、両者は別の印刷経路です。

pnpmは `packageManager` で12.21.0に固定し、依存バージョンは `pnpm-lock.yaml` で管理します。
`.node-version` と `engines.node` でNode 26系を指定し、pnpmの `engineStrict` でも確認します。
pnpm未導入の場合は [pnpmの導入手順](https://pnpm.io/installation) を参照してください。
この環境ではNode 26のbinディレクトリーにpnpmコマンドも配置済みです。
`pnpm-workspace.yaml` はUSBネイティブモジュールのビルドを許可しています。

### 確認結果

`pnpm test` で15件のテストを実行できます。
紙ステータス・実エラーによる停止、転送分割とバイト保持、途中エラー時の再送防止、USB解放、
Shift JIS変換、QR画像生成、透明画像の白地合成を確認しています。
`hello` と `samples` のデータは、印刷確認済みPython版とのバイト一致を確認済みです。
Node版で実機のステータス `0x38` を取得し、デモ原稿全2797バイトのUSB送信に成功しました。
Node版デモの紙の出力・QR読み取りはユーザーによる確認待ちです。

## Python版のUSBテスト印刷

以下は初期検証で使ったPython版です。動作比較用に残しています。

RP-E11で `Hello, World!` の実機印刷を確認済みです。
Python 3とシステムの `libusb-1.0` を使い、ESC/POSをUSBへ直接送信します。
CUPSやPython追加パッケージは不要です。

印刷せずに接続とUSBステータスを確認:

```sh
python print_hello.py --status-only
```

テスト印刷（紙送り・パーシャルカット付き）:

```sh
python print_hello.py
```

今回の個体では、印刷できる状態でもUSBステータスが `0x38` でした。
その場合は用紙を実機で確認してから、次のコマンドを使います。

```sh
python print_hello.py --ignore-paper-status
```

USBへのアクセス権限がない場合は `sudo python ...` で実行するか、udevルールを設定してください。
接続情報、権限設定、ステータスの注意点は [CONNECTION.md](CONNECTION.md) にまとめています。

## 画像印刷

`print_image.py` は透過部分を白に合成し、縦横比を保って縮小、白黒の網点に変換して印刷します。
58mm用紙の両方の印字幅設定に収まる360ドット（45mm）幅が初期値です。
ESC/POSのラスター画像コマンドで送信し、紙送り・パーシャルカットします。
USB送信成功後の印字結果は実機で確認してください。

Pillowを仮想環境にインストールして使います。

```sh
python -m venv .venv
.venv/bin/pip install Pillow

# 印刷せずにプレビューを保存
.venv/bin/python print_image.py image.png --dry-run --preview /tmp/preview.png

# 印刷（USB権限がなければsudoを付ける）
.venv/bin/python print_image.py image.png --ignore-paper-status
```

`--ignore-paper-status` は前述の個体固有の紙ステータスを回避するための指定です。
`--width 432` で54mm幅にもできますが、プリンターの印字幅設定が432ドットの場合に使用してください。

## 文字サイズ・日本語・QRコードのテスト

`print_samples.py` は内蔵フォントA/Bそれぞれで、横×縦が1×1、1×2、2×1、2×2、3×3、4×4倍の
英数字見本を印刷します。続いてShift JISの日本語（ひらがな・カタカナ・漢字・半角カナ）を
漢字フォントA/Bの通常・縦横2倍で試します。その後、同じ内容 `https://example.com/` のQRコードを
1セル3・5・7ドットの3サイズで印刷し、紙送り・パーシャルカットします。
Python追加パッケージは不要です。

```sh
# USBへ送信せずにデータ生成のみ確認
python print_samples.py --dry-run

# 接続確認のみ
python print_samples.py --status-only

# 見本を1枚印刷（USB権限がなければsudoを付ける）
python print_samples.py --ignore-paper-status

# 日本語とQRだけを印刷（英数字のサイズ見本を省略）
python print_samples.py --section japanese-qr --ignore-paper-status
```

文字はプリンター内蔵フォントの拡大、QRはプリンター内蔵の生成機能を使います。
QRはSII固有の `DC2 ;`（セルサイズ）と `GS p 1`（印刷）を使い、Model 2・誤り訂正M・
自動バージョン・8-bit byteモードを指定します。プリンターが4セル分の余白を付けます。
Epson式 `GS ( k` はこの実機ではQRにならず、パラメーターが文字として印字されることを確認しました。
日本語は `FS C 1` でShift JISを指定し、`FS !` で漢字フォントと拡大を設定します。
コマンドの参考: [SII RP-E10技術説明書](https://www.mouser.com/datasheet/2/360/Seiko_RPE10_Technical_Reference-355440.pdf)
（6-68〜6-69: QR、6-71〜6-75: 漢字）。
英数字のサイズ見本と、SIIコマンドに修正後のQR・日本語は、ユーザーによる実機の印字確認済みです。
QRコードの読み取りも、ユーザーにより問題ないことを確認済みです。

