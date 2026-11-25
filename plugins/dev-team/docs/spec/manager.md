# manager（窓口）

リポジトリごとに 1 つ立ち上げ、そのリポジトリについての要望の起票・開発セッションの起動と表示・状況の巡回・改善提案を肩代わりする。設計判断は [ADR 0010](../adr/0010-manager-front-door.md)（窓口の役割）と [ADR 0013](../adr/0013-manager-per-repo.md)（リポジトリごとに 1 つ。cwd が対象）、実行モデル（委譲）は [ADR 0011](../adr/0011-manager-delegates-work.md)、端末ごとの設定は [ADR 0014](../adr/0014-environment-independence.md)。

1 人の開発者が自分の端末で使う前提で組む（トラッカーは GitHub Issues だけを扱う）。実行コードは持たず、SKILL.md とエージェント定義だけで組む。

## 役割

状態: 実装済み

```
人 ──対話── manager（対話セッション、cwd = <repo>）
              │ 起票   gh -R <owner/repo>                    ─▶ GitHub Issues（フロー改善は <flow-repo> へ）
              │ 起動   claude --bg "/dev-team:dev-loop"
              │ 表示   Herdr 内なら自分の workspace に attach 用のタブを足す
              │ 監視   SendMessage(notify_when_idle) / claude agents --json / gh
              ▼
   <repo> の dev-loop（1 リポジトリ 1 ループ）
```

| 役割 | 内容 |
|---|---|
| 窓口 | 持ち込まれた話題を「要望」「フロー改善」「状況確認」「改善案の依頼」に振り分ける。返答は文頭で太字の話題名（案件）を示し、複数の話題は段落を分ける |
| 起票 | spec-intake の手順で cwd のリポジトリに Issue にする。フロー改善だけは `<flow-repo>` へ迂回する |
| 起動と表示 | cwd のリポジトリに dev-loop が無ければ background セッションで起動し、Herdr 内なら自分の workspace にタブを足して attach する |
| 巡回 | 止まっているセッション・blocked Issue・open PR を 1 画面に要約する（cwd のリポジトリだけ） |
| 改善提案 | 中継した割り込みの繰り返しを根拠に、設定・ルール・スキルの改善を提案する |

このうち時間のかかる収集・読解・下書きは background の subagent に委譲し、manager 自身は対話・承認・書き込みだけを行う（後述「実行モデル: 委譲」）。

横断ビュー（複数リポジトリの状況を 1 画面で見る）は manager でなくダッシュボード（[dashboard.md](dashboard.md)）が持つ。manager は他のリポジトリの状況を集めない。

## 対象の識別

状態: 実装済み

manager は台帳を読まない。起動時に cwd から次を導き、以後の手順で使う。

| 値 | 導き方 | 用途 |
|---|---|---|
| `<path>` | `git rev-parse --show-toplevel` | 稼働確認の cwd 前方一致、`claude --bg` の起動場所、subagent に渡す絶対パス |
| `<name>` | `<path>` の basename | manager-log の `project`、Herdr 記録のファイル名 |
| `<owner/repo>` | `gh repo view --json nameWithOwner -q .nameWithOwner` | `gh -R` の値 |
| `<state-dir>` | 環境変数 `DEV_TEAM_HOME`、未設定なら `~/.claude/dev-team` | 状態ファイルの置き場（「状態ファイル」） |
| `<flow-repo>` | 環境変数 `DEV_TEAM_FLOW_REPO` を `git -C <値> rev-parse --show-toplevel` で確かめたもの | フロー改善の迂回先。未設定なら迂回しない。`<path>` と同じなら迂回は不要 |

止まる条件（推測で埋めない）:

