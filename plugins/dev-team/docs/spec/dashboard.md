# dev-loop-dashboard（監視盤）

dev-loop の稼働状況（チケット × 工程 × 担当エージェント）をブラウザでリアルタイムに見る。台帳の全プロジェクトを 1 プロセス・1 画面で見渡せる。設計判断は [ADR 0012](../adr/0012-multi-project-dashboard.md)。実装は `skills/dev-loop-dashboard/`（`server.mjs` / `lib/state.mjs` / `index.html`）で、依存ゼロ（Node 標準ライブラリのみ）。

## データ源と劣化

状態: 実装済み

データ源はプロジェクトごとに 2 つ。

| 源 | 役割 | 取り方 |
|---|---|---|
| `<project.path>/.claude/dev-loop/events.jsonl` | dev-loop が追記する速報（工程の細部・担当エージェント） | `fs.watchFile`（1 秒間隔）。パス解決は `eventsPathFor()` 1 か所に寄せてある |
| gh CLI | 30 秒ポーリングの正（Issue の open/closed・ラベル・PR） | `gh issue list` / `gh pr list` を `project.path` を cwd にして実行（台帳は `owner/repo` を持たないので `-R` は使わない） |

**どちらが欠けても劣化表示で動き続ける**。この耐性はプロジェクト単位で維持する。

- events.jsonl が無い → その項目の `warnings.eventsMissing = true`。GitHub 情報だけの粗い駅配置になる
- gh が失敗 → `warnings.ghError` に理由を載せ、最後に取れたスナップショットを保持し続ける
- `project.path` が存在しない → gh を呼ばず `ghError` に「パス … が存在しません」を載せ、`eventsMissing` も立つ。他のプロジェクトは通常表示
- gh は全プロジェクトを `Promise.allSettled` で並行に取り、完了したプロジェクトから順に配信する。1 つの `gh` 呼び出しは 20 秒でタイムアウトし、その項目の `ghError` になる（1 つのハングで他が止まらない）。前回のポーリングが終わっていなければ次を重ねない（古いスナップショットの後勝ち防止）。初回起動の listen は最も遅いプロジェクトの応答まで待つ（issue と pr の 2 呼び出しが逐次なので最大約 40 秒）。1 プロジェクトの gh が 30 秒を超えると次の周期は全体でスキップされ、その間は完了順配信だけが走る

## 状態の形

状態: 実装済み

`/api/state`（JSON）と `/events`（SSE、`data:` 行に同じ JSON）は次を返す。URL は 1 リポジトリ時代から変えていない。

```
{ generatedAt, summary, projects: [ { name, path, loop, tickets, mergedThisLoop, log, dag, warnings } ] }
```

- `name` はプロジェクトの一意なキー（gh 状態・UI の駅間移動キー・デモのパス）。**重複は起動時に拒否する**（台帳・`--project`・`createDashboard()` のいずれの入口でも例外）
- `projects[i]` の `loop` 以降は `buildState()` の出力そのもの（[lib/state.mjs](../../skills/dev-loop-dashboard/lib/state.mjs)）。Issue 番号はリポジトリ間で衝突するため、tickets も DAG もプロジェクトを跨いで混ぜない
- `summary` は純粋関数 `summarizeProjects(projects)` の出力。`projectCount` / `runningLoops`（`loop.running` の数）/ `blocked`（全プロジェクトの blocked チケット合計）/ `drift`（ドリフト警告の合計）/ `errors`（`ghError` または `eventsMissing` を持つプロジェクト数）
- `lib/state.mjs` は純粋関数のみで I/O を持たない。`server.mjs` がファイル読み・gh・HTTP・SSE を担う

## 1 リポジトリモード

状態: 実装済み

`createDashboard({ repoRoot, gh })`（`projects` 未指定・`--demo` 無し）は従来どおり動く。内部では `[{ name: basename(repoRoot), path: repoRoot }]` の 1 件として扱い、状態は上の `projects` 形で返す。

**後方互換のため、このモードでは `projects[0]` の内容（`loop` / `tickets` / `mergedThisLoop` / `log` / `dag` / `warnings`）と `repo`（= name）を最上位にも展開する。** 1 リポジトリ時代の利用者（テスト・外部スクリプト）が最上位の `tickets` 等を読んでも壊れない。複数プロジェクトモードとデモではこの展開をしない。

