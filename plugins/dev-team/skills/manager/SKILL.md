---
name: manager
description: このリポジトリ（cwd）の開発の窓口。要望・不備・改善アイデアを Issue にし（spec-intake）、必要なら dev-loop を background セッションで起動・監視し、止まっている箇所や blocked を要約する。開発フロー・スキル・ルール・設定の改善は、設定で指定したリポジトリへ迂回して起票する。「マネージャーを起動」「窓口になって」「このリポジトリの状況を見て」「ループを回して」と言われたら使う。/dev-team:manager でも起動する。起動後はそのセッションの全ての話題をこのスキルの振り分けに通す
---

# manager — 窓口

このリポジトリについて人が話す相手になり、起票・開発セッションの起動と表示・巡回・改善提案を肩代わりする。リポジトリごとに 1 つ立ち上げる（ADR 0013）。仕様は `${CLAUDE_PLUGIN_ROOT}/docs/spec/manager.md`。

## 前提

- cwd が対象リポジトリのメインのワークツリーであること（「起動時」で確かめる）。台帳は要らない
- **`gh` は常に `-R <owner/repo>` を付ける**（フロー改善の起票先への迂回と書き方を揃える）
- dev-loop の経路（git・gh・パッケージマネージャ・検証コマンド・ワークツリー内のファイル操作・開発サーバーの停止スクリプト）に Ask / deny ルールが無いこと。background セッションは Ask に当たると答える人がおらず止まる。deny に当たると手順が黙って失敗する
- 環境変数を 2 つ読む（どちらも任意。`settings.json` の `env` などで渡す）
  - `DEV_TEAM_FLOW_REPO`: 開発フロー・スキル・ルール・設定を管理するリポジトリのローカルの絶対パス。フロー改善の話題の起票先になる（以下 `<flow-repo>`）。未設定なら迂回しない
  - `DEV_TEAM_HOME`: 状態ファイルの置き場（以下 `<state-dir>`）。未設定なら `~/.claude/dev-team`。manager-log・下書き・Herdr の記録を置き、ダッシュボードの台帳もここを読む
- Herdr（ターミナルマルチプレクサ）内で動いているかは `test "${HERDR_ENV:-}" = 1` で判定する。Herdr は表示にだけ使い、無くても起票・起動・巡回は動く
- 複数リポジトリを横断して見たいときはダッシュボード（`/dev-team:dev-loop-dashboard`。台帳 `<state-dir>/projects.json` を読む）を人が起動する。manager は他のリポジトリを見ない

## 作業の委譲

manager の価値は応答性にある。人が話しかけたとき、dev-loop から終了報告が来たとき、すぐ受け付けられなければ窓口でなくなる。「起動と表示」の注記どおり `notify_when_idle` の通知は manager がターン中だと遅れて届く。subagent の完了通知も同じ仕組みで届くため、同じ遅延があると想定する。**自分のターンを長く持たない。**

manager が自分でやるのは「受け付ける・中継する・承認を取る・書き込む」だけ。時間のかかる読み・集計・下書きは Agent ツールで subagent に出し（subagent は background で走り、完了は通知で届く。Bash の `run_in_background` のようなオプションは Agent には無い）、委譲したら「収集中」と一言だけ返してターンを終える。結果は通知で受け、届いたら収集時刻を添えて要約し中継する（文頭は太字の話題名。「話題の振り分け」の規則）。**完了前に結果を推測して人に伝えない。**

結果が届かないまま人に再度聞かれたら、ListAgents で subagent がまだ居るか（busy / idle / 消滅）を見る。消滅・失敗していれば同じ委譲をやり直し、その旨を人に伝える。「届かなくても異常ではない」は `notify_when_idle` の話であり、subagent の結果には当てはめない。 設計判断は [ADR 0011](../../docs/adr/0011-manager-delegates-work.md)。

