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
コンテキストとして使用できます。別PCのブラウザでWebUSBを使う場合はHTTPSが必要です。
編集・PNG生成はLAN内のHTTPでも利用できます。WebUSBが操作するのは、画面を開いた端末のUSB機器です。

LAN・VPNから開発画面を開く場合は、待受アドレスと、追加で使用するホスト名を指定できます。
通常の `pnpm dev` は引き続きlocalhostだけで待ち受けます。

```sh
DEV_ALLOWED_ORIGINS=golem,golem.local pnpm --dir web exec next dev --hostname 0.0.0.0 --port 3131
```

`DEV_ALLOWED_ORIGINS` はポート番号を含めないホスト名・IPアドレスのカンマ区切りです。
Devサーバーを開始したホスト名とlocalhostはNext.jsが許可するため、追加の接続先だけを指定します。

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

## 宛名ラベル編集UI

`http://localhost:3123/editor` にReactコンポーネントを画像化する編集画面があります。
既存のUSBテスト画面 `/` からも移動できます。見本の住所・氏名は架空のデータです。

- 郵便番号、複数行の住所、氏名、QRの内容、QR・ロゴの表示を変更。
- 58mm／80mmロール、印刷高さ、文字サイズ、太字、白黒化のしきい値を変更。
- 上下左右の余白を個別に変更（0〜20mm、0.125mm刻み）。初期表示はすべて1mm。文字は住所20px・氏名32px、しきい値は192が既定。
- `AddressLabel` コンポーネントのDOMを `html-to-image` でブラウザ内のCanvasへ描画し、白黒2値のプレビューを自動更新。PNGの保存も可能。
- 画面の表示倍率・devicePixelRatioに関係なく1ピクセル＝1ドット。58mmは432ドット（54mm）、80mmは576ドット（72mm）の最大印字幅を使用。
- はみ出し・要素の重なりを検出した場合は画像生成・印刷を停止。編集中の旧画像は保存・印刷に使わない。
- 完成したラスタを `GS v 0` に変換し、既存のWebUSB接続から直接印刷。サーバーへ文面・画像を送信しない。

