
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

