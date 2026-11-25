# dev-team ロードマップ

着手順と進捗。**仕様ではない**（仕様は [docs/spec/](spec/)、決定は [docs/adr/](adr/)）。

各段階が単独で動く状態を保つ。段階ごとに実装計画を切る。✅ が付いていない項目は未着手か未完了。

## 段階1: 骨格 + 移設 ✅ 完了（2026-08-15）

- プラグイン化（`plugins/dev-team/`、ADR 0001）
- それまで個別のスキルだった 3 つ（ticket-intake → spec-intake に改名 / dev-loop / dev-loop-dashboard）を、手順を変えずにプラグインへ移す
- ADR 0001〜0006

## 段階1.5: 仕様の SSoT 化と環境回収 ✅ 完了（2026-08-20）

レビューで見つかった構造上の問題への対処。

- 設計書を `docs/spec/` へ再編し、決定を ADR に一本化、進捗を本ファイルへ分離（ADR 0007）
- 実行時データを揮発 / 累積に分離（ADR 0008）
- dev-loop にワークツリーの孤児回収を追加（実運用で git 管理外の孤児が 11 個滞留していた）

## 段階2: setup + 台帳

- `.claude/rules/dev-team.md` の生成（[spec/setup.md](spec/setup.md)）
- `templates/`（開発ルール・PR/Issue テンプレート・spec README・ADR 雛形）
- `references/tracker-github.md`（Jira 版は語彙だけ）
- **既存3スキルを台帳参照に改修する**（これを漏らすと台帳が誰にも読まれない）

## 段階3a: 累積ログの記録開始（一部完了）

**現行フローのまま、記録だけ始める。** 段階3b・3c を待たずに着手でき、着手した日からデータが溜まり始める。

- `review-log.jsonl` の追記を dev-loop のレビュー反復に組み込む ✅
- `friction-log.jsonl` の追記を dev-loop の各工程に組み込む（`step` の安定 ID を SKILL.md の節に振る）✅
- 置き場は `.claude/dev-team-log/`（コミット対象、ADR 0008）✅
- 揮発データを `.claude/dev-loop/` から `.claude/dev-team/` へ移し、`.gitignore` に `.claude/dev-team/` を追加する。ダッシュボードの `eventsPathFor()` も同時に変える

依存: なし（段階2 の完了を待たない）

## 段階3b: 人間ゲート

- draft PR で作成し、自動ゲート合格後に `gh pr ready`
- ラベル `status:awaiting-review` を追加
- 回収フェーズ（起動時・終了前に Approve 済み PR をマージ）
- CI 待ち・外部レビュアー待ちを自動ゲートに組み込む
- events.jsonl に `awaiting-review` / `approved` を追加

依存: 段階3a（指摘を review-log に記録する枠組み）

## 段階3c: 専用エージェント

- `agents/spec-reviewer.md`（SSoT 仕様・受け入れ条件との一致を審査）
- `agents/ui-verifier.md`（Playwright で `[ui]` 受け入れ条件を操作確認）
- events.jsonl に `ui-verifying` を追加

依存: 段階3b（自動ゲートの枠組み）、段階4（spec-reviewer が照合する SSoT）

## 段階4: spec-intake の拡張

- 仕様の現状確認 → 差分 → ADR → 仕様 PR → チケットの流れ
- `[ui]` / `[e2e]` マークの導入
- dev-loop からの差し戻し（`/dev-team:spec-intake #N`）
- 既存プロダクトの仕様の初期化（[spec/intake.md](spec/intake.md)「仕様の初期化」）

## 段階5: 計測と振り返り

- `scripts/metrics.mjs`（Node、依存なし。`node --test` でテスト）
- `/dev-team:dev-metrics`
- `/dev-team:dev-retro`（[spec/retro.md](spec/retro.md)）
- dashboard に `awaiting-review` 列と計測パネルを追加

依存: 段階3a のデータが一定量たまっていること

## 段階 M: 窓口 manager

人が話す相手を 1 セッションに集め、開発セッションの起動と巡回を肩代わりする（ADR 0010、[spec/manager.md](spec/manager.md)）。段階 2〜5 と独立に着手できる。