- `git rev-parse` が失敗する（リポジトリ外で起動された）
- `git rev-parse --path-format=absolute --git-dir` と同 `--git-common-dir` が異なる（リンクされたワークツリー。絶対パスで比べるのは、サブディレクトリでは `--git-dir` が絶対・`--git-common-dir` が相対 `../.git` になり、素の比較では食い違うため、例 `.claude/worktrees/ticket-N` で起動された）。`<name>` が `ticket-N` になり、dev-loop もワークツリー内で起動してしまうため「メインのワークツリーで起動してください」と伝えて止まる。メインのワークツリーへ自動で読み替えない
- `gh repo view` が失敗する（origin が無い・gh 未認証）
- `DEV_TEAM_FLOW_REPO` が設定されているのに `git -C` が失敗する（パスが無い・git リポジトリでない）

**自分自身の除外**: manager は対象リポジトリの cwd に居るので、`claude agents --json` を `<path>` で絞ると manager 自身の interactive 行も出る。Bash ツール内の `$PPID` が manager の Claude プロセスの pid であり、`claude agents --json` の interactive 行の `pid` と一致するので、稼働確認ではその行を除く（2026-09-14 に実測）。同じ cwd に他の interactive があれば従来どおり人に確認する。

**`gh` は常に `-R <owner/repo>` 付きで打つ。** cwd のリポジトリへの誤起票を防ぐためではなく（cwd が対象なので誤らない）、`<flow-repo>` への迂回と書き方を揃えるため。

## 実行モデル: 委譲

状態: 実装済み

manager は人が話す窓口であり、価値は応答性にある。manager のターンが長いと人の次の要求が待たされ、dev-loop からの終了報告や `notify_when_idle` の通知もターンが終わるまで届かない（事前検証で観測）。そのため manager は自分のターンを短く保ち、時間のかかる作業は Agent ツールで background の subagent に出す（ADR 0011。Agent の subagent は background で走り完了は通知で届く。Bash の `run_in_background` に相当するオプションは Agent には無い）。委譲先はプラグイン同梱のエージェント定義（`agents/patrol-collector.md` / `agents/intake-drafter.md`）で、モデル・エフォート・ツールはその定義側の設定である。

manager が自分で行うのは、人との対話、承認の取得、`gh` の書き込み（`issue create` / `edit` / `comment`）、起動前の `git rev-list --count origin/main..main` の確認と承認後の `git push origin main`、`claude --bg` / `stop` / `rm`、報告先通知の SendMessage、`~/.claude/settings.json` と hooks の編集、`manager-log.jsonl` への追記。委譲したら「収集中」と一言返してターンを終え、完了通知を受けてから結果を収集時刻付きで要約して中継する。完了前に結果を推測して人に伝えない。結果が届かないまま人に再度聞かれたら ListAgents で subagent の生死を見て、消滅・失敗していればやり直す。

| 節 | subagent に委譲する（background） | 使うエージェント | manager が自分でやる |
|---|---|---|---|
| 起動時 | 「巡回」と同じ委譲 | `dev-team:patrol-collector` | 対象の識別・ListAgents・権限確認（いずれも 1〜3 コマンド） |
| 巡回 | cwd のリポジトリの `claude agents --json` / `gh issue list` / `gh pr list` の収集、`blocked` セッションの `claude logs` 読み、要約・blocked の要点・manager-log に追記すべき行の作成。1 巡回 = 1 エージェント | `dev-team:patrol-collector`（`sonnet` / `medium`、`Bash, Read`） | 要約を人に示す。manager-log への追記。`status:blocked` Issue への回答コメントと `status:ready` への戻し（人の答えを受けてから） |
| 起票 | 目的に合意した後のリポジトリの読解（SSoT・ADR・`package.json` scripts 等）と実装方針案・受け入れ条件案の作成。合意後の本文ファイルの下書き（manager が指定した下書き先。起票後に manager が削除する）。両者は同じエージェントの続き（SendMessage） | `dev-team:intake-drafter`（`opus` / `high`、`Read, Glob, Grep, Bash, Write`） | 要件ヒアリング・壁打ち・設計合意・受け入れ条件の合意。`gh issue create -R`。起動の提案 |
| 起動と表示 | **委譲しない** | — | 稼働確認・`claude --bg`・報告先通知・Herdr のタブ作成・`claude rm` のすべて |
| 改善提案 | `manager-log.jsonl` を読み、同型を集計し、根拠の行を添えた提案文を作る | `dev-team:patrol-collector`（流用） | 提案を人に示し、承認を待つ。承認後の settings / hooks の編集、または `<flow-repo>` への起票 |