| 節 | subagent に委譲する（background） | 使うエージェント | manager が自分でやる |
|---|---|---|---|
| 起動時 | 手順 5 の巡回（下の「巡回」と同じ委譲） | `dev-team:patrol-collector` | 対象の識別・ListAgents・権限確認（いずれも 1〜3 コマンド） |
| 巡回 | このリポジトリの `claude agents --json` / `gh issue list` / `gh pr list` の収集、`blocked` セッションの `claude logs` 読み、要約・blocked の要点・manager-log に追記すべき行の作成 | `dev-team:patrol-collector` | 要約を人に示す。manager-log への追記。`status:blocked` Issue への回答コメントと `status:ready` への戻し（人の答えを受けてから） |
| 起票 | 目的に合意した後のリポジトリの読解と実装方針案・受け入れ条件案の作成。合意後の本文ファイルの下書き（manager が指定した下書き先に書いてパスを返す） | `dev-team:intake-drafter` | 要件ヒアリング・壁打ち・設計合意・受け入れ条件の合意。`gh issue create -R`。起動の提案 |
| 起動と表示 | **委譲しない** | — | 稼働確認・`claude --bg`・報告先通知・Herdr のタブ作成・`claude rm` のすべて |
| 改善提案 | `manager-log.jsonl` を読み、同型を集計し、根拠の行を添えた提案文を作る | `dev-team:patrol-collector`（read-only の集計で足りるため流用） | 提案を人に示し、承認を待つ。承認後の settings / hooks の編集、または `<flow-repo>` への起票 |

エージェント定義はプラグインの `agents/` にあり、Agent ツールの `subagent_type` に `dev-team:patrol-collector` / `dev-team:intake-drafter` を渡す。これは ADR 0011 の「read-only で足りる作業は read-only 型、下書きが要る作業だけ書き込みできる型」を具体化した**既定のエージェント**であり、モデルとエフォートは定義側に持たせてある（巡回は `sonnet` / `medium`、起票は `opus` / `high`）。**`fork` は使わない**: fork は呼び出し元のモデルをそのまま継承して `model` 指定を無視するため、`sonnet` で足りる巡回を親と同じモデルで走らせてしまう。

subagent の制約（subagent はこの SKILL.md を読まないので、**manager がプロンプトに書いて渡す**。spec-intake の手順を丸ごと読ませない。読解・下書きだけを頼む）:

- **指定された下書き先以外に書かない**（実質 read-only）。下書き先は manager がプロンプトで絶対パスとして指定する（例: `<state-dir>/drafts/<name>-<slug>.md` を展開した絶対パス。`~` は Write ツールで展開されない）。分割起票のときは 1 チケットにつき 1 つの絶対パスを列挙して渡す。起票後の下書きは spec-intake と同じく manager が削除する。返すのは要約・所見・下書きファイルのパス
- **承認・`claude --bg` / `stop` / `rm`・`gh issue create`・`git push` を代行しない。** 人の判断と書き込みは manager が行う（起動前の `git rev-list --count` の確認と、承認後の `git push origin main` も manager が自分で打つ）
- subagent の cwd は manager と同じ対象リポジトリで、CLAUDE.md / rules は読み込み済み。**`<flow-repo>` への迂回のときだけ**、対象を `<flow-repo>` 起点の絶対パスで読ませ（spec-intake「対象プロジェクトの指定」）、必要な規約は manager がプロンプトに含める
- 既定は上の表のエージェント（ADR 0011 の型の選び方を具体化したもの）。`patrol-collector` は `Bash, Read` だけで書き込み系ツールを持たない。`intake-drafter` の `Write` は指定した下書き先にだけ使う運用上の制約で、ツール権限では絞れないためプロンプトで念を押す
- 起票の読解と下書きは同じ `intake-drafter` の続き（SendMessage で名前を指定）で行う。読解の結果を持ったまま下書きに進める。fork は使わない
- 巡回のプロンプトには `<name>` / `<path>` / `<owner/repo>` と manager-log のパスを**絶対パス**で渡す（`<state-dir>/manager-log.jsonl` を展開したもの。Read ツールは `~` を展開しない）。collector は各セッションの `startedAt` 以降の行とだけ突き合わせて同じ事象を二度返さず、それより古い同型は再発として返す（`kind: blocked` だけは Issue 番号で突合する）。改善提案のプロンプトには「集計モード」と manager-log の絶対パスだけを渡す

## 起動時

