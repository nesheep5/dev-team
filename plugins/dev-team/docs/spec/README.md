# dev-team 仕様（SSoT）

dev-team プラグインの**現在の仕様**を領域ごとに記述する。決定の経緯はここに書かず [ADR](../adr/) を参照する。進捗と着手順は [ROADMAP](../ROADMAP.md) にある。

この文書群は ADR 0007 に基づく SSoT である。仕様を変えるときはここを直す。決定を伴うなら ADR を追加してから直す。

## 状態表記

フレームワークの仕様は未実装部分も含めて記述する（ADR 0007）。各セクション冒頭に状態を明記する。

- `状態: 実装済み` — 現在そう動く
- `状態: 未実装（ロードマップ <段階>）` — そう動かす予定。実装時に ROADMAP の該当段階を消化する
- `状態: 一部実装` — 差分を本文に明記する

## 領域

| ファイル | 領域 |
|---|---|
| [data-contracts.md](data-contracts.md) | 工程間の受け渡し規約。台帳・チケット・ログ・PR 本文 |
| [loop.md](loop.md) | dev-loop（自律開発ループ） |
| [intake.md](intake.md) | spec-intake（要件 → 仕様・ADR・チケット） |
| [setup.md](setup.md) | setup（初回セットアップと台帳生成） |
| [retro.md](retro.md) | dev-metrics / dev-retro（計測と振り返り） |
| [manager.md](manager.md) | manager（窓口。リポジトリごとに 1 つ。起票・起動・巡回） |
| [dashboard.md](dashboard.md) | dev-loop-dashboard（監視盤。台帳の全プロジェクトを 1 画面に） |

## 目的

要件の壁打ちから実装・レビュー・マージ・振り返りまでの開発ループを、Claude Code のエージェント群で自律的に回す**開発フレームワーク**。プラグインはフレームワーク部分だけを担い、プロダクト固有の運用は台帳（ADR 0006）で吸収する。

## 必須要件

- **要件整理**: 人と壁打ちして要件を整理し、アプリ全体仕様（SSoT）の更新・設計判断の ADR・開発チケットを作る
- **自律開発ループ**: ready なチケットを、実装 → 品質チェック → PR 作成 → CI/外部 AI レビュー → コードレビューサブエージェント → Playwright 動作確認 → 人の最終レビュー → マージ、の順で処理する
- **フィードバックループ**: レビュー指摘を開発時の観点（開発ルール）へ反映する
- **計測**: レビューのラリー回数、日次 PR 数などの開発効率を測る
- **振り返り**: 開発ループを俯瞰し、スキルの改善案・新設案を提案する
- **窓口**: リポジトリごとに 1 つの manager が、そのリポジトリへの起票・開発セッションの起動と巡回を肩代わりする（ADR 0010、ADR 0013）。複数リポジトリの横断ビューはダッシュボードが持つ（ADR 0012）
- **汎用性**: チケット管理・開発ルール・PR 作成ルール・ドキュメント運用ルールはプロダクトごとに異なる。フレームワークは役割と契約だけを固定する

このうち実装済みなのは、要件整理のうちチケット化まで、自律開発ループのうち「実装 → 品質チェック → PR 作成 → コードレビューサブエージェント → マージ」、窓口、横断ビュー。フィードバックループ・計測・振り返りは、入力になる記録（review-log / friction-log）の書き出しだけが実装済み。各領域の状態は各ファイルの状態表記にある。

## 対象外（現時点）

- 複数チケットの並列運転（events.jsonl の `agent` フィールドで拡張余地だけ確保する）
- Jira トラッカーの具体手順（語彙と設定項目だけ定義し、最初の Jira プロダクトで書く）
- GitHub 以外のコードホスト（Bitbucket / GitLab）

## 配置と構造

状態: 一部実装（下の木で「未実装」と書いたディレクトリは存在しない）

リポジトリの `plugins/dev-team/` がプラグイン本体で、リポジトリのルートの `.claude-plugin/marketplace.json` がそれをマーケットプレイスとして公開する。スキルは `/dev-team:<skill>` で呼ばれる（ADR 0001）。プラグインの中のファイルは `${CLAUDE_PLUGIN_ROOT}` / `${CLAUDE_SKILL_DIR}` で参照し、絶対パスで書かない（ADR 0014）。

