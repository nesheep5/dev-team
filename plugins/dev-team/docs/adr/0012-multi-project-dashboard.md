# 0012: ダッシュボードは 1 プロセスが台帳を読み、状態をプロジェクトでネストして全件を 1 画面に出す

- ステータス: accepted（2026-09-06）

## 背景
manager（[ADR 0010](0010-manager-front-door.md)）は端末ローカルの台帳 `projects.json` で複数プロジェクトの dev-loop を並行に回す。一方 dev-loop-dashboard は 1 リポジトリ専用で、プロジェクト数ぶんサーバーとブラウザタブを開くしかなかった。開いていないタブのプロジェクトで止まったループや blocked に気づけないのが問題で、`docs/spec/manager.md` は「複数プロジェクトを 1 画面にした dashboard」を v1 対象外に置いていた。

## 決定
- **1 プロセス**が全プロジェクトを担当する。ポートも PID も 1 つ。停止は現行どおり `kill <PID>`
- **台帳駆動**。引数なしなら既定台帳（状態ディレクトリの `projects.json`）があれば全件、無ければ cwd の 1 リポジトリ。`--ledger <path>` で台帳を差し替え、`--project <path>`（繰り返し可）は台帳なしでも動き、両方あれば `--project` を優先する。台帳を読むのは CLI（isMain）だけで、`createDashboard()` とテストは台帳ファイルに触らない
- **状態はプロジェクトでネスト**する。`/api/state` と `/events` は `{ generatedAt, summary, projects: [{ name, path, loop, tickets, mergedThisLoop, log, dag, warnings }] }` を返す。`projects[i]` の中身は従来の `buildState()` の出力そのもので、Issue 番号はリポジトリ間で衝突するため tickets や DAG をプロジェクトを跨いで混ぜない。横断集計 `summary` は純粋関数 `summarizeProjects()` が作る
- **1 リポジトリモードは残す**。`createDashboard({repoRoot, gh})` は無改修で動き、このモードでは後方互換のため `projects[0]` の内容と `repo` を最上位にも展開する
- **`name` は一意**。gh 状態・UI の駅間移動キー・デモのパスの全部が `name` をキーにするため、重複は起動時に拒否する。`--project` の basename 衝突は `親/basename` で自動的に区別する
- **劣化はプロジェクト単位**。gh は `Promise.allSettled` で並行に取り、完了した順に配信し、1 呼び出し 20 秒でタイムアウトさせて 1 つの失敗・遅延を他に波及させない。`path` が存在しない、または gh が失敗したプロジェクトはその項目の `warnings` にだけ `eventsMissing` / `ghError` を載せ、他は通常表示する。複数モードでは起動前の `gh repo view` チェックを「そのプロジェクトだけエラー表示」に降格し、プロセスは起動する
- **UI は縦積み**。プロジェクトごとにヘッダ 1 行 + 5 駅レーン + 依存 DAG + ログを積み、上部に横断サマリを置く。タブ切替にしない（開いていないプロジェクトの停止・blocked に気づけないため）
- **manager はダッシュボードを起動しない**。巡回で起動コマンドと URL を案内するだけ

## 検討した選択肢
- プロジェクトごとに 1 サーバー + 集約ページ: 既存コードをほぼ触らずに済むが、N ポート・N PID の管理と集約ページからの CORS 越しの取得が要り、停止手順も N 回になる。運用の手間が増える方向で、manager の「1 画面」の趣旨に反する
- `--projects` で既存コードを N 回呼ぶ薄いラッパ: 実装は最小だが、状態の形が「配列の配列」になり UI 側で名前付けと番号衝突の回避を全部やり直す。`summary` の置き場も無い。ネスト形にするなら最初から `createDashboard` を複数対応にする方が短い
- タブ切替 UI: 画面は広く使えるが、タブの裏のプロジェクトで止まった dev-loop に気づけない。監視盤の目的に反する

## 影響
- `docs/spec/dashboard.md` を新設し、`docs/spec/manager.md` の「対象外（v1）」から複数プロジェクト dashboard を外す。`docs/spec/retro.md` の dashboard 節は dashboard.md への参照に差し替える
- events.jsonl のパス解決を `eventsPathFor()` 1 つに寄せた。`.claude/dev-loop/` から `.claude/dev-team/` への移行（ADR 0008、別件）ではここだけ変える
- デモは `demo/<name>/{gh.json, events.jsonl}` に再構成し 2 組を同梱する。番号が重なる Issue（#10 / #15）を両方に置き、混ざらないことを目で確認できるようにした
- 依存ゼロ（Node 標準ライブラリのみ）と `lib/state.mjs` に I/O を入れない方針は維持する
- ロードマップに段階 M2（複数プロジェクトの監視盤）を新設する。段階 M の台帳に依存する
