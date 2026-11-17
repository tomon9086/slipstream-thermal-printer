
# SlipStream

レシートプリンターをハックする

## USBテスト印刷

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
QRのスマートフォンでの読み取りについては別途確認してください。

