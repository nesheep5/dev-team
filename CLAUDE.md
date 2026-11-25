# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## このリポジトリの性質

**公開**リポジトリ。Claude Code プラグイン dev-team だけを載せる単独リポジトリで、リポジトリ自身がマーケットプレイス（name: `dev-team`）を兼ねる。別のプラグインはこのリポジトリに足さず、別のリポジトリで作る。

## 書いてはいけないもの

ファイル・コミットメッセージ・author のどこにも、次を入れない。

- ローカルのパス（ホームディレクトリ以下）
- メールアドレス、実名
- 会社名・社内の語彙・顧客名
- 非公開のリポジトリやプロジェクトの名前、そこでの具体的な作業内容（運用の記録を引くときは「個人の開発プロジェクト」と書き、数字だけを使う）

語のリストでは守らない（書いていない語は素通りし、リスト自体が秘密になるため）。push の前の判断レビューで守る。

## 公開前レビュー

push の前に必ず行う。pre-push が記録の有無を確かめ、無ければ止める。

1. push する範囲を決める（初回や force push なら `main` 全体、通常は `origin/main..HEAD`）
2. **新しいサブエージェント**に、`git log -p --format='%an <%ae>%n%B' <範囲>` の出力だけを渡し、「個人・組織・非公開のプロジェクトを特定できる情報、ローカルの環境に依存する記述が無いか」を判断させる。作業の文脈を知らない読み手の方が見落としにくい。注釈付きタグを push するときは `git cat-file tag <タグ>` の出力（tagger とメッセージ）も渡す。サブエージェントにはファイルの変更・コミット・push をさせない
3. 指摘があれば、語を消すのではなく一般化して書き直し、1 からやり直す
4. 問題が無ければ、`.git/publish-review/<push する HEAD の sha>` に要点を書く（何を見て、何が無かったか、指摘と直した内容）。`.git` の中なので公開されない。worktree で作業しているときも、worktree 側（`.git/worktrees/<名前>`）ではなくメインの `.git`（`git rev-parse --git-common-dir`）に置く
5. push はユーザーに確認してから行う

人が自分で確かめて push するときは、`PUBLISH_REVIEWED=1 git push` で記録を省ける。gitleaks と作者の検査は省けない。

## 準備

```bash
git config core.hooksPath git-hooks
git config user.name nesheep5
git config user.email <GitHub の noreply アドレス>
```

コミットは `nesheep5` と GitHub の noreply アドレスで行う（pre-push が author・committer を確かめる）。コミットメッセージに `Claude-Session:` の行（会話の URL）を付けない。`Co-Authored-By` は付けてよい。

## 開発

- プラグイン本体は `plugins/dev-team/` に置き、`marketplace.json` のソースは `./plugins/dev-team` と書く。ルートに上げると、tests・git-hooks まで利用者の環境に複製される
- プラグインの中のファイルは `${CLAUDE_PLUGIN_ROOT}` / `${CLAUDE_SKILL_DIR}` で参照する。絶対パスや、作者の端末の配置に依存する値を書かない。端末ごとに違う値は環境変数（`DEV_TEAM_HOME` / `DEV_TEAM_FLOW_REPO`）で受け取る（ADR 0014）
- ダッシュボード（`skills/dev-loop-dashboard/`）の依存は Node 標準ライブラリだけにする。`lib/state.mjs` に I/O を入れない
- テストは `tests/` に置く。ダッシュボードのテストから本物の `gh` を呼ばない（偽の gh かフィクスチャを注入する）
- 仕様の正は `plugins/dev-team/docs/spec/`（SSoT、ADR 0007）。SKILL.md の手順を変えたら、対応する spec の節と状態表記（実装済み / 未実装）、`docs/ROADMAP.md`、README を同じ変更で合わせる。決定を伴うなら先に ADR を足す（既存の ADR は書き換えず、新しい ADR で上書きする）
- README の「何で確かめたか」の数字は、テストの件数と運用の記録に合わせる。運用の記録を新しく足すときは、元の記録（review-log.jsonl などの集計）で数え直す
- 作者のマシンでは、クローンをローカルのパスでマーケットプレイスとして登録し、元の場所から読ませる。GitHub の形で登録すると cache に複製され、編集が反映されない
- 変更後は次を通す

  ```bash
  bash tests/validate.sh                                   # claude plugin validate
  node --test 'tests/dev-loop-dashboard/*.test.mjs'        # ダッシュボードのテスト
  bash tests/stop-dev-server.test.sh                       # 停止スクリプトのテスト
  bash tests/git-hooks.test.sh                             # git-hooks のテスト
  ```

- push は公開と同じ意味なので、毎回ユーザーに確認する
