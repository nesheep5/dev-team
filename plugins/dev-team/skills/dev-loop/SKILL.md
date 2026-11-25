---
name: dev-loop
description: status:ready の GitHub Issue を全件、ワークツリー実装 → PR → レビュー → 自動マージまで自律的に連続処理する。単一 Issue の名指し（「#N を実装して」）には使わない。「チケットを消化して」「溜まっている Issue を進めて」「ready を上から実装して」のような複数チケットの一括処理で使う。/dev-team:dev-loop でも起動する
---

# dev-loop — チケット駆動の自律開発ループ

`status:ready` の Issue を1件ずつ「ワークツリーで実装 → PR → レビュー反復 → 自動マージ」で処理し、尽きたら結果を一括報告する。

## 前提

- GitHub リポジトリで `gh` CLI が認証済みであること
- Issue は spec-intake の形式（目的 / 設計 / 受け入れ条件 / 補足）で書かれ、`status:ready` / `status:in-progress` / `status:blocked` / `priority:high` のラベル運用がされていること
- 以下で「検証コマンド」とは、プロジェクトのテスト・lint・build を指す。package.json の scripts・Makefile・CI 設定等から特定し、存在しない種別はスキップする（例: npm プロジェクトなら `npm test` / `npm run lint` / `npm run build`）
- 以下で `main` はリポジトリのデフォルトブランチに読み替える
- ワークツリーは `.claude/worktrees/ticket-<N>` に作る。`.claude/worktrees/` と `.claude/dev-loop/` が .gitignore に無ければ最初に追記する（後述の開発サーバーのログ・記録も `.claude/dev-loop/` 配下に置くので、この2行で足りる。この追記はチケット外の変更なので、最初に処理する PR に含めてよい）。**`.claude/dev-team-log/` は gitignore しない**（累積ログはコミットして残す。後述）

## 不変ルール

- main へ直接コミットしない。変更は必ず PR 経由
- チケット PR のマージは squash に固定する（1チケット = main 上の1コミット）
- レビュー反復は1チケットにつき最大3回。超えたら blocked にして次へ進む
- 実装で解決できない問題（設計の矛盾・依存の不足・検証不能な受け入れ条件）は粘らず blocked にする
- 同時に着手するチケットは常に1件のみ

## ダッシュボード連携（イベント書き出し）

処理の節目で `.claude/dev-loop/events.jsonl` に1行 JSON を追記する。dev-loop-dashboard スキルがこれを読んで稼働状況を可視化する。初回はディレクトリを作る（`mkdir -p .claude/dev-loop`）。追記はメインリポジトリのルート基準のパスで行う（ワークツリー内からは `git rev-parse --git-common-dir` の親がメインリポジトリ）。

イベントの形式（1行に1 JSON）:

    {"ts":"<ISO 8601>","agent":"main","ticket":<Issue番号|null>,"event":"stage|log|loop","stage":"<工程>","detail":{...}}

追記コマンドの例:

    printf '%s\n' '{"ts":"2026-08-14T10:00:00+09:00","agent":"main","ticket":29,"event":"stage","stage":"implementing"}' >> .claude/dev-loop/events.jsonl

書き出しポイント（各手順の実行と同時に追記する）:

| タイミング | イベント |
|---|---|
| ループ開始（起動時チェックの完了後） | `event:"loop"`, `detail:{"action":"start"}`, `ticket:null` |
| チケット選択（1チケットの処理・手順1） | `stage:"selected"` |
| 実装開始(手順3) | `stage:"implementing"` |
| 検証コマンド実行（手順4） | `stage:"verifying"` |
| PR 作成（手順5） | `stage:"pr-created"`, `detail:{"pr":<PR番号>}` |
| レビュー反復の各回開始（手順6） | `stage:"review"`, `detail:{"iteration":<n>,"reviewers":["code-reviewer","pr-test-analyzer","silent-failure-hunter"]}` |
| レビュー指摘の修正開始（手順6） | `stage:"fixing"` |
| マージ処理開始（手順7） | `stage:"merging"` |
| マージ完了（手順7-7の後） | `stage:"merged"` |
| blocked 処理 | `stage:"blocked"`, `detail:{"reason":"<要約>"}` |
| 依存待ちスキップ（チケット選択・手順3） | `stage:"skipped"`, `detail:{"reason":"依存 #N 待ち"}` |
| 特記事項（レビュー指摘件数・コンフリクト等） | `event:"log"`, `detail:{"text":"<内容>"}` |
| ループ終了（終了報告の直前） | `event:"loop"`, `detail:{"action":"end"}`, `ticket:null` |

