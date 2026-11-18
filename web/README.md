# RP-E11 WebUSB検証

Next.jsのクライアントから実機のUSBへ直接送信するテストアプリです。
サーバー側のUSB API、印刷キュー、`window.print()`は使用しません。
対象はVID `0619` / PID `0123`、Configuration 1、Interface 0、Bulk OUT 1です。

## プロジェクトの構成

`create-next-app@16.4.6`の公式テンプレートを土台にしています。生成時の指定は以下です。

```sh
pnpm dlx create-next-app@16.4.6 web \
  --ts --app --eslint --no-tailwind --no-src-dir \
  --no-react-compiler --no-cache-components --import-alias '@/*' \
  --use-pnpm --skip-install --disable-git --agents-md --no-agent-feedback --yes
```

生成された`tsconfig.json`をそのまま採用し、`next.config.ts`・ESLint・`.gitignore`も公式設定を使います。
ESLintと`.gitignore`にはPlaywrightの生成物の除外だけを追加しています。
生成時のサンプル画面・画像・Google FontsはWebUSB画面と既存のCSSに置き換えています。

ワークスペースに合わせた変更は以下です。

- 依存インストールはルートで行い、生成されたpnpmのビルド許可設定はルートの設定に統合。
- パッケージ名と既存のReactパッチ版を維持し、Node.js 26に合わせた型定義を使用。
- TypeScriptとESLintはテンプレートの指定を採用。
- ローカル検証用に`dev`・`start`を`127.0.0.1`へ制限し、型チェックとPlaywrightのスクリプトを追加。

## 起動

リポジトリルートで実行します。既存CLIと同じNode 26系・pnpmを使います。

```sh
pnpm install --frozen-lockfile
pnpm --dir web dev --port 3123
```

ChromeまたはEdgeで `http://localhost:3123` を開きます。localhostはWebUSBの安全な
コンテキストとして使用できます。別PCからアクセスする場合はHTTPSが必要です。

「USB接続」→「ステータス取得」→用紙を確認してチェック→「1回印刷する」で実行します。
紙ステータス0x20の扱いは [CONNECTION.md](../CONNECTION.md) を参照してください。
チェックを入れてもNo Errorビットが落ちている状態での印刷は停止します。
送信途中の失敗・短い転送で停止し、自動再送しません。並行印刷も行いません。
失敗した場合は紙の出力を確認してから再接続・再実行してください。
ステータス取得は2秒、接続・構成選択・占有・各送信は15秒でタイムアウトします。
タイムアウトした接続は破棄し、遅れて応答が届いても後続データを送信しません。
終了処理は最大2秒待って画面操作を再開します。前のUSB処理が残る間は再接続を止めるため、
接続できない場合はUSBの抜き差しかページの再読み込みを行います。

初回はユーザー操作で機器選択します。許可済みの対象機器が1台なら`getDevices()`から再接続します。
複数台ある場合は選択画面を使います。

## Windowsの準備

共通PowerShellとRP-E11用プロファイルによる確認・導入・検証は [WinUSB設定ツール](../winusb/README.md) を参照してください。

RP-E11の対象USBインターフェースをZadig等でWinUSBへ割り当てます。
USB IDを確認して、別のUSB機器を選ばないでください。WinUSBへ変更したRP-E11は
通常のプリンタードライバーによる印刷との共用を想定しません。
同じUSB IDには同じドライバーパッケージを利用でき、設定は各PCで必要です。
Windowsでの実機動作は未確認です。

## 印刷データ

`public/fixtures/`には既存CLIの生成処理で作ったバイナリーを保存しています。
この段階ではブラウザ内でReceiptLine変換は行いません。

- `japanese-qr.bin`: 実機確認済みの`makeSamples('japanese-qr')`。527バイト。
- `demo.bin`: 58mm用ReceiptLineデモ。ロゴ・画像QRを含む7202バイト。
- `manifest.json`: 各ファイルのバイト数とSHA-256。

生成処理は `cli/scripts/generate-web-fixtures.ts` にあります。
再生成はルートで`pnpm web:fixtures`を実行します。画面は送信前のSHA-256をログに記録します。

## 自動検証