- 前提の事前検証（`claude --bg` / `claude agents --json` / `claude attach` / セッション間 SendMessage）✅（2026-09-06）
- `skills/manager/SKILL.md`（起票・起動と表示・巡回・改善提案）✅
- spec-intake に対象プロジェクトの指定を追加 ✅
- dev-loop に manager からのメッセージへ SendMessage で終了報告を返す手順を追加 ✅
- 巡回・起票の委譲先エージェント `agents/patrol-collector.md` / `agents/intake-drafter.md`（ADR 0011）✅
- 実プロジェクトで 1 サイクル通す（通ったら段階を完了にする）

### M-1: リポジトリごとの manager（ADR 0013、2026-09-14 決定）

manager を「1 端末 1 つ・台帳駆動」から「1 リポジトリ 1 つ・cwd 駆動」に改める。台帳はダッシュボード専用になる。

- 前提の事前検証（自分自身を `$PPID` で除く、リンクされたワークツリーの判定、Herdr のタブ操作）✅
- `skills/manager/SKILL.md`: description（「このリポジトリの窓口」）、前提（台帳不要）、起動時（対象の識別）、巡回（1 プロジェクト）、Herdr（自分の workspace にタブを足す）✅
- `agents/patrol-collector.md`: 1 件の `name` / `path` / `owner/repo` を受ける ✅
- `agents/intake-drafter.md` と `skills/spec-intake/SKILL.md`「対象プロジェクトの指定」: cwd の制約を迂回時だけに縮める ✅
- 状態ファイル: Herdr の記録を 1 manager 1 ファイル（`<state-dir>/herdr/<name>.json`）にする ✅
- 手動検証: リポジトリの workspace から manager を起動し「識別 → 巡回 → 起動 → タブ表示 → 終了報告 → タブ close」を 1 周する（通ったら M-1 を完了にする）

依存: なし。前提条件として dev-loop の経路に Ask / deny ルールが無いこと（[spec/manager.md](spec/manager.md)「権限の前提条件」）

## 段階 M2: 複数プロジェクトの監視盤 ✅ 完了（2026-09-06）

台帳の全プロジェクトを 1 プロセス・1 画面で見渡す dev-loop-dashboard（ADR 0012、[spec/dashboard.md](spec/dashboard.md)）。

- `createDashboard({projects})` と `(args, project) => gh` の注入、`Promise.allSettled` によるプロジェクト単位の劣化 ✅
- `/api/state` / `/events` を `{generatedAt, summary, projects}` にネスト。1 リポジトリモードは後方互換で最上位にも展開 ✅
- CLI: 既定台帳 / `--ledger` / `--project`（繰り返し）✅
- UI: プロジェクトごとの縦積み + 横断サマリ。駅間移動のキーは `name#number` ✅
- デモ 2 組（`demo/<name>/`）✅

依存: 台帳 `<state-dir>/projects.json`（M-1 以降はダッシュボード専用。[spec/dashboard.md](spec/dashboard.md)「台帳」）。`awaiting-review` 列と計測パネルは段階 5。

## 段階 E: 端末に依存しない配布 ✅ 完了（2026-11-26）

マーケットプレイスのキャッシュから読み込まれても動くようにする（ADR 0014）。

- フロー改善の起票先を環境変数 `DEV_TEAM_FLOW_REPO` で受け取る ✅
- 状態ファイルの置き場を環境変数 `DEV_TEAM_HOME` で受け取る（manager・ダッシュボード）✅
- 開発サーバーの停止スクリプトを dev-loop に同梱し、停止してよい範囲を `--root` で渡す ✅（`tests/stop-dev-server.test.sh`）
- Herdr での表示手順を `skills/manager/references/herdr.md` に分ける ✅

## 未決事項

- Jira 版の具体手順は最初の Jira プロダクトで書く。コードホストは当面 GitHub 固定
- GitHub の `reviewDecision` はブランチ保護なしでも Approve / Changes requested を返すが、stale approval の扱いは保護設定次第。回収時は「最新コミットに対する Approve」を条件にする
- 並列運転（Workflow スクリプト）は将来。events.jsonl の `agent` フィールドで拡張余地を確保済み。同一リポジトリ内の並列は Agent Teams も候補（ADR 0010 で検討）
- レビュー反復の上限（3 回）に達したときに残った指摘が軽微な場合の扱い。運用では、データ損失・セキュリティに当たらない独立した小さな修正を「マージ + フォローアップ Issue」で処理した例がある。SKILL.md は blocked にするとだけ書いている
- マージ後に依存物のインストールをやり直す手順が SKILL.md に無い（運用の friction-log に記録あり）