`agent` は直列運転では `"main"` 固定。並列 Workflow で運転する場合は、Workflow スクリプトが各エージェントのプロンプトにこの追記手順を含め、`agent` にエージェントのラベル（例 `"ticket-10"`）を書かせること。

イベント書き出しの失敗（権限・ディスク等）でチケット処理を止めない。追記できない場合は黙ってスキップしてよい。

## 累積ログ（review-log / friction-log）

events.jsonl が「今どこにいるか」の揮発データなのに対し、こちらは**計測と振り返りのために端末をまたいで残す累積データ**である。置き場は `.claude/dev-team-log/` で、**gitignore せずコミットする**（消えると数か月分の振り返り材料が失われるため）。初回は `mkdir -p .claude/dev-team-log` する。events.jsonl と同じくメインリポジトリのルート基準で追記する。

追記の失敗でチケット処理を止めないのは events.jsonl と同じ。

### review-log.jsonl — レビュー指摘の記録

レビュー反復（手順6）で指摘を処理するたびに、**採否にかかわらず全件**1行ずつ追記する。却下した指摘こそ「自動レビューが何を過剰に言うか」の情報になるため、`action:"rejected"` も残す。

    {"ts":"<ISO 8601>","ticket":<N>,"pr":<M>,"iteration":<k>,
     "source":"subagent:code-reviewer|subagent:pr-test-analyzer|subagent:silent-failure-hunter|human:<login>|ci",
     "severity":"high|low","category":"bug|test|error-handling|spec-mismatch|style",
     "file":"<パス>","summary":"<1行>","action":"fixed|rejected|deferred","reason":"<却下・保留の理由>"}

`human:*` の行が「自動レビューをすり抜けた指摘」であり、フィードバックループの主入力になる。人の指摘を記録する機会は現状マージ後のレビューコメントに限られるが、気づいた時点で記録する。

### friction-log.jsonl — 手順の不備の記録

**この SKILL.md 自身の欠陥を記録する。** review-log がプロダクトのコードの問題を記録するのに対し、こちらは指示の問題を記録する。両者を混ぜると信号が薄まる（レビュアーがプロダクトのバグを見つけたことは、この手順書の質を何も語らない）。

    {"ts":"<ISO 8601>","ticket":<N>,"skill":"dev-loop","step":"<下表の ID>",
     "kind":"ambiguous|undefined|contradicted|human-intervened|retry",
     "what":"<何に詰まったか>","resolved":"<どう解決したか>","cost":{"iterations":<n>}}

**書くタイミングは詰まった瞬間**である。チケット完了時にまとめて振り返ると記憶からの再構成になり、「手順がもう少し明確だとよい」のような一般論に流れる。欲しいのは具体的な躓きなので、気づいたその場で1行書いてから作業に戻る。

`kind` の意味:

| kind | 意味 |
|---|---|
| `ambiguous` | 手順に複数の解釈があり、どちらか選ぶ必要があった |
| `undefined` | 手順に書かれていない判断をした |
| `contradicted` | 手順どおりにやると別の手順と矛盾した |
| `human-intervened` | 人が口を出して初めて進めた |
| `retry` | 同じ工程を想定外に繰り返した |

`step` は**この SKILL.md の節を指す安定 ID** である。自由記述にすると集計できないため、必ず下表から選ぶ。当てはまるものが無ければ最も近いものを選び、`what` に補足する。

| step | 対応する節 |
|---|---|
| `startup-gate` | 起動関門 |
| `startup-recovery` | 起動時チェック |
| `server-cleanup` | 開発サーバーの管理 / 掃除 |
| `worktree-cleanup` | ワークツリーの管理 / 掃除 |
| `ticket-selection` | チケット選択 |
| `deps-install` | 1チケットの処理・手順3（依存インストール） |
| `implementation` | 1チケットの処理・手順3（TDD 実装） |
| `verification` | 1チケットの処理・手順4（検証コマンド） |
| `pr-creation` | 1チケットの処理・手順5（PR 作成） |
| `review-arbitration` | 1チケットの処理・手順6（指摘の統合・裁定） |
| `merge-cleanup` | 1チケットの処理・手順7（マージと後片付け） |
| `blocked-decision` | blocked 処理（blocked にするかの判断） |
| `final-report` | 終了報告 |