subagent の制約:

- manager がプロンプトで指定した下書き先（絶対パス）以外に書かない（実質 read-only）。返すのは要約・所見・下書きファイルのパス
- 承認・起動・削除・Issue 作成を人の代わりに行わない。分割起票時の `depends: #N` の書き込みは、Issue 番号を知る manager が 1 件ずつ行う
- これらの制約は subagent が SKILL.md を読まないため、manager がプロンプトに書いて渡す
- subagent の cwd は manager と同じ対象リポジトリで、CLAUDE.md / rules は読み込み済み。**`<flow-repo>` への迂回のときだけ**、対象を `<flow-repo>` 起点の絶対パスで読み（[intake.md](intake.md)「対象プロジェクトの指定」）、必要な規約は manager がプロンプトに含める
- 型の選び方は ADR 0011 のとおり（read-only で足りる作業は read-only 型、下書きが要る作業だけ書き込みできる型）。その既定として上の表のエージェントを使う。`patrol-collector` は書き込み系ツールを持たない。`intake-drafter` の `Write` は指定した下書き先にだけ使う運用上の制約（ツール権限では絞れない）。`fork` は呼び出し元のモデルを継承して `model` 指定を無視するため、定型作業には使わない
- 巡回の委譲では manager-log の絶対パスも渡し、collector はセッションの `startedAt` 以降の既存行とだけ突き合わせて同じ事象の追記候補を二度返さない（同じ事象で「同型 2 回以上」が発火するのを防ぐ）。それより古い同型は再発として返す（改善提案が数えるのは再発。`kind: blocked` だけは Issue 番号で突合する）。改善提案の集計は collector の集計モードで、追記候補は返さない
- subagent が Ask ルールに当たった場合は manager と同じ端末設定を継承するため「権限の前提条件」で足りる想定。問題が出たら別 Issue で扱う

ADR 0010 が退けた Agent Teams は「別リポジトリで開発を回す」用途であり、ここでの subagent は manager 自身の準備作業に限る。開発はこれまでどおりリポジトリごとの background セッションで回す。

## 状態ファイル

状態: 実装済み

いずれも端末ローカルで、コミットしない。

| ファイル | 内容 | 書き手 |
|---|---|---|
| `<state-dir>/manager-log.jsonl` | 中継した割り込みの記録（追記のみ。「改善ループ」） | 全 manager が追記。`project` フィールドで区別する |
| `<state-dir>/herdr/<name>.json` | manager が作った Herdr のタブの id（「起動と表示」） | その `<name>` の manager だけ |
| `<state-dir>/drafts/<name>-<slug>.md` | 起票の下書き（起票後に manager が削除） | `intake-drafter` |

`<state-dir>/projects.json`（台帳）は manager の入力ではない。ダッシュボードが横断ビューのために読む（[dashboard.md](dashboard.md)「台帳」）。

段階 2 の台帳（`.claude/rules/dev-team.md`、ADR 0006）とは別物。こちらは端末の状態、あちらは「そのプロジェクトの運用規約」。

## 順方向: 要望 → 起票

状態: 実装済み