画像化前にフォントとロゴの読み込みを待ちます。通常文字は同梱したNoto Sans JPの可変Webフォントを明示的に読み込み、
DOMで測った位置・ベースライン・行間を使ってCanvasへ直接描画します。
画像化用SVG内のWebフォント描画には依存しません。ドット文字も元のCanvasから直接合成します。
QR・ロゴはDOMから画像化して同じCanvasへ合成します。
外部フォント配信サービスへは接続しません。
Dark Readerが編集画面のHTML・色を書き換えると、hydrationの警告や印刷用の白黒画像への干渉が起きます。
`/editor` のheadに公式の `darkreader-lock` メタタグを出力し、この画面ではDark Readerの自動配色を停止するよう要求します。
編集画面は明るい配色になります。拡張機能側の挙動でなお変換される場合は、このサイトでDark Readerを無効にしてください。
仕様は [Dark Readerの公式説明](https://github.com/darkreader/darkreader/blob/main/CONTRIBUTING.md#disabling-dark-reader-on-your-site) を参照してください。
ブラウザやOSによる描画の差は残るため、最終的な見た目は白黒画像と実紙で確認してください。
通常のブラウザ印刷機能ではなく、生成したピクセルをプリンターへそのまま送る経路です。

入力が止まってから180ms後に自動でラスタライズします。実行中もフォームは編集でき、途中の変更はまとめて最新の内容だけを処理します。
画像化は並列実行せず、古い処理が完了しても現在のプレビューに反映しません。文字のフォントデータはブラウザの読み込み済みデータを使います。
表示倍率の変更は生成済み画像の拡大だけを行い、画像化し直しません。
更新待ちの間は前回画像を薄く表示し、PNG保存・印刷を無効にします。最新画像の完成後は、その画像をそのまま保存・印刷します。
不正な入力や読み込み失敗時はプレビューを消して理由を表示します。自動更新自体ではUSBへ送信しません。

余白は印刷画像の内側に確保し、左・上を変えると住所などの左上基準の要素、右・下を変えるとQR・ロゴなどの右下基準の要素が移動します。
文字サイズと画像の寸法は変えません。内容が余白内に収まらない場合や、空欄・範囲外の値は画像生成・保存・印刷を停止します。
余白設定は画像内の値で、紙端からの距離ではありません。本体の印字不能領域は58mm設定で左右各約2mm（仕様上±1mm）です。
「見本の内容に戻す」とページの再読み込みでは、余白を含む既定値に戻ります。

「文字の描き方」で比較用のドットフォントへ切り替えられます。既定は通常フォントのままです。
ドット側は同梱のGNU Unifont Japanese 18.0.01のBDFをブラウザ内で展開し、字形をCanvasへ直接描画します。
住所は16px・32px、氏名は16px・32px・48px、郵便番号は16px固定です。
通常フォント側のサイズ・太字設定は切り替えても保持します。
整数倍の黒い矩形で描くため、ドット文字にはアンチエイリアス・太字・しきい値による太さ調整は適用しません。
QRとロゴは共通で、同じ画像生成・USB印刷経路を使います。長い文面・大きい文字は同様にはみ出し・重なりを検出します。

ドットフォントは選択時に約1.3MBを同じサーバーから取得し、以後はそのページ内で共有します。
取得・描画完了を待って画像化し、読み込み失敗や未収録文字（例：𠮷）がある場合は出力を止めます。
結合濁点などはNFC正規化してから描きます。このBDFは基本多言語面のみのため、拡張漢字を含む文面では通常フォントを使用してください。
[フォント配布元](https://unifoundry.com/unifont/)とライセンス・著作権表記は `public/fonts/README.txt` に記載しています。
原配布のBDFは変更せず、SIL Open Font License 1.1の条件で同梱しています。

### ラベル印刷の完了確認と用紙位置

編集UIではBulk IN endpoint 2でSIIの実行完了応答・設定・ステータスを読みます。
USBの転送完了だけを印字完了とは扱いません。本体の紙幅とマークモードをRAM上で一時変更し、
終了時は元の設定40バイトとの一致を確認します。FLASHへは保存しません。
通信の失敗やタイムアウトでは後続の印字・カット・自動再送を止め、接続と用紙位置を破棄します。
USB書き込みに失敗して設定を戻せない場合は、本体の電源を入れ直す案内を表示します。

マーク紙は、この個体の58mm手作り紙で確認した49mmピッチの診断経路を移植しています。
初回は60mmを上限に黒帯の終端へ頭出しします。7行ラスタ＋1ドット通常送りの1mm刻みの探索中は、左端に細い印が出ます。
既定のカット補正は−1.5mm。カット後1mm順送り＋8.625mm逆送りで次の区画に戻し、各枚を印字・カットします。
逆送りが仕様の74ドットを超える補正値や、マーク紙で40mmを超える印刷高さは印刷前に拒否します。
カット間隔は最低2秒確保します。市販紙・80mmのマーク紙の位置精度は未検証です。

正常カット後の位置は同じページの同じ接続中だけ保持し、次のジョブは開始時の頭出しを省きます。
通常ロールでも正常カット後の位置を保持し、同じジョブの2枚目以降と次のジョブの先頭では74ドット（9.25mm）逆送りして上余白を減らします。
位置が不明な最初の1枚は逆送りしません。ヘッド〜カッター間隔の約12.1mmが画像の上余白に加わります。
カットしない連続印刷では枚間の逆送りを行いません。
紙を交換・手送りした場合は「紙を交換・手動で動かした」を押して位置を無効にしてください。
紙幅・カット補正の変更、切断、再接続、ページ再読み込みでも位置は不明になります。通常ロールでも紙交換・手送り時に位置を無効にしてください。
本体履歴と永続チェックポイントによる再接続後の判定は未実装です。
設計案は [CONNECTION.md](../CONNECTION.md) を参照してください。

### 検証

```sh
pnpm --dir web typecheck
pnpm --dir web lint
pnpm --dir web exec playwright test --project=ui
```

編集内容の自動反映、表示倍率に依存しない白黒PNG、連続入力の集約、古い処理の破棄、更新中の保存・印刷停止、はみ出し、印刷幅変更をブラウザで確認します。
USBはシミュレーターで分割応答・設定復元・カット後再開・短い転送・黒帯未検出を検証します。
完了応答が印字前・印字後・カット後に返らない3ケースでは、タイムアウト後の画面復帰、後続の印字・カット停止、
USB要求が残る間の再接続拒否、遅延応答後も再送しないことを検証します。
ドット側は整数倍の画素一致、PNGへの画素一致、読込待ち、未収録文字・取得失敗時の停止も検証します。
スマホ相当の画面幅・DPR 3でも、郵便番号・住所・氏名の各領域に黒画素があることと、文字用フォントの読込待ちを検証します。
このエミュレーションはChromiumです。利用者から、iPhone SafariでDark Readerをオフにすると文字が表示されたとの確認がありました。
`darkreader-lock` 追加後の実機Safariでの効果は未確認です。
このテストは実機へ送信しません。別の開発サーバーを利用する場合は `WEB_TEST_PORT=3131` のように指定できます。
golem上のChrome for Testingから本UIを操作し、住所20px・氏名32pxの画像を実機へ1枚印字しました。
実際のWebUSBで、通常ロールモード・カットなしの印字完了応答と元設定40バイトの復元を確認しています。
マーク紙の探索では60mm以内に黒帯が見つからず、宛名印字・カット前に停止しました。実紙の黒帯の有無は不明です。
利用者から、住所20px・氏名32pxの実紙の文字は綺麗に見えるとの確認がありました。
QR読み取り・マーク紙の位置精度は未確認です。

同日の360ドット版Canvas描画経路でも、通常ロールで2枚を1回の操作から印字・各カットしました。
実際のWebUSBへ渡した送信列を記録し、`ラスタ→カット→ラスタ→カット` の順序、
2枚ともプレビューと同じラスタデータであること、カット間隔2256.1ms、各枚の完了応答、元設定40バイトの復元を確認しました。
一時的なブラウザ管理ポリシー・USBノードの所有者は元に戻しています。
記録は [verification/editor-two-labels.json](verification/editor-two-labels.json)、
印刷用画像は [verification/screenshots/editor-two-labels.png](verification/screenshots/editor-two-labels.png) にあります。
利用者が、実紙2枚とも宛名が印字され、それぞれカットされていることを確認しました。
通常ロールのため、マークに対するカット位置・区画を飛ばさない再開は検証していません。

上・右余白の改善版では432ドットへ広げ、通常ロールで再度2枚を印字・各カットしました。
初回は位置不明のまま印字し、2枚目の前だけ74ドット逆送りする送信列を確認しています。
MS4の一時値は`f7`、2枚のラスタはプレビューと一致し、カット間隔2258.5ms、元設定40バイトの復元も確認しました。
記録は [verification/editor-margins.json](verification/editor-margins.json)、
画像は [verification/screenshots/editor-margins.png](verification/screenshots/editor-margins.png) にあります。
利用者の写真で2枚の印字・カットを確認し、本人から2枚目の上余白が減ったとの確認がありました。
写真内のQRも2枚とも読み取れました。右余白は依然大きいとの指摘があり、紙の横位置・印刷原点の確認を継続しています。
QRの黒い部分までの右余白には、画像内余白のほかにQRの白縁（4セル・1.5mm）が含まれます。

## Windowsの準備

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