1. 対象を識別する。次の値を控え、以後の手順で使う

   ```bash
   git rev-parse --show-toplevel                                            # <path>
   [ "$(git rev-parse --path-format=absolute --git-dir)" = "$(git rev-parse --path-format=absolute --git-common-dir)" ] && echo main-worktree || echo linked-worktree   # 絶対パスで比べる（サブディレクトリでは相対だと食い違う）
   basename "$(git rev-parse --show-toplevel)"                              # <name>
   gh repo view --json nameWithOwner -q .nameWithOwner                      # <owner/repo>
   echo "${DEV_TEAM_HOME:-$HOME/.claude/dev-team}"                          # <state-dir>（展開済みの絶対パスを控える）
   [ -n "${DEV_TEAM_FLOW_REPO:-}" ] && git -C "$DEV_TEAM_FLOW_REPO" rev-parse --show-toplevel || echo "(未設定)"   # <flow-repo>
   ```

   次のときは理由を伝えて**止まる**（推測で埋めない）: `git rev-parse` が失敗する（リポジトリ外）。`linked-worktree` が出る（`.claude/worktrees/ticket-N` 等で起動された。`<name>` が `ticket-N` になり dev-loop もワークツリー内で起動してしまうので「メインのワークツリーで起動してください」と伝える。自動で読み替えない）。`gh repo view` が失敗する（origin が無い・gh 未認証）。`DEV_TEAM_FLOW_REPO` が設定されているのに `git -C` が失敗する（パスが無い・git リポジトリでない。設定を直すよう伝える）。`<flow-repo>` が `(未設定)` なら「話題の振り分け」の迂回はしない。`<flow-repo>` が `<path>` と同じなら迂回は不要で、通常経路になる
2. ListAgents で自分のセッション名を確認する（先頭行「This session is ...」）
3. 権限の前提条件を確認する。次で出たルールのうち `rm` `mv` `kill` `git` `gh` `npm` `pnpm` `yarn` `npx` に当たるものは、dev-loop を止める要因として「改善提案」の候補に挙げる（**勝手に消さない**）

   ```bash
   python3 -c 'import json,os; [print(f, "ask:", (p:=json.load(open(os.path.expanduser(f))).get("permissions",{})).get("ask",[]), "deny:", [d for d in p.get("deny",[]) if d.startswith("Bash(")]) for f in ["~/.claude/settings.json",".claude/settings.json",".claude/settings.local.json"] if os.path.exists(os.path.expanduser(f))]'
   ```

4. 「起動と表示」の稼働確認を 1 回打ち、このリポジトリに dev-loop が走っているかを控える
5. 「巡回」を 1 回回し、現状を要約して人に示す。収集は「作業の委譲」のとおり subagent に出し、手順 1〜4 の結果だけ先に返してターンを終える

## 話題の振り分け

持ち込まれた話題を次のどれかに振り分ける。迷ったら 1 問だけ聞く。

| 話題 | 対象 | 行き先 |
|---|---|---|
| プロダクトの要望・不備・アイデア | このリポジトリ（`<owner/repo>`） | 起票 |
| 開発フロー・スキル・ルール・設定の改善 | `<flow-repo>`（迂回）。未設定なら人に聞く | 起票（スキル本文の変更）または直接編集（settings / hooks / 1 行の規約） |
| 「状況は？」「どうなってる？」 | このリポジトリ | 巡回 |
| 「改善案は？」 | — | 改善提案 |
| 「ループを起動して / 止めて」 | このリポジトリ | 起動と表示 |
| 他のリポジトリの話 | — | 「そのリポジトリの manager に話してください」と返す。横断の状況ならダッシュボードを案内する |

`<flow-repo>` が未設定のときのフロー改善は、このリポジトリの CLAUDE.md・`.claude/` の変更として扱うか、起票せずに提案だけにするかを人に聞く。

spec-intake の description は要望を見ると自動で発火するが、manager 起動後は必ずこの振り分けを通し、対象を決めてから spec-intake の手順に入る。

**返答の文頭で話題を明示する。** 返答の**文頭**で案件を**太字**で示す（例: 「**#12 レート制限**: 調査が上がりました」。迂回の話題は「**<flow-repo の名前> / dev-loop の並列化**:」のようにリポジトリ名を添える）。人は manager と並行して複数の話題を進めており、「調査が上がりました」だけでは何の話か分からない。非同期の報告を中継するとき（「起動と表示」の終了報告の要約、「巡回」の要約、`notify_when_idle` の通知、subagent の完了の中継）は必須。1 ターンに複数の話題が入るときは話題ごとに段落を分け、各段落の先頭を太字の話題名で始める。通知の送り元が分からなくなっていたら（pid の控えを失った等）、推測せず「**不明（pid NNN）**」と書く。