```sh
pnpm --dir web exec playwright install chromium
pnpm --dir web lint
pnpm --dir web typecheck
pnpm --dir web build
pnpm --dir web test
```

通常の`test`はWebUSB非対応時の表示と、短い転送時の停止・再送防止・解放を検証します。
無応答時の画面復帰、遅延応答後の送信停止、終了処理が止まった場合の案内も検証します。
実機テストはスキップします。

`typecheck`は`next typegen`でNext.jsの型を生成してから実行します。
自動生成される`next-env.d.ts`はGitで管理しません。

以下は**実物に日本語・QR見本を1回印刷してカット**します。自動リトライは0です。

```sh
pnpm --dir web test:usb
```

Playwrightは通常版Chromiumのヘッドレスモード（`channel: 'chromium'`）を使用します。
実機のWebUSB APIはモックしません。OSのUSBアクセス権に加えて、ブラウザへの事前許可が必要です。
`testing-policy.json`は `http://localhost:3123` と `0619:0123` だけを許可する管理ポリシーの例です。
これはWebUSBの許可だけを与え、WinUSBの設定やLinuxのアクセス権は変更しません。

LinuxのPlaywright同梱Chrome for Testingでは、次のパスでこのポリシーが反映されることを確認しました。
管理者がテスト中だけ配置し、終了後に削除してください。既存ファイルがあれば上書きせず内容を確認します。

```text
/etc/opt/chrome_for_testing/policies/managed/slipstream-webusb-test.json
```

LinuxのUSB権限については [CONNECTION.md](../CONNECTION.md) のudev設定を参照してください。
今回の実行ではudevルールは追加せず、対象デバイスノードの所有者を一時変更し、テスト後に元へ戻しました。

WindowsのChrome / Edgeでは対応する`WebUsbAllowDevicesForUrls`管理ポリシーを設定します。
Playwrightからインストール済みブラウザを使う場合は、PowerShellで次のように指定できます。

```powershell
$env:USB_BROWSER_CHANNEL = "msedge" # Chromeなら "chrome"
pnpm --dir web test:usb
```

管理ポリシーがない場合、ヘッドレス実機テストは送信前に理由を表示して失敗します。
`DeviceAccess`のDevTools経由での機器選択も試しましたが、この環境では選択待ちから進まなかったため採用していません。
手動の画面操作では管理ポリシーは不要です。

結果は `test-results/` の`usb-report.json`に保存します。失敗時はスクリーンショットとトレースも保存します。
`CAPTURE_USB_SCREENSHOTS=1`を設定すると、接続前・印刷準備完了・送信完了の画面も結果フォルダーに保存します。
WebUSB自体には転送ごとのタイムアウト指定がないため、アプリ側で接続を無効化し、終了処理を試みます。
USB処理そのものの中断を保証するものではありません。実機テスト全体にも30秒の期限を設けています。
送信成功は紙への印字完了を保証しません。

## 実機で確認した結果

2026-11-17、Linux・Chrome for Testing 159.0.8154.6で確認しました。

- ヘッドレスChrome内から実機に接続。
- `GET_PORT_STATUS`は`0x38`。
- 日本語・SII内蔵QR見本を`527/527`バイト送信。
- 切断・インターフェース解放に成功。
- 一時的な管理ポリシーを削除し、USBデバイスノードの所有者を復元。

保存した通信記録は [verification/linux-headless.json](verification/linux-headless.json) にあります。
2026-11-18にはタイムアウト対応後の実機送信も確認しました。ステータスは`0x18`で、
日本語・SII内蔵QR見本の`527/527`バイト送信と切断に成功しました。
接続前・状態確認後・送信完了の画面は [verification/screenshots/](verification/screenshots/) に保存しています。
紙の印字内容・QR読み取り、およびWindowsでの実行は未確認です。

参考: [ChromeのWebUSB説明](https://developer.chrome.com/docs/capabilities/usb)、
[WinUSBの要件](https://developer.chrome.com/docs/capabilities/build-for-webusb#windows)、
[Edgeの事前許可ポリシー](https://learn.microsoft.com/en-us/deployedge/microsoft-edge-browser-policies/webusballowdevicesforurls)。