**書き漏らしを責めない。** 自己申告は必ず漏れる。漏れは blocked コメントと `human:*` の指摘で裏を取る前提にしている（集計して改善案にする dev-retro は未実装）。完璧に書こうとして作業が止まるほうが害である。

## 開発サーバーの管理

実装や動作確認のためにワークツリーで開発サーバー（`npm run dev` 等）を起動することがある。開発サーバーは起動したセッションが死んでも生き残るため、後片付けを怠ると孤児プロセスとして無期限に残り続ける。**起動したサーバーは必ずこの節の手順で落とす。**

### 起動

- ポートは `3000 + Issue番号`（例: #73 なら 3073）。使用中なら `3100 + N`、それも埋まっていれば空きを探す
- 必ずバックグラウンドで起動し、ログはワークツリー外の `.claude/dev-loop/logs/ticket-<N>.log` に落とす。スリープ復帰後にサーバーが壊れていた場合、原因を後から追えるようにするため
- `.claude/dev-loop/servers/ticket-<N>.json` に `{"ticket":<N>,"port":<port>,"worktree":"<パス>","started":"<ISO 8601>"}` を記録する。これは**停止の機構ではなく**、終了報告で人に再開コマンドを提示するための情報。書けなくてもループを止めない

### 停止（1チケット分）

**記録ファイルを信頼の起点にしてはいけない。** 記録された PID や PGID は、再起動やプロセスの入れ替わりで無関係なプロセスに再利用されている可能性がある。信頼できるのは生きているプロセスの作業ディレクトリ（cwd）だけである。

    PORT=<該当ポート>                       # 記録が無ければ 3000+N, 3100+N を順に試す
    PID=$(lsof -ti :$PORT | head -1)
    # PID が空 = 既に停止済み。記録ファイルを消して終了
    lsof -a -p $PID -d cwd -Fn | sed -n 's/^n//p'
    # cwd が対象ワークツリーと一致しなければ**絶対に止めない**（無関係なプロセスの誤射防止）

一致したら、停止はこのスキルに同梱した停止スクリプトで行う。`--root` にはメインリポジトリの `.claude/worktrees` を絶対パスで渡す（メインリポジトリのルートは `dirname "$(git rev-parse --path-format=absolute --git-common-dir)"`。ワークツリー内からでも同じ値になる）。**`&&` やパイプで他のコマンドと連結せず、単独の Bash 呼び出しにする**（許可ルールは前方一致なので、連結すると許可ルールから外れ、background では許可待ちで止まる）。

    bash ${CLAUDE_SKILL_DIR}/scripts/stop-dev-server.sh --root <メインリポジトリ>/.claude/worktrees --port <PORT>

スクリプトは LISTEN している pid のプロセスグループ全体を検査し、TERM → 5 秒後に KILL で落とす（`npm run dev` は「npm → next ラッパー → next-server → ビルドワーカー」の木を作るため、PID 単体では取りこぼす）。グループ内のどれか 1 つでも cwd が `--root` の外にある、LISTEN しているプロセスが無い、シェルや claude 本体などの保護対象に当たる、のいずれかなら何も止めずに 2 で終わる。終了コードで分岐する。

| 終了コード | 意味 | 次にやること |
|---|---|---|
| 0 | 停止した、または対象なし（冪等） | 記録ファイルを削除する |
| 2 | 安全条件で拒否、または KILL 後も残った | 別の手段で止めない。ポートとスクリプトの出力を終了報告の「人への依頼」に載せ、ループは続ける |
| 64 | 引数エラー | 引数を直して再実行する |

生の `kill` / `pkill` / `killall` は使わない（上の検査を経ずに、無関係なプロセスを落としうる）。

生死判定に HTTP 応答を使ってはならない。スリープ復帰後のサーバーはプロセスが生きたままエラーを返すことがあり、応答が壊れていることと停止していることは別である。

### 掃除（孤児の一括回収）