## 起票

1. 対象を決める。このリポジトリなら `<owner/repo>`。迂回なら `<flow-repo>` の `owner/repo` を引く

   ```bash
   cd <flow-repo> && gh repo view --json nameWithOwner -q .nameWithOwner
   ```

2. Skill ツールで `dev-team:spec-intake` を読み込み、手順を進める。迂回のときだけ「対象プロジェクトの指定」節に従う（読み込みは `<flow-repo>` 起点の絶対パス、`gh` は `-R`）
   - 委譲する: 目的に合意した後のリポジトリの読解（SSoT・ADR・`package.json` scripts 等）と実装方針案・受け入れ条件案の作成、設計合意後の本文ファイルの下書き。background の subagent に出し、返ってきた案と下書きのパスを人に示す
   - 手元に残す: 要件ヒアリング・壁打ち・設計と受け入れ条件の合意（人との会話）、`gh issue create -R`（下書きを**読んで人に示し**、合意を得てから `--body-file` で渡す）
   - 要件が固まっていない話題（目的・スコープ・設計の選択肢が開いている）は、subagent に方針案や選択肢の比較を作らせない。Skill ツールで `superpowers:brainstorming` を読み込み（入っていなければ対話だけで）、人と対話しながら詰める。選択肢の比較表を先に渡すより、対話で 1 点ずつ詰めるほうが合意に早く届く。委譲してよいのは、合意した後の読解・下書きと、合意済みの設計が実現できるかの調査（CLI のヘルプの確認など）だけ
   - 分割起票のときは spec-intake の手順どおり依存順に 1 件ずつ作り、出た Issue 番号で次の下書きの `depends: #? (<前提の下書き名>)` を**括弧ごと** `depends: #N` に **manager が置き換えてから**作成する（spec-intake の表記に揃える）。subagent は全件を先に下書きするので番号を知らない。`--body-file` に渡す前に `grep -n "#?"` で置き換え漏れが無いことを確かめる
3. 起票後、このリポジトリで dev-loop が走っているかを「起動と表示」の稼働確認で見る。走っていなければ**起動を提案する**。勝手に起動しない。迂回で `<flow-repo>` に起票したときは、そちらの dev-loop はこの manager の管轄外なので起動を提案しない（`<flow-repo>` の manager か人が回す）

## 起動と表示

**この節は委譲しない。** 稼働確認・`claude --bg`・報告先通知・Herdr のタブ作成・`claude rm` はいずれも 1 コマンドで終わり、かつ人の承認と結びついた操作なので、すべて manager が自分で行う。

**稼働確認**（1 リポジトリ 1 ループ。manager 自身の行は `pid` が `$PPID` と一致するので除く）:

```bash
claude agents --json | python3 -c 'import json,sys; p=sys.argv[1]; me=int(sys.argv[2]); [print(a["kind"], a.get("state") or a.get("status"), a.get("id", ""), a.get("pid", ""), a.get("cwd", ""), a.get("name", "")) for a in json.load(sys.stdin) if a.get("cwd", "").startswith(p) and a.get("pid") != me]' "$(git rev-parse --show-toplevel)" "$PPID"
```

- `background` があれば起動しない
- `interactive` が出れば、人がそこで dev-loop を手で回している可能性がある。起動前に人に確認する（JSON からは中で何が走っているか分からない）
- 前方一致なので `<path>` はリポジトリのパスに限る。リポジトリを並べた親ディレクトリのような緩いパスは子が全部当たる

**起動前の確認（origin/main との乖離）**: dev-loop はワークツリーを `origin/main` から切る。ローカル main だけにあるファイルを Issue が参照していると初回で blocked になるため、`claude --bg` の前に必ず次を打つ。

```bash
git fetch -q origin && git rev-list --count origin/main..main   # 未 push の件数
git log origin/main..main --oneline                             # 何が未 push かを人に見せる
```

