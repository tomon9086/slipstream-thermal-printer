# WindowsのWebUSB用ドライバー設定

対象USBインターフェースをWinUSBへ変更するための手順と、機器調査・設定用のPowerShellをまとめています。
**まずは[スクリーンショット入りのZadig手順書](ZADIG.md)を使ってください。**
Zadigは公式の実行ファイルを起動して設定でき、`wdi-simple.exe`のビルドは不要です。
共通PowerShellと機種別JSONによる自動設定も利用できます。
最初のプロファイルはSII RP-E11（今回の個体で観測したVID `0619` / PID `0123`）です。
通常のWindowsプリンタードライバーによる印刷との共用は想定しません。
このツールはUSBの割り当てだけを扱い、ブラウザの許可や印刷コマンドの機種対応は変更しません。

## 必要な環境

- Windows 10/11、Windows PowerShell 5.1またはPowerShell 7。`PnpDevice`モジュールが必要です。
- GUIでの設定には[Zadig](https://zadig.akeo.ie/)と管理者権限が必要です。
- PowerShellの`Install`では管理者権限。昇格や実行ポリシーの変更はスクリプトから行いません。
- PowerShellの`Install`では、信頼できるソースからビルドした**libwdiの`wdi-simple.exe`**。
  機器調査・`Inspect`・`Verify`・`Install -WhatIf`では実行ファイルは不要です。

## IDが分からない機器を調査する

プリンターをWindows PCへ接続し、リポジトリルートから実行します。
調査には管理者権限や`wdi-simple.exe`は不要です。

```powershell
.\winusb\Find-WebUsbPrinter.ps1
```

USB Printer Class、現在の`usbprint`サービス、機器名を手掛かりに候補を表示します。
番号で選択すると、VID・PID、MIがあればインターフェース番号、機器名、現在のサービス、
INF、ドライバー提供元などをまとめて表示します。同じIDの機器もInstanceId付きで別々に表示します。
印刷キューではなく、USBに接続された機器の情報を調べます。

```text
[1] SII RP-E10 Series. | 0619:0123 | Interface=未確認 | Service=usbprint
    USB\VID_0619&PID_0123\...
番号を選択（a:全USB機器、r:再読込、q:終了）:
```

候補が見つからなければ他のUSB機器も表示します。`a`で全USB機器、`r`で再読込、`q`で終了できます。
最初から全件を表示したい場合は`-ShowAll`を指定します。
候補判定は目安なので、機器名と抜き差しによる一覧の変化も使って対象を特定してください。

保存を選ぶと`state/discovery/実行ごとのID/`に`device.json`と`profile.draft.json`を保存します。
保存先の親フォルダーは`-OutputDirectory C:\SlipStream\discovery`で変更できます。
ドライバーの変更や導入処理への自動移行は行いません。

- 複合USB機器の子では、`MI_0A`ならインターフェース番号は10と判定します。
- **MIがない機器のインターフェース番号はPnP情報だけでは確定できません。**
  確認済みなら番号を入力でき、未確認でEnterを押すとJSONにも`null`を残します。自動で0にはしません。
- `allowedServices`には観測した現在のサービスと`WinUSB`を候補として記録します。
  この値は、そのメーカー製ドライバーからの変更が検証済みであることを意味しません。
- 複合機器の親、仮想COM、HID等と判定した機器や現在のサービスが不明な機器では、調査結果だけを保存します。

JSONの`name`、`usbInterface`、`allowedServices`を確認し、`models/任意の機種名.json`へコピーすると
`Setup-WebUsbPrinter.ps1 -Model 任意の機種名 ...`で使えます。`usbInterface: null`のままでは導入できません。
MIがない場合は、メーカー資料やUSB記述子を表示するツール（USBViewなど）で番号を確認します。
このリポジトリのRP-E11では、既存の実機調査でインターフェース0を確認しています。

## WinUSB導入用CLIの用意

この節はPowerShellの`-Action Install`で自動設定したい場合だけ必要です。
[Zadigで手動設定する場合](ZADIG.md)は読み飛ばしてください。

`wdi-simple`はZadigと同じlibwdiを使う公式CLIサンプルです。Windows標準コマンドではありません。
確認したlibwdi v1.5.1の公式リリース添付はZadigのみで、CLIの実行ファイルは含まれません。
`zadig.exe`をリネームしても利用できません。本リポジトリは外部EXEを同梱・自動取得しません。

1. [libwdiの公式ビルド手順](https://github.com/pbatard/libwdi/wiki/Install)に従って、
   Visual StudioのC++ビルド環境と、WinUSB用の再配布可能WDKコンポーネントなどを用意します。
2. `git clone --branch v1.5.1 --depth 1 https://github.com/pbatard/libwdi.git` でソースを取得します。
3. `libwdi.sln`を開き、`Release`と環境に合うプラットフォームで`wdi-simple`プロジェクトをビルドします。
   ビルド条件は[公式ソリューション](https://github.com/pbatard/libwdi/blob/v1.5.1/libwdi.sln)も参照してください。
4. 出力された`wdi-simple.exe`を、例えば`winusb/tools/`へ配置し、`--help`で起動を確認します。

ビルド自体はこのLinux環境では未検証です。作成したインストーラーは対象Windows環境で検証してください。
libwdiは生成したドライバーパッケージにローカルの証明書を使うため、組織の証明書・ドライバー導入ポリシーに
よっては導入できません。署名検証を無効化する処理は含めていません。
大量配布向けの署名済みパッケージや、第三者EXEの再配布はこの変更には含めません。

## PowerShellによる設定の使い方

以下はリポジトリルートで実行します。対象プリンターは1台だけ接続してください。

```powershell
# 対象の親・子インターフェース、現在のサービスとINFを確認する。既定もInspect。
.\winusb\Setup-WebUsbPrinter.ps1 -Model rp-e11 -Action Inspect | Format-List

# 変更対象とCLI引数を表示する。ドライバー・ファイルは変更しない。
.\winusb\Setup-WebUsbPrinter.ps1 -Model rp-e11 -Action Install -WhatIf
```

`Inspect`のHardwareIdsがデバイスマネージャーの対象と一致していることを確認します。
Windows上の列挙結果は未確認のため、Interface 0だから必ず`MI_00`になるとは仮定していません。
単一機器のIDと複合機器の`MI_00`の両方を候補とし、候補が1つでなければ変更を停止します。
複合機器の親（`usbccgp`）や別のMIは変更対象から除きます。

管理者として起動したPowerShellから実行します。

```powershell
# 指定したローカルEXEを使ってWinUSBへ変更する。
.\winusb\Setup-WebUsbPrinter.ps1 -Model rp-e11 -Action Install `
    -InstallerPath .\winusb\tools\wdi-simple.exe

# OSの問題コード、WinUSBサービス、公開インターフェースGUIDを確認する。
.\winusb\Setup-WebUsbPrinter.ps1 -Model rp-e11 -Action Verify | Format-List
```

`-Confirm`で実行前の確認も指定できます。実行中はUSBの抜き差しや別の同型機の接続を避けてください。
検出とインストーラーによる変更は一つの原子的な操作ではありません。
libwdi CLIはVID/PID/MIで対象を処理するため、同じIDの複数台を接続したまま使う用途には対応しません。

`Inspect`・`Verify`は読み取りだけです。`Install`は以下の順で処理します。

1. 候補数・現在のドライバーを確認し、実行直前にも再列挙する。
2. 実行ごとのフォルダーに`before.json`を保存する。元のINF、InstanceId、使用EXEのSHA-256も含む。
3. 元のINFが`oem数字.inf`なら`pnputil /export-driver`で`original-driver/`へ保存する。
   保存に失敗したら導入を開始しない。Windows標準INFはエクスポートしない。
4. `wdi-simple`を1回だけ実行する。単一機器なら`--iid`を付けず、複合機器の子ならMIを渡す。
5. `after.json`を保存し、同じInstanceIdにWinUSBと有効なGUIDが設定され、問題コードが0かを確認する。

既に正常なWinUSBなら再導入しません。失敗時の自動リトライ・自動ロールバックは行いません。
インストーラー終了後でも再起動・抜き差しが必要な場合があります。その場合はOSの案内に従い、再度`Verify`します。
`Verify`成功は、ブラウザからの通信・紙への印字成功を保証しません。
続けて[Webアプリの手動操作](../web/README.md#起動)でUSB接続・ステータス取得・印刷を確認してください。

記録と生成パッケージの保存先は既定で`winusb/state/日時/`です。`state/`と`tools/`はGit管理対象外です。
別の保存先は`-StateDirectory C:\SlipStream\winusb-state`で指定できます。
CLIのパス文字コードの問題を切り分ける際は、EXEと保存先を英数字のパスに置いて確認してください。

## 元のドライバーへ戻す

1. ブラウザとプリンターを使用するアプリを終了します。
2. 対応する`before.json`でInstanceId・元のService・DriverInfPathを確認します。
3. デバイスマネージャーで同じ対象を開き、「ドライバーを元に戻す」、または
   「ドライバーの更新」→「コンピューターを参照」→「利用可能なドライバーの一覧から選択」で元のドライバーを選びます。
4. 一覧にない追加ドライバーは`original-driver/`、またはメーカーの正規インストーラーから復元します。
   Windows標準の`usbprint.inf`等はOSのドライバーを選びます。
5. 必要に応じてUSBを抜き差しし、通常印刷と`Inspect`で確認します。

バックアップのINFを登録する場合の例です。`/install`は既存ドライバーより順位が低いと切り替えないので、
パッケージの登録成功だけで復元成功とは判断せず、上のデバイスマネージャーでの選択も行います。

```powershell
pnputil.exe /add-driver "C:\保存先\original-driver\*.inf" /subdirs /install
```

記録フォルダーは復元確認まで保持してください。元のプリンター設定・ポート・印刷キュー・証明書ストア全体の
バックアップではありません。ドライバーパッケージを削除すると同じパッケージを使う別個体にも影響するため、
このスクリプトに一括削除は実装していません。

## 機種を増やす

`models/rp-e11.json`を複製し、機種名のJSONを追加します。通常は共通PSの変更は不要です。

| フィールド | 内容 |
| --- | --- |
| `schemaVersion` | 現在は`1` |
| `name` | WinUSB割り当て後の表示名 |
| `vendorId` / `productId` | 4桁の16進文字列。先頭0も保持する |
| `usbInterface` | 対象のUSBインターフェース番号。複合機器ならMIとしても使う |
| `allowedServices` | 変更を許可する現在のサービス名。未知のドライバーは既定で停止する |

新しい機種では実際のUSB動作モードとWindowsのHardwareIdsを確認してください。
RP-E11は`usbprint`からの変更と既存`WinUSB`の検証だけを許可しています。
メーカー製サービスが表示される場合は、機能や復元方法を確認してからプロファイルを変更します。
USB仮想COMやHID機器を一律にWinUSBへ変更するための仕組みではありません。

Configuration・Bulk endpoint・印刷コマンド・文字コード・ステータス応答はこのJSONの対象外です。
別機種をブラウザから印刷するには、それらのアプリ側対応も別途必要です。

## 検証

```powershell
# Windows/LinuxのPowerShellで実行できる。USBや実ドライバーは変更しない。
pwsh -NoProfile -File .\winusb\tests\Run-Tests.ps1
```

WindowsのPnpDevice・レジストリ・管理者判定・インストーラーをテスト内で置き換えて分岐を検証します。
外部プロセスの失敗終了も、小さなPowerShell子プロセスで確認します。
初回はLinuxのPowerShellとWindowsのPowerShell 7／Windows PowerShell 5.1で、19件のテストに成功しました
（[確認時の実行結果](https://github.com/tomon9086/slipstream-thermal-printer/actions/runs/44319894070)）。
機器調査の追加後は、候補判定・対話選択・未確認値の保持・JSON保存も含む30件をLinuxのPowerShellで確認しています。
継続的なCIは設置せず、変更時は上のコマンドで必要に応じて確認します。
**Windows実機での機器調査・ドライバー変更、libwdiのビルド、RP-E11へのWebUSB通信は未検証です。**

参考:

- [libwdi CLIの公式実装](https://github.com/pbatard/libwdi/blob/v1.5.1/examples/wdi-simple.c)
- [libwdiの署名方式](https://github.com/pbatard/libwdi/wiki/Certification-Practice-Statement)
- [Microsoft: WinUSBのインストールとDeviceInterfaceGUIDs](https://learn.microsoft.com/en-us/windows-hardware/drivers/usbcon/winusb-installation)
- [Microsoft: PnPUtilの構文とドライバー順位](https://learn.microsoft.com/en-us/windows-hardware/drivers/devtest/pnputil-command-syntax)