```
plugins/dev-team/
├── .claude-plugin/plugin.json
├── skills/
│   ├── setup/               # 未実装。初回セットアップ（台帳生成・推奨ルール雛形）
│   ├── spec-intake/         # 実装済み（仕様・ADR への拡張は未実装）
│   ├── dev-loop/            # 実装済み（人間ゲートは未実装）。scripts/stop-dev-server.sh を同梱（ADR 0014）
│   ├── dev-metrics/         # 未実装
│   ├── dev-retro/           # 未実装
│   ├── manager/             # 実装済み。窓口（ADR 0010、リポジトリごとに 1 つ: ADR 0013）。references/herdr.md は Herdr 内での表示手順
│   └── dev-loop-dashboard/  # 実装済み。複数プロジェクト対応（ADR 0012、[dashboard.md](dashboard.md)）
├── agents/                  # 一部実装。patrol-collector.md / intake-drafter.md 実在（ADR 0011）。spec-reviewer / ui-verifier は未実装
├── references/              # 未実装。トラッカー別手順（tracker-github.md / tracker-jira.md）
├── scripts/                 # 未実装。metrics 集計・ログ集計（Node、依存なし）
├── templates/               # 未実装。開発ルール・PR/Issue テンプレート・spec README・ADR の雛形
├── docs/adr/                # プラグイン自身の ADR
├── docs/spec/               # この文書群
├── docs/ROADMAP.md          # 着手順と進捗
└── evals/                   # 未実装。claude plugin eval 用ケース
```

トラッカー依存の手順は `references/tracker-<name>.md` に 1 か所だけ書き、各スキルは `${CLAUDE_PLUGIN_ROOT}/references/` を参照する（スキルごとに複製しない）。

## 端末ごとの設定

状態: 実装済み（ADR 0014）

| 環境変数 | 既定 | 読むもの | 用途 |
|---|---|---|---|
| `DEV_TEAM_HOME` | `~/.claude/dev-team` | manager・ダッシュボード | 状態ファイルの置き場。manager-log・起票の下書き・Herdr の記録・ダッシュボードの台帳 |
| `DEV_TEAM_FLOW_REPO` | なし（迂回しない） | manager | 開発フロー・スキル・ルール・設定を管理するリポジトリのローカルの絶対パス。フロー改善の起票先 |

どちらも `settings.json` の `env` などで渡す。プロダクトごとの設定（台帳 `.claude/rules/dev-team.md`、ADR 0006）とは別物で、こちらは端末の属性である。

## 汎用化の切り分け

状態: 未実装（ロードマップ 段階2）

| 概念 | フレームワークが固定すること | プロダクトが決めること（台帳） | setup の推奨既定 |
|---|---|---|---|
| チケット管理 | 操作語彙（ready 一覧・遷移・コメント・本文・作成・依存）・状態モデル | バックエンド（GitHub / Jira）、ラベル・ステータス名の対応、依存の表現、Jira の接続方式 | GitHub Issues + ラベル |
| 開発ルール | 「実装前に読む」「レビューの照合先」「dev-retro の提案先」 | 文書の所在・内容 | 雛形を生成 |
| PR 作成ルール | PR 本文の必須要素、draft → ready の流れ | テンプレート、マージ方式、ブランチ規約、既定レビュアー、外部 AI レビュアーと待機時間 | squash / `ticket/<N>-<slug>` / テンプレート生成 |
| ドキュメント運用ルール | 「SSoT 仕様がある」「設計判断は ADR に残る」「チケットは仕様の該当箇所を参照する」 | 仕様の置き場所と分割方針、参照の書き方、ADR の置き場所と書式、仕様変更の承認フロー、外部ドキュメントが正の場合の扱い | `docs/spec/` + `<a id>` / `docs/adr/` MADR 軽量版 / 自動マージ |

## テスト方針

| 対象 | 方法 | 状態 |
|---|---|---|
| スクリプト（`scripts/metrics.mjs`、dashboard の `server.mjs` / `lib/state.mjs`） | `node --test`。リポジトリの `tests/dev-loop-dashboard/`。GitHub 応答はフィクスチャ JSON か偽の gh を注入する | dashboard 分のみ実装済み |
| 開発サーバーの停止スクリプト | `tests/stop-dev-server.test.sh`。一時ディレクトリで本物の TCP サーバーを起動し、`--root` の内側だけを止めることを確かめる | 実装済み |
| スキルの発火・手順遵守 | `claude plugin eval` のケース（`evals/`）。発火と手順遵守をグレーダーで判定 | 未実装 |
| エンドツーエンド | 実在のプロジェクトのバックログで dev-loop を連続運転する | 個人の開発プロジェクトで 11 チケットを実施（2026-09-13〜14） |