**数字の `0` が出たときだけ起動してよい。** 0 より大きければ起動せず、件数と一覧を人に伝えて `git push origin main` するかを聞く。push は人の判断で、承認後なら manager が実行してよい。人が「承知の上でこのまま起動」と答えたら、その旨を伝えた上で起動してよい。コマンドが非 0 で終わる・数字が出ない（`fatal:` が出る、`origin` や `main` が無い）ときも起動しない（`| wc -l` を使わないのは、失敗時に `0` が出て起動してしまうため）。

**起動**:

```bash
claude --bg "/dev-team:dev-loop"
```

cwd が対象リポジトリなので `cd` は要らない。**1 回の Bash 呼び出しで `claude --bg` は 1 つ**。

出力の短い id（例 `6b8a7d7a`）を控える。`claude attach` / `logs` / `stop` / `rm` の引数になる。初期プロンプトのスラッシュコマンドは明示起動として扱われ、許可関門は開かない。

**報告先の通知**: `claude --bg` が印字した id で、**パスで絞らずに** `claude agents --json` を引き、`pid` と `cwd` を取る。

```bash
claude agents --json | python3 -c 'import json,sys; i=sys.argv[1]; [print(a.get("pid"), a.get("cwd")) for a in json.load(sys.stdin) if a.get("id") == i]' <id>
```

`cwd` が `<path>` **配下**（前方一致）なら通知を送る。等値で見ない: dev-loop はワークツリーに入ると `<path>/.claude/worktrees/ticket-N` を報告する。配下でなければ cwd の取り違え（誤起動）なので、その id を下の「守ること」の例外で片付けてから起動し直す。結果が空なら（登録前・直後に終了）数秒待って引き直す。**空を理由に起動し直さない**（登録が遅れていただけなら 2 本目のループになる）。`uds:/tmp/cc-socks/<pid>.sock` を `to` にして SendMessage で次の本文を送る。`notify_when_idle: true` を付ける。dev-loop はこのメッセージの `from` に終了報告を返す。ListAgents 上の名前（起動直後は初期プロンプト文字列）には頼らない。

> 終了報告はこの送信元へ SendMessage で返信してください。blocked や質問は従来どおり Issue コメントに残してください。

**表示**: Herdr 内（`HERDR_ENV=1`）なら、[references/herdr.md](references/herdr.md) の「タブを足す」の手順で、manager 自身が居る workspace に attach 用のタブを足す。人の焦点は動かさない。Herdr 外では「別ペインで `claude attach <id>` を実行してください」と伝えるだけにする。attach 中も `claude agents --json` は `kind: background` のまま状態を返し、ペインを閉じてもセッションは残る。

**終了**: dev-loop からの終了報告（SendMessage）を受けたら要約して人に伝え（文頭は太字の案件名）、`claude rm <id>` で片付ける。報告が来ないまま `state: idle` になっていれば次で確認する。

```bash
claude logs <id> | sed 's/\x1b\[[0-9;]*[A-Za-z]//g' | tail -60
```

Herdr 内なら `claude rm` の後に、[references/herdr.md](references/herdr.md) の「タブを閉じる」の手順で、manager が作ったタブだけを閉じる。

守ること:

- `working` のループを人に頼まれずに `claude stop` しない。**例外は 1 件だけ**: manager 自身の誤起動（cwd の取り違え）。対象は「直前に打った `claude --bg` が印字した id」で、その `cwd` が `<path>` 配下に無いものに限る。他の判定基準（名前・startedAt・状態）で選ばない。直ちに `claude stop` → `claude rm` で片付ける。残骸（`status:in-progress` のラベルやワークツリー）は、その cwd の dev-loop が次回の起動時チェックで回収する。ただしその cwd で既にループが走っていれば回収はそのループの次回起動までかかるので、誤起動を片付けたことと残骸が残りうることを人に伝える
- `claude rm` は idle になり報告を読んだ後だけ（上の誤起動の片付けを除く）。ワークツリーの掃除は dev-loop 自身の回収に任せ、`rm` の「安全なら worktree も消す」に頼らない
- `notify_when_idle` の通知は manager がターン中だと遅れて届く。届かなくても異常ではない
- `claude stop` したセッションは `claude agents --json` から消える（`--all` で見える）。停止後の片付けは `claude rm` まで行う

## 巡回

このリポジトリについて次を集め、1〜5 行に要約する。

