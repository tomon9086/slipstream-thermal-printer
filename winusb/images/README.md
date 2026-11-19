# Zadig手順書の画像出典

掲載元: [Pete Batard / libwdi — Zadig公式ユーザーガイド](https://github.com/pbatard/libwdi/wiki/Zadig#basic-usage)

| ローカルファイル | 元画像 |
| --- | --- |
| `zadig-device-selection.png` | [Zadig_02.png](https://raw.githubusercontent.com/wiki/pbatard/libwdi/images/Zadig_02.png) |
| `zadig-install-success.png` | [Zadig_05.png](https://raw.githubusercontent.com/wiki/pbatard/libwdi/images/Zadig_05.png) |

2026-11-19取得。上の2ファイルは元画像のままで、変更はありません。
画像中の機器はXboxコントローラー、Zadigは旧バージョンです。RP-E11で撮影した画面ではありません。
手順書では操作箇所を説明するために掲載しています。

## 手順書に掲載する注釈版

| 注釈版 | 編集元 | 注釈 |
| --- | --- | --- |
| `zadig-device-selection-annotated.png` | `zadig-device-selection.png` | ①Options、②機器一覧、③USB ID、④変更先ドライバー、⑤実行ボタン |
| `zadig-install-success-annotated.png` | `zadig-install-success.png` | ⑥現在のWinUSBドライバー、⑦成功表示 |

内蔵`image_gen`の編集機能を使用し、赤枠・番号の追加と拡大を行いました。原画像は上書きしていません。
元の機器名・USB ID・ドライバー名・成功表示を目視で照合しています。

編集時の指示:

- 機器選択画面: 元のUI・文字・数値・縦横比を維持し、Options、機器一覧、USB ID、変更先ドライバー、
  Install Driverの5箇所だけに赤枠と白文字の番号①〜⑤を追加する。文字を隠さず、説明文や新しいUIを作らない。
- 成功画面: 元のUI・文字・数値・縦横比を維持し、左側のWinUSB欄と下部の成功表示に赤枠と番号⑥・⑦を追加する。
  確認用の画面なので、実行ボタンは強調しない。

Zadigの開発元: Pete Batard / Akeo Consulting。
[公式サイトのライセンス・ソースコード案内](https://zadig.akeo.ie/#license)も参照してください。
画像を含む上流の著作物について、本プロジェクト独自のライセンスを主張するものではありません。
