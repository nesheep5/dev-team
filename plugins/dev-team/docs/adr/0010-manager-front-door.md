# 0010: 窓口 manager: 人との対話を 1 セッションに集め、開発はリポジトリごとの background セッションで回す

- ステータス: accepted（2026-09-06）

## 背景
複数プロダクトの開発を並行させると、リポジトリごとに Claude セッションが立ち、人は「この要望はどのセッションに言うか」「どのペインが止まっているか」を自分で管理することになる。要望の起票（spec-intake）と消化（dev-loop）は既に Issue を唯一の界面として分離されているため、足りないのは「人が話す相手を 1 つにする窓口」と「開発セッションの起動・監視を肩代わりする仕組み」である。

当初は Herdr（ターミナルマルチプレクサ）の agent 制御 CLI を実行基盤にする案を検討したが、Claude Code 自身に `claude --bg`（background セッション）、`claude agents --json`（状態取得）、`claude attach`（任意ペインからの乗り込み）、セッション間 SendMessage が揃っていることを事前検証（2026-09-06）で確認した。

## 決定
- 人と対話するのは manager セッション 1 つ。要望はここで spec-intake の手順に従って壁打ちし、対象プロジェクトの Issue にする。開発フロー自体（スキル・設定・ルール）の改善要望は、それらを管理するリポジトリを対象プロジェクトとして扱う
- 開発はリポジトリごとに 1 つの background セッション（`cd <repo> && claude --bg "/dev-team:dev-loop"`）で回す。同一リポジトリに 2 つ目のループを起動しない
- セッション間の通信は Claude Code のセッション間 SendMessage を正とし、dev-loop が終了報告を manager へ送る。人の判断が要る事項は従来どおり GitHub（blocked コメント・PR）に落ち、manager が巡回して要約する
- Herdr は表示にだけ使う（`claude attach` を置くペインを作る）。Herdr が無くても起票・起動・巡回は動く
- 改善は提案型（ADR 0004 と同じ）。manager は中継した割り込みを記録し、繰り返しを根拠に提案する。`~/.claude/settings.json`・hooks の変更は承認後にその場で編集し（リポジトリ管理外）、CLAUDE.md・rules・スキル本文の変更はそれらを管理するリポジトリで行う

## 検討した選択肢
- Agent Teams（teammate を tmux ペインに出す方式）: 許可プロンプトが lead に集まる利点はあるが、teammate は lead と同じディレクトリで起動し、別リポジトリの settings / hooks / CLAUDE.md を読ませられない。lead 終了で全滅する。リポジトリ内の並列に取っておく
- Herdr の agent 制御を必須にする: 起動・状態・画面読みは揃うが、画面スクレイピングで質問文を切り出す脆さと、Herdr の無い端末で動かない制約がある。表示用途に限定する
- `claude -p`（headless）で dev-loop を起動する: 途中で乗り込めず、止めるには kill しかない。`--bg` は attach で同じ会話に入れるため上位互換
- 外部デーモン（Node スクリプト）が ready を巡回して起動する: 完全無人だが権限を全部事前決定する必要があり、運用が枯れる前には早い

## 影響
- 開発セッションは無人で走るため、dev-loop の経路に Ask ルールが残っていると誰も答えず `blocked` のまま止まる。「Ask ルールが無いこと」が初回運転の前提条件になり、危険操作は deny フックで止める方針に寄る
- manager は設定を管理するリポジトリを cwd にして起動する（改善の実施先であり、`gh` は常に `-R` 付きで打つ）。プロジェクト台帳は端末ローカル（状態ディレクトリの `projects.json`）に置き、コミットしない
- spec-intake は cwd 以外のプロジェクトを対象にできる必要がある（[spec/intake.md](../spec/intake.md)）。dev-loop は manager からのメッセージに終了報告を返せると往復が減る（[spec/loop.md](../spec/loop.md)）
- 段階 2 の台帳（`.claude/rules/dev-team.md`）とは別物。こちらは「どのプロジェクトがあるか」、あちらは「そのプロジェクトの運用規約」