1. 話題を振り分ける。プロダクトの要望・不備・アイデアは cwd のリポジトリ。開発フロー・スキル・ルール・設定の改善は `<flow-repo>` へ迂回する（`<path>` と同じなら通常経路。未設定なら、どこで直すかを人に聞く）
2. [spec-intake](intake.md) の手順に従う。manager の SKILL.md は手順を複製せず「spec-intake に従う」とだけ書く
   - 委譲: 目的に合意した後のリポジトリの読解と実装方針案・受け入れ条件案、設計合意後の本文ファイルの下書きは background の subagent に出す。要件ヒアリング・壁打ち・合意・`gh issue create -R` は manager が行う
   - 迂回のときは spec-intake「対象プロジェクトの指定」に従い、`<flow-repo>` 起点の絶対パスで読む
3. 起票後、cwd のリポジトリに dev-loop が走っていなければ起動を**提案する**。勝手に起動しない。迂回で `<flow-repo>` に起票したときは、そちらの dev-loop はこの manager の管轄外なので起動を提案しない（`<flow-repo>` の manager か人が回す）

## 起動と表示

状態: 実装済み

この節の操作（稼働確認・起動・報告先通知・表示・`claude rm`）は**委譲しない**。いずれも 1 コマンドで終わり、人の承認と結びついているため manager が自分で行う。

起動前に `claude agents --json` を `<path>` の前方一致で絞り、稼働中のセッションを確認する。**1 リポジトリ 1 ループ**。

- `kind: background` があれば起動しない
- `kind: interactive` が同じ cwd にあれば、人がそこで dev-loop を手で回している可能性があるので、起動前に人に確認する。manager 自身の行（`pid` が `$PPID` と一致）は除く（「対象の識別」）。`claude agents --json` からは中で何が走っているか分からない

起動前の確認（別の Bash 呼び出しで先に打ち、結果を読んでから起動する）:

```bash
git fetch -q origin && git rev-list --count origin/main..main   # 数字の 0 が出たときだけ起動してよい
git log origin/main..main --oneline                             # 未 push の一覧を人に見せる
```

起動:

```bash
claude --bg "/dev-team:dev-loop"
```

- 起動前に origin/main との乖離を検知する。dev-loop はワークツリーを `origin/main` から切るため、ローカル main だけにあるファイルを Issue が参照していると初回で blocked になる（2026-09-06 に 30 件未 push のリポジトリで観測）。未 push が 1 件でもあれば起動せず、件数と一覧を人に伝えて `git push origin main` するかを聞く。push は人の判断。承認後なら manager が実行してよい。人が承知の上で起動を選べばそのまま起動してよい。コマンドが失敗した・数字が出ないときも起動しない（`| wc -l` は失敗時に `0` を出すので使わない）
- cwd が対象リポジトリなので `cd <path> &&` の前置は不要。ただし **1 回の Bash 呼び出しで `claude --bg` は 1 つ**
- 初期プロンプトのスラッシュコマンドは明示起動として扱われ、ADR 0009 の関門は開かない（事前検証で確認）
- 出力された短い id（例 `6b8a7d7a`）を控える。この id は `claude attach` / `logs` / `stop` / `rm` の引数
- 起動直後に SendMessage で「終了報告はこの送信元へ返信」と一言送る。dev-loop はこのメッセージの `from` を終了報告の宛先にする（[loop.md](loop.md)「manager への報告」）。`notify_when_idle: true` も付ける。idle 通知は届くが manager のターン中は待たされるので、終了報告が来なかったときの保険と位置づける
- 通知を送る前に、`claude --bg` が印字した id でパスで絞らずに `claude agents --json` を引き、`cwd` が `<path>` 配下（前方一致。dev-loop はワークツリーに入ると `<path>/.claude/worktrees/ticket-N` を報告するので等値で見ない）であることを確かめる。配下でなければ誤起動として片付け（下の「守ること」の例外）、起動し直す。結果が空なら数秒待って引き直し、空を理由に起動し直さない
- 宛先は `claude agents --json` の `pid` から組み立てた `uds:/tmp/cc-socks/<pid>.sock`。ListAgents 上の名前（起動直後は初期プロンプト文字列で同名になりうる）に頼らない

