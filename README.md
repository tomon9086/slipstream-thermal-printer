
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

