# 0013: manager はリポジトリごとに 1 つ。cwd が対象プロジェクトで、台帳はダッシュボード専用にする

- ステータス: accepted（2026-09-14）

## 背景
ADR 0010 は「人と対話するのは manager セッション 1 つ」とし、manager を設定を管理するリポジトリを cwd にして起動し、端末ローカルの台帳 `projects.json` で複数プロジェクトを扱う設計にした。運用してみると、この構成では manager と subagent の cwd が常に設定のリポジトリで、対象リポジトリの CLAUDE.md / rules / スキルが読み込まれない（ADR 0011 の影響欄にも「cwd の制約」として残っている）。起票の読解や設計壁打ちで必要な規約を manager がプロンプトに写して渡す運用は、文脈の欠落を手作業で埋めているにすぎない。

一方、人の実際の使い方は Herdr の workspace をリポジトリごとに開き、そのリポジトリの話をそこでする形になっている。「1 端末に manager 1 つ」の前提は、この使い方と合っていない。

## 決定
- **manager はリポジトリごとに 1 つ**。人は対象リポジトリの workspace で `claude` を起動し、そこで `/dev-team:manager` を呼ぶ。cwd が対象プロジェクトであり、CLAUDE.md / rules は Claude Code が自動で読み込む。subagent も同じ cwd を継承する
- **manager は台帳を読まない**。対象の識別は cwd から行う: `git rev-parse --show-toplevel`（`path`）、その basename（`name`。manager-log の `project` と Herdr 記録のキー）、`gh repo view --json nameWithOwner`（`owner/repo`）。リポジトリ外で起動されたら止まる
- **横断ビューはダッシュボードだけが持つ**。台帳 `projects.json` はダッシュボード専用の入力になり、形式の定義は [spec/dashboard.md](../spec/dashboard.md) が所有する。manager は台帳が無くても動く
- **フロー改善（スキル・ルール・設定）の宛先は、設定を管理するリポジトリのまま**。台帳の `note` からは導かない（導き方は ADR 0014 で環境変数 `DEV_TEAM_FLOW_REPO` に改めた）。cwd がそのリポジトリならこの迂回は通常経路に畳まれる。`~/.claude/settings.json` と hooks の直接編集は従来どおり承認後にその場で行う
- **Herdr の表示は manager 自身の workspace にタブを足す**。`herdr pane current` で自分の `workspace_id` を取り、`herdr tab create --workspace` で dev-loop の attach 用タブを作る。`loop:<name>` workspace の作成・生存確認・label 照合・close は廃止する。1 workspace = そのリポジトリの manager + dev-loop になり、サイドバーを workspace 単位で並べていれば 1 行が 1 リポジトリに対応する
- **Herdr の記録は 1 manager 1 ファイル**。状態ディレクトリの `herdr/<name>.json`（`{"workspace_id", "tab_ids"}`）に manager が作ったタブの id だけを持つ。それまでの全 manager 共通の記録ファイルは廃止する。Herdr の id は端末の属性でありリポジトリの属性ではないため、`<repo>/.claude/dev-team/` には置かない
- `manager-log.jsonl` はグローバル（状態ディレクトリ）のまま。改善対象が端末全体の settings / hooks なので、`project` フィールドで区別しつつ横断で集計できる方がよい。追記は `>>` の短い 1 行で、複数 manager からの同時追記に耐える
- `gh` は引き続き常に `-R <owner/repo>` 付きで打つ。cwd のリポジトリへの誤起票を防ぐためではなく、設定のリポジトリへの迂回と書き方を揃えるため

### ADR 0010 との関係
ADR 0010 の決定のうち上書きするのは「人と対話するのは manager セッション 1 つ」「manager は設定を管理するリポジトリを cwd にして起動する」「プロジェクト台帳を manager が持つ」の 3 点だけ。「開発はリポジトリごとに 1 つの background セッション（1 リポジトリ 1 ループ）」「セッション間の通信は SendMessage」「Herdr は表示にだけ使う」「改善は提案型」は変えない。ADR 0010 は accepted のまま残す。ADR 0011（委譲）と ADR 0012（ダッシュボード）の決定も変えない。ADR 0011 の影響欄「subagent は cwd = 設定を管理するリポジトリで動く」は本 ADR で解消され、迂回時だけの制約に縮む。

## 検討した選択肢
- 台帳を残し、manager は cwd に一致する 1 件を引く: 変更量は最小だが、台帳が「ダッシュボード用」と「manager 用」の 2 役を持ち続け、未登録のリポジトリで manager が止まる。台帳の登録忘れという新しい事故を持ち込む
- 台帳をリポジトリごとのファイルに分割する（状態ディレクトリの `projects/<name>.json`）: 「分割」を字義どおり行う案だが、リポジトリごとの manager に台帳の内容（`name` / `path` / `note`）は要らない。cwd から全部導ける。ダッシュボードの読み込みも glob に変える必要が出て、変更が増えるだけ
- リポジトリ内の台帳（段階 2 の `.claude/rules/dev-team.md`、ADR 0006）を manager が読む: 将来の方向としては正しいが、段階 2 は未着手で、manager の分割にトラッカーやルール台帳の設計まで巻き込む。今回の範囲を超える
- manager に横断の巡回を残す（「全体は？」と聞かれたら台帳の全件を回る）: 分割の趣旨（cwd の文脈で動く）と混ざる。横断ビューはダッシュボードが既に持っており、manager に二重に持たせる理由が無い
- Herdr の表示を従来どおり別 workspace `loop:<name>` に置く: サイドバーで manager と dev-loop が別行になる。manager がリポジトリの workspace に居るなら同じ行にまとまる方が見やすく、workspace の生存確認・label 照合・close の手順（SKILL.md の約 100 行）も丸ごと不要になる
- Herdr の記録を `<repo>/.claude/dev-team/` に置く: 書き込み競合は無くなるが、Herdr の workspace / tab id は端末が振るもので、別マシンのチェックアウトには意味が無い。加えて `.claude/dev-team/` はどのリポジトリでもまだ gitignore されていない（段階 3a で追加予定）

## 影響
- manager は対象リポジトリの CLAUDE.md / rules / スキルを自動で読み込んだ状態で動く。起票の読解・壁打ち・下書きに規約を写して渡す運用が不要になる（迂回時を除く）
- 人が話す相手はリポジトリの数だけ増える。「どのセッションに言うか」は workspace で決まる。横断で状況を見たいときはダッシュボードを開く
- `spec/manager.md` を全面改稿する。「プロジェクト台帳」節は `spec/dashboard.md` へ移り、「起動と表示」の Herdr 手順は自分の workspace へのタブ追加に置き換わる。「巡回」は 1 プロジェクトになる
- `agents/patrol-collector.md` は 1 件の `name` / `path` / `owner/repo` を受ける。`agents/intake-drafter.md` と `spec/intake.md`「対象プロジェクトの指定」の「cwd は設定のリポジトリ」の記述は、迂回時だけの制約に改める
- SKILL.md の frontmatter `description` は「複数プロジェクトの窓口」から「このリポジトリの窓口」に変わる（発火語も「このリポジトリの状況を見て」等に寄せる）
- ROADMAP に段階 M の追記として本 ADR の実装項目を載せる