**表示**: `HERDR_ENV=1` なら、manager 自身が居る workspace に attach 用のタブを足す。1 workspace = そのリポジトリの manager + dev-loop になり、サイドバーを workspace 単位で並べていれば 1 行が 1 リポジトリに対応する（ADR 0013）。

- 自分の workspace は `herdr pane current` の `result.pane.workspace_id` で取る（状態ファイルから探さない）
- `herdr tab create --workspace <ws> --cwd <path> --label dev-loop --no-focus` でタブを作り、応答の `result.tab.tab_id` と `result.root_pane.pane_id` を取って `herdr pane run <pane> "claude attach <id>"` を実行する。人の焦点は動かさない
- 作ったタブの id を `<state-dir>/herdr/<name>.json`（`{"workspace_id": "<ws>", "tab_ids": ["<tab>", ...]}`）に記録する。1 manager 1 ファイルなので他の manager と書き込みが競合しない。記録するのは manager が作ったタブだけで、**タブの所有は id だけで判定する**（label・cwd で推測しない）
- workspace の作成・生存確認・label 照合・close は行わない
- 手順は [skills/manager/references/herdr.md](../../skills/manager/references/herdr.md) にある。Herdr 外では読まない
- Herdr 外では「別ペインで `claude attach <id>` を実行してください」と伝えるだけ。attach 中も `claude agents --json` は `kind: background` と状態を返し、ペインを閉じてもセッションは残る

**終了**: dev-loop からの終了報告（SendMessage）を受けたら、報告を要約して人に伝え（文頭は太字の案件名）、`claude rm <id>` で片付ける。報告が来ないまま `claude agents --json` で `state: idle` になっていれば、`claude logs` で確認する。

Herdr 内なら `claude rm` の後に、記録した `tab_ids` のうち**今の workspace の `herdr tab list --workspace <ws>` に存在するものだけ**を `herdr tab close` で閉じ、記録から消す。`herdr pane current` の `workspace_id` が記録の `workspace_id` と違えば（Herdr 再起動で id が振り直された等）、閉じずに記録だけ捨てる。記録に無いタブ（manager 自身のタブ・人が足したタブ）には触らない。

守ること:

- `working` のループを人に頼まれずに `stop` しない。例外は manager 自身の誤起動（cwd の取り違え）だけで、対象は「直前の `claude --bg` が印字した id」かつ `cwd` が `<path>` 配下に無いものに限る。直ちに `claude stop` → `claude rm` で片付ける。残骸は当該 cwd の dev-loop が次回の起動時チェックで回収する（[loop.md](loop.md)）。当該 cwd で既にループが走っていれば回収はその次回起動までかかるため、人に伝える
- `claude rm` は idle になり報告を読んだ後だけ（誤起動の片付けを除く）。ワークツリーの掃除は dev-loop 自身の回収（[loop.md](loop.md)「環境の回収」）に任せ、`rm` の「安全なら worktree も消す」に頼らない
- `claude logs` の出力は端末描画の生データ（ANSI 込み）で読みにくい。報告は SendMessage で受け取るのを正とし、`logs` は止まっている箇所の確認に限る

## 逆方向: 巡回と中継

状態: 実装済み

「状況は？」と聞かれたとき、および dev-loop からのメッセージを受けたときに、cwd のリポジトリについて次を集めて要約する。`/loop 15m` での定期巡回は任意。

- 委譲: 下表の「見るもの」の収集と `claude logs` の読みは 1 巡回 = 1 エージェント（`dev-team:patrol-collector`）に出し、要約・blocked の要点・manager-log に追記すべき行を返させる。渡すのは `<name>` / `<path>` / `<owner/repo>` の 1 件と manager-log の絶対パス。要約の提示・manager-log への追記・Issue コメントと `status:ready` への戻しは manager が行う