ネットワーク切断・スリープ・セッション死・再起動のいずれで中断しても回収できるよう、記録ファイルに依存せずシステム状態だけから孤児を発見する。

    ROOT=$(dirname "$(git rev-parse --path-format=absolute --git-common-dir)")
    for pid in $(lsof -nP -iTCP -sTCP:LISTEN -t | sort -u); do
      cwd=$(lsof -a -p $pid -d cwd -Fn 2>/dev/null | sed -n 's/^n//p')
      case "$cwd" in
        "$ROOT"/.claude/worktrees/*) echo "$pid $(ps -o pgid= -p $pid | tr -d ' ') $cwd" ;;
      esac
    done

cwd がこのリポジトリの `.claude/worktrees/` 配下にあることが dev-loop 由来である証明になる（他のリポジトリのワークツリーで動くサーバーは対象にしない）。列挙されたもののうち**現在 open な `status:in-progress` チケットのワークツリーに対応するもの以外**を孤児とみなし、停止スクリプトに `--root <メインリポジトリ>/.claude/worktrees` と `--pgid <PGID>` を渡して落とす（複数あれば `--pgid` を並べて 1 回で渡せる。これも単独の Bash 呼び出しにする）。

## ワークツリーの管理

ワークツリーは開発サーバーと同じく、後片付けが飛ぶと残り続ける。しかもサーバーと違ってプロセスが無いので、放置しても何も気づかせてくれない。実運用では **11 個**が git 管理外のまま滞留した実績がある（大半は `.next` だけを抱えた残骸で容量は小さかったが、`node_modules` を持ったまま残れば 1 件で数百 MB になる）。**掃除はサーバーと同じく起動時と終了前に必ず回す。**

### 掃除（孤児の一括回収）

`git worktree remove` を経ずにディレクトリだけ残ったものが孤児である。判定は記録ファイルではなく **`git worktree list` との差分**で行う。git が知らないディレクトリが `.claude/worktrees/` にあれば、それは remove が完了しなかった残骸である。

    git worktree prune                       # まず git 側の管理情報を掃除する
    known=$(git worktree list --porcelain | sed -n 's|^worktree ||p')
    for d in .claude/worktrees/*/; do
      [ -d "$d" ] || continue
      d=${d%/}
      printf '%s\n' "$known" | grep -qxF "$(cd "$d" && pwd)" || echo "孤児: $d"
    done

**削除前に、次の2点を必ず確認する。**

1. **対応する Issue が closed であること** — ディレクトリ名 `ticket-<N>` から `gh issue view <N> --json state` で確認する。open なら再開の余地があるので消さない
2. **未コミットの変更が無いこと** — git が既に管理外にしているため `git status` では見えない。`ls -A` してビルド生成物（`.next` / `node_modules` / `dist`）以外のファイルが無いことを見る。ソースが残っていれば、それは人が判断すべき作業の痕跡である

両方を満たしたものだけを削除する。片方でも怪しければ**消さずに終了報告へ回し、人に委ねる**。ディスクを空けることより、作業を失わないことが優先である。

なお、この掃除では**開発サーバーを先に止める**（サーバーが `.next` を掴んでいると削除に失敗する）。順序は「サーバー停止 → worktree 削除」で固定する。

## 起動関門

対話セッションで、ユーザーが dev-loop を名指しせずに依頼した結果このスキルが選ばれた場合は、`gh issue list --label "status:ready" --state open` の件数と先頭数件のタイトルを示し、ループを始めてよいか確認してターンを終える。ループは全件を自動マージまで進めるため、誤起動の代償が大きい。

確認せずに始めてよいのは、`/dev-team:dev-loop` での明示起動と、サブエージェント・Workflow・`claude -p` など回答者のいない実行。確認は起動時チェックより前に行う（起動時チェックはラベル付け替え・ワークツリー削除の副作用を持つ）。

## 起動時チェック

前回のループはネットワーク切断・スリープ・セッション死など、後片付けを一切実行できない形で終わっている可能性がある。その場合ここが**次に走る唯一のコード**なので、まず環境の回収から始める。