CLI で 1 リポジトリモードになるのは、`--project` も `--ledger` も無く、既定台帳（下の「台帳」）も存在しないとき。このときだけ起動前に `gh repo view` で cwd がリポジトリであることを確かめ、失敗すれば起動しない。

## 複数プロジェクトモード

状態: 実装済み

`createDashboard({ projects: [{ name, path }], gh })`。`gh` の型は `(args, project) => Promise<string>` で、テストは `project.path` で分岐するフェイクを 1 つ注入できる。

CLI での対象の決め方（優先順）:

1. `--project <path>`（繰り返し可）: 指定分だけ。台帳が無くても動く。名前は `basename(path)`。basename が衝突したら `親ディレクトリ名/basename` にして区別する（`~/work/api` と `~/oss/api` → `work/api` / `oss/api`）
2. `--ledger <path>`: その台帳の全件
3. 引数なし: 既定台帳 `<state-dir>/projects.json` があれば全件
4. いずれも無ければ 1 リポジトリモード

`--demo` はこれらすべてに優先し、`--project` / `--ledger` は無視する。値の無い `--project` / `--ledger`、空の台帳（`projects: []`）、壊れた台帳（既定台帳を含む）、名前の重複はいずれも起動せず exit 1 で理由を出す。既定台帳が壊れている場合に 1 リポジトリモードへ黙って落ちることはしない（fail-loud）

台帳を読むのは CLI（`isMain`）だけ。`createDashboard()` とテストは台帳ファイルに触らない。

### 台帳

状態: 実装済み（所有者を manager から dashboard へ移した。ADR 0013）

`<state-dir>/projects.json`。`<state-dir>` は環境変数 `DEV_TEAM_HOME`、未設定なら `~/.claude/dev-team`（ADR 0014。manager と同じ規則）。端末ローカルで、コミットしない（端末ごとにパスもプロジェクトも違う）。読むのはダッシュボードだけで、manager は読まない（manager は cwd から対象を識別する。[manager.md](manager.md)「対象の識別」）。

```json
{ "projects": [
  { "name": "web-app", "path": "/path/to/web-app", "note": "<一行の守備範囲>" },
  { "name": "api-server", "path": "/path/to/api-server", "note": "API とバッチ" }
]}
```

- `name` はプロジェクトの一意なキー。無ければ `basename(path)`。重複は起動時に拒否する
- `path` はリポジトリのルート。`gh` はこのパスを cwd にして実行する（`repo`（`owner/name`）は持たない）
- `note` は人が読むための一行。ダッシュボードは使わない
- 台帳が無ければ 1 リポジトリモードになる（上記）

複数モードでは起動前の gh チェックをしない。gh が使えないプロジェクトはその項目のエラー表示に降格し、プロセスは起動する。

UI は**プロジェクトごとの縦積み**。各セクションはヘッダ 1 行（name・稼働/停止・今回ループのマージ数・blocked 数・GitHub 同期時刻・エラー・path）+ 5 駅レーン + 依存 DAG + ログ。上部に `summary` の横断サマリ。タブ切替にしない（開いていないプロジェクトの停止・blocked に気づけないため）。駅間移動の検出キーは `${name}#${number}`。

manager はダッシュボードを起動しない。巡回で起動コマンドと URL を案内するだけ（[manager.md](manager.md)「逆方向: 巡回と中継」）。

## 起動と停止

状態: 実装済み

```bash
node <プラグインのパス>/skills/dev-loop-dashboard/server.mjs [--ledger <path>] [--project <path>]... [--port N] [--open] [--demo]
```

- 任意のディレクトリから起動できる（1 リポジトリモードだけ cwd がリポジトリである必要がある）
- 既定ポート 4649。塞がっていれば空きへずらす。`--port` 指定時はずらさない
- `--demo` は gh 不要。`demo/<name>/{gh.json, events.jsonl}` を台帳に見立てて全組を表示する（2 組を同梱。番号が重なる Issue を両方に置き、混ざらないことを目で確認できる）
- 起動ログに URL・PID・プロジェクト名を出し、gh に失敗したプロジェクトは警告行を出す
- 停止は起動ログの PID 1 つを `kill <PID>`。ポートも PID も 1 つ。表示専用で状態を持たないためいつ止めてもよい