| 源 | 見るもの | manager がすること |
|---|---|---|
| `claude agents --json` | `<path>` 配下で `state: blocked` の background セッション | subagent が `claude logs` から読んだ止まっている箇所を、attach 先（Herdr なら自分の workspace の `dev-loop` タブ / `claude attach <id>`）を添えて伝える |
| `gh issue list -R -l status:blocked` | dev-loop からの設計判断待ち | 要点を出し、人の答えを Issue コメントに書いて `status:ready` に戻す（spec-intake の差し戻しに相当） |
| `gh pr list -R` | open PR | 一覧を示す。段階 3b 実装後は `awaiting-review` として扱う |

`status:ready` があるのに background が無ければ起動を提案し、`git fetch -q origin && git rev-list --count origin/main..main` で main が未 push ならその件数を 1 行添える。

複数リポジトリの横断ビューが要るときはダッシュボード（[dashboard.md](dashboard.md)）を案内する。**manager はダッシュボードを起動しない**（人が自分の端末で起動する）。

許可プロンプトへの代理入力は v1 ではしない。止まっている箇所を示し、人が attach して答える。dev-loop の経路に Ask ルールが残っていることは運用の欠陥であり、後述の改善ループで潰す。

## 改善ループ

状態: 実装済み

中継した割り込みを `<state-dir>/manager-log.jsonl` に 1 行ずつ追記する（追記のみ。`project` は `<name>`）。

```
{"ts":"<ISO 8601>","project":"<name>","kind":"permission|question|blocked","summary":"<1行>"}
```

同型（`kind` と `summary` の要旨が同じ）が 2 回以上出たら、または「改善案は？」と聞かれたら、根拠の行を添えて提案する。提案は人が承認するまで実施しない（ADR 0004）。実施先は 2 通り。

- 委譲: ログの読みと同型の集計、根拠の行を添えた提案文の作成は `dev-team:patrol-collector` の集計モードに出す。ログはグローバルなので、他のリポジトリの manager が記録した同型も集計に入る。提案の提示・承認待ち・承認後の編集または起票は manager が行う

| 変更対象 | 実施方法 |
|---|---|
| `~/.claude/settings.json`・hooks | 承認後にその場で編集する。設定を `<flow-repo>` で版管理しているなら、そちらで直してコミットする |
| CLAUDE.md・rules・スキル本文（SKILL.md） | `<flow-repo>` に Issue を起票し、`<flow-repo>` の dev-loop が消化。1 行の規約変更なら直接編集してコミットしてよい（cwd が `<flow-repo>` でなければ `git -C <flow-repo>` で行う）。`<flow-repo>` が未設定なら、どこで直すかを人に聞く |

典型的な改善は「dev-loop の経路に残る Ask / deny ルールの整理」である。たとえば `Bash(rm *)`・`Bash(mv *)` が Ask に残っていると、background の dev-loop はワークツリーの片付けで止まる。開発サーバーの停止は同梱の停止スクリプトの呼び出しだけを許可すればよく、生の `kill` を許可する必要は無い。

## 権限の前提条件

状態: 実装済み

background セッションは Ask ルールに当たった時点で答える人がおらず `blocked` のまま止まる。初回運転の前提として SKILL.md に次を書く。

- dev-loop の経路（git・gh・パッケージマネージャ・検証コマンド・ワークツリー内のファイル操作）に Ask ルールが無いこと
- 危険操作は deny（フックまたは settings の deny）で止める。「一回だけ Yes」は存在しない
- 権限モードは端末の設定を継承する。v1 で専用のモードは足さない

## 対象外（v1）

状態: 実装済み

- 許可プロンプトへの代理入力（Herdr の `agent send-keys` で可能だが、Ask ルールを減らす方が本筋）
- subagent による承認・起動・削除の代行（subagent は読み・集計・下書きに限る。ADR 0011）
- 同一リポジトリ内の並列（Agent Teams の領分。ROADMAP 未決事項）
- manager による横断ビュー（ダッシュボードの領分。ADR 0013）