1. 「開発サーバーの管理 / 掃除」の手順で孤児サーバーを回収する。この時点ではまだどのチケットが継続中か判明していないため、**列挙だけ行って停止は保留し**、手順2で `status:in-progress` が確定した後に、継続対象のワークツリーに対応するもの以外を停止する。回収した孤児のポートと件数は終了報告に載せるため記録しておく
2. `gh issue list --label "status:in-progress" --state open` で前回の残骸を確認する。あれば、ブランチ `ticket/<N>-*` とそのワークツリー（`git worktree list` で探す。過去の運用で `.claude/worktrees/` 以外に作られていることもある）を対象に、次の観測可能な条件を**上から順に**判定する（複数成立時は先に成立したものを優先）
   - **PR が存在する** → `gh pr view <PR> --json state` でさらに分岐する
     - `OPEN` → レビュー反復（手順6）から再開する。反復回数は PR 上の修正コミット履歴等から復元できなければ、保守的に**残り1回とみなす**
     - `MERGED` → 後片付けの残り（開発サーバーの停止・`git worktree remove`・Issue closed 確認・`status:in-progress` ラベル外し）だけ行い次のチケットへ進む
     - `CLOSED`（未マージ） → blocked 処理を行う
   - **PR は無いがブランチに commit がある**（`git log main..ticket/<N>-*` が非空）→ 手順4（検証コマンド）から再開する
   - **commit が無く、作業ツリーに未コミットの変更がある**（ワークツリーでの `git status --short` が非空）→ 途中状態の意図が復元できないため blocked にする。このとき未コミットの変更は**捨てずに残す**（ワークツリーごと残し、Issue コメントに `git status` の要約を貼って人が判断できるようにする）。ワークツリーは残すが**開発サーバーは停止する**
   - **commit も変更も無い** → 実質未着手。開発サーバーを停止してからワークツリーを削除し、ラベルを `status:ready` に戻して通常のチケット選択へ合流する
3. 手順2で継続対象が確定したので、「ワークツリーの管理 / 掃除」の手順で孤児ワークツリーを回収する。継続対象（`status:in-progress` で再開するもの・blocked で残すもの）は対象外。削除した件数と、判断を保留して人に委ねるものを終了報告のために記録しておく
4. `git fetch origin main` で main を最新化する

## チケット選択

1. `gh issue list --label "status:ready" --state open --json number,title,labels,body` で候補を取得する
2. `priority:high` を先に、同順位は Issue 番号の昇順に並べる
3. 本文の「補足」にある `depends: #N` を確認する。依存先が **closed でない**チケットはスキップする。`gh issue view <N> --json state,labels` で判定し、依存先が `status:blocked` の場合はこのチケットも当面着手不能なので、スキップ理由を「依存先が blocked」として記録する（終了報告の「スキップ」欄に、待っている依存先とその状態を書く）
4. 候補がゼロになったら終了報告へ進む。ただし「status:ready は存在するが全件が依存待ちでスキップされた」場合は、単なる完了ではなく**依存チェーンが詰まっている**状態なので、終了報告でその旨と先頭の依存先（ボトルネックになっている Issue 番号）を明示する

## 1チケットの処理

1. `gh issue edit <N> --remove-label "status:ready" --add-label "status:in-progress"`
2. ワークツリーを作成する: `git worktree add .claude/worktrees/ticket-<N> -b ticket/<N>-<slug> origin/main`（slug はチケット内容の英語 kebab-case）。以降の作業はすべてこのワークツリー内で行う
3. 新規ワークツリーには依存物（node_modules 等）が無いため、まずプロジェクトのパッケージマネージャで依存をインストールする（lockfile から判断する）。その後 Issue の設計欄（参照先ドキュメントを含む）を読み、TDD で実装する。コミットは1目的1コミット、メッセージは日本語
4. 検証コマンドを全通過させる
5. push して PR を作成する。本文には受け入れ条件ごとの充足状況チェックリストと `Closes #<N>` を書く
6. レビュー反復（最大3回）:
   - Agent ツールで pr-review-toolkit の code-reviewer / pr-test-analyzer / silent-failure-hunter の3エージェントを並列起動し、この PR の差分をレビューさせる（pr-review-toolkit が無い環境では、汎用エージェントにバグ検出・テスト網羅・エラーハンドリングの3観点を割り当てて代替する）
   - 高重要度の指摘（バグ・データ破壊・受け入れ条件の未達・テストの欠落）を修正してコミットし、再びレビューする
   - 3エージェントの指摘は突き合わせて統合する。同じ箇所への重複指摘は1件として扱う。判断が割れた指摘（一方が問題視し他方が許容）は、**受け入れ条件に照らして**裁定する。ただしバグ・データ破壊・セキュリティに類する指摘は、受け入れ条件に明記がなくても高重要度として扱う。受け入れ条件で裁定してよいのは設計趣味・スタイル・スコープ外の改善提案の類のみ
   - **裁定した指摘を全件 review-log.jsonl に追記する**（採否を問わず。却下したものは `action:"rejected"` と `reason` を書く）。この裁定で手順が足りないと感じたら friction-log に `step:"review-arbitration"` で1行残す
   - 修正が新たな高重要度指摘を生む往復が続く場合、それは設計側の問題である可能性が高い。3回の上限を待たずに blocked にしてよい
   - 合格基準: 高重要度の指摘ゼロ かつ 検証コマンド全通過