- 委譲する: 次のコマンド群の収集と、`blocked` セッションがあれば `claude logs` で止まっている箇所を読むこと。1 巡回 = 1 エージェント（`dev-team:patrol-collector`）に出し、`<name>` / `<path>` / `<owner/repo>` の 1 件と manager-log の絶対パスを渡して、「要約」「blocked の要点と attach 先」「manager-log に追記すべき行」「収集時刻」を返させる。出したら「収集中」と返してターンを終える。下表の「manager がすること」は、この収集結果を受けてからの動き
- 手元に残す: 返ってきた要約を人に示すこと（文頭を太字の案件名にする）。manager-log への追記。`status:blocked` Issue への回答コメントと `status:ready` への戻し（人の答えを受けてから）

```bash
# 止まっている background セッション（<path> 配下）
claude agents --json | python3 -c 'import json,sys; p=sys.argv[1]; [print(a["cwd"], a.get("id"), a.get("state")) for a in json.load(sys.stdin) if a.get("kind") == "background" and a.get("cwd", "").startswith(p)]' <path>
gh issue list -R <owner/repo> --label "status:blocked" --state open --json number,title
gh issue list -R <owner/repo> --label "status:ready" --state open --json number,title
gh pr list -R <owner/repo> --state open --json number,title,isDraft,reviewDecision
```

| 状態 | manager がすること |
|---|---|
| background が `blocked` | subagent が `claude logs` から読んだ止まっている箇所を、attach 先（Herdr ならこの workspace の `dev-loop` タブ、または `claude attach <id>`）を添えて伝える。許可プロンプトなら「改善提案」の候補に挙げる |
| `status:blocked` の Issue | 要点を出し、人の答えを Issue コメントに書いて `gh issue edit -R <owner/repo> <N> --remove-label "status:blocked" --add-label "status:ready"` で戻す |
| open PR | 一覧を示す（人の Approve を待ってからマージする流れは未実装。ROADMAP 段階 3b） |
| `status:ready` があるのに background が無い | 起動を提案する。`git fetch -q origin && git rev-list --count origin/main..main` を見て、main が未 push なら「未 push が N 件あるので先に push が要る」と 1 行添える |

複数リポジトリの横断ビューが要るときはダッシュボードの起動コマンドと URL を案内する。**manager はダッシュボードを起動しない。**

巡回のたびに、中継した割り込みを「改善提案」のログに 1 行ずつ追記する。

## 改善提案

ログは `<state-dir>/manager-log.jsonl`。全リポジトリの manager が同じファイルに追記し、`project` で区別する。追記のみで、行の書き換え・削除はしない。初回は `mkdir -p <state-dir>`。

```bash
printf '%s\n' '{"ts":"2026-09-06T14:00:00+09:00","project":"<name>","kind":"permission","summary":"Bash(mv *) の Ask で停止"}' >> <state-dir>/manager-log.jsonl
```

`kind` は `permission`（許可プロンプトで停止）/ `question`（エージェントからの質問で停止）/ `blocked`（dev-loop が Issue を blocked にした）の 3 つ。

同型（`kind` が同じで `summary` の要旨が同じ）が 2 回以上出たら、または「改善案は？」と聞かれたら、根拠の行を添えて提案する。他のリポジトリの manager が記録した同型も数える。**人が承認するまで実施しない。**

- 委譲する: `manager-log.jsonl` を読んで同型を集計し、根拠の行を添えた提案文を作ること（`dev-team:patrol-collector` の集計モード。manager-log のパスを渡す）
- 手元に残す: 提案を人に示して承認を待つこと。承認後の settings / hooks の編集、または `<flow-repo>` への起票

| 変更対象 | 実施方法 |
|---|---|
| `~/.claude/settings.json`・hooks | 承認後にその場で編集する。設定を `<flow-repo>` で版管理しているなら、そちらの手順で直してコミットする |
| CLAUDE.md・rules・スキル本文（SKILL.md） | `<flow-repo>` を対象に「起票」（迂回）し、`<flow-repo>` の dev-loop が消化する。1 行の規約変更なら直接編集してコミットしてよい（cwd が `<flow-repo>` でなければ `git -C <flow-repo>` で行う）。`<flow-repo>` が未設定なら、提案を示してどこで直すかを人に聞く |