7. 合格したら次の順で後片付けとマージを行う:
   1. `git fetch origin main` して `origin/main` をブランチに取り込む（連続処理では前のチケットのマージで main が進んでいる）。自動解決できないコンフリクトが出たら**マージせず blocked 処理へ進む**
   2. 取り込みで変更が出たら再度検証コマンドを通す
   3. このチケットで開発サーバーを起動していれば「開発サーバーの管理 / 停止」の手順で落とす。**`git worktree remove` より先に行う**（起動中のサーバーが `.next` を掴んでいると削除に失敗する）
   4. メインリポジトリのディレクトリへ戻る（ワークツリー内からは自分自身を削除できないため）
   5. `git worktree remove .claude/worktrees/ticket-<N>`（ブランチを解放する）
   6. `gh pr merge <PR番号> --squash --delete-branch`（Issue は Closes で自動クローズ）
   7. `gh issue view <N> --json state` で closed を確認する。Closes によるクローズは即時とは限らず、未クローズのまま次へ進むと後続チケットが依存待ちと誤判定される。未クローズなら数秒待って再確認し、それでも open なら `gh issue close <N>` で手動クローズする
   8. `gh issue edit <N> --remove-label "status:in-progress"`（Closes によるクローズは `status:in-progress` ラベルを外さないため、明示的に外す）
8. 3回のレビューで合格しなければ blocked 処理へ進む
9. チケット選択に戻り、次の候補を処理する

## blocked 処理

1. `gh issue edit <N> --remove-label "status:in-progress" --add-label "status:blocked"`
2. 何を試し、何が解決できないかを Issue にコメントする
3. PR とブランチは open のまま残し、ワークツリーも残す（チケット再開時にそのまま使う）。ただし**開発サーバーは停止する**（再開が数日後になることもあり、その間動かし続ける理由がない）。再開用の起動コマンドは終了報告に載せる。次のチケットへ進む

## 終了報告

`status:ready` が尽きたら、まず「開発サーバーの管理 / 掃除」の手順を再走行し、`.claude/worktrees/` 配下から起動された開発サーバーが1つも残っていない状態にする。個別の停止が失敗していてもここで回収される。続けて「ワークツリーの管理 / 掃除」を回し、孤児ワークツリーも回収する（サーバーを止めた後に行う）。

その上で、次をまとめて1つの報告にする。

- マージ済み: Issue 番号・タイトル・PR 番号
- blocked: **今回 blocked にしたものだけでなく、`gh issue list --label "status:blocked" --state open` で現在 blocked 状態の全チケットを対象**にする。それぞれ Issue 番号・理由の要約（既存 blocked は Issue コメントの経緯要約）を記載し、依存チェーンのボトルネックになっているものはその旨を明示する
- スキップ（依存待ち）: Issue 番号・待っている依存先
- 開発サーバー: 停止したポートの一覧。**起動時チェックで前回の中断から回収した孤児があれば、その件数とポートを明示する**（後片付けが飛んだ中断が起きていたことを人が把握できるようにする）
- ワークツリー: 削除した孤児の件数。**削除を保留したものがあれば、パスと保留理由（Issue が open / ソースが残っている）を挙げて人に判断を求める**
- 人への依頼: 開発環境での動作確認ポイント、blocked の判断依頼。開発サーバーは全て停止済みのため、確認が必要なものは再開コマンド（`cd .claude/worktrees/ticket-<N> && npm run dev -- -p <port>`）を添える

### manager への報告

このセッションが manager から「終了報告はこの送信元へ SendMessage で返信してください」というセッション間メッセージ（`<cross-session-message from="...">`）を受けていれば、上の報告をそのまま SendMessage で送る。`to` にはそのメッセージの `from` 属性の値をそのまま使う（例: `uds:/tmp/cc-socks/12345.sock`）。受けていなければ画面に出すだけでよい。

blocked 処理と Issue コメントは変えない。manager に送るのは終了報告だけで、途中経過や質問は送らない（人の判断が要る事項は Issue コメントに残り、manager が巡回で拾う）。
