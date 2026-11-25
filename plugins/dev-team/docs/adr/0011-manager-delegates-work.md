# 0011: manager は自分のターンを短く保ち、収集・読解・下書きは background の subagent に委譲する

- ステータス: accepted（2026-09-06）

## 背景
manager（[ADR 0010](0010-manager-front-door.md)）は人が話す唯一の窓口だが、初版の SKILL.md は巡回の情報収集・起票前の対象リポジトリ読解・Issue 本文の下書き・止まったセッションのログ確認を manager 自身のターン内で行う設計だった。これらが走っている間、人の次の要求は待たされる。dev-loop からの終了報告や `notify_when_idle` の通知も manager のターンが終わるまで届かない（SKILL.md「起動と表示」の注記。事前検証で観測済み）。

2026-09-06 の運用中に、ユーザーから「manager は可能な限り作業を別エージェントにふり、すぐに要求を受け付けられるようにしてほしい」という要望が出た。窓口の価値は応答性にあり、収集や下書きを自分で抱えると窓口でなくなる。

## 決定
- manager セッションが自分で行うのは次だけ: 人との対話（ヒアリング・壁打ち・設計と受け入れ条件の合意）、承認の取得、`gh` の書き込み（`issue create` / `issue edit` / `issue comment`）、`claude --bg` / `claude stop` / `claude rm`、報告先通知の SendMessage、`~/.claude/settings.json` と hooks の編集、状態ディレクトリの `manager-log.jsonl` への追記、分割起票時に下書きへ `depends: #N` を書き込むこと（Issue 番号を知るのは manager だけ）
- それ以外の「時間のかかる読み・集計・下書き」は Agent ツールで subagent に出し（subagent は background で走り、完了は通知で届く）、委譲したら「収集中」と一言返してターンを終える。完了通知を受けてから結果を要約して中継する。完了前に結果を推測して人に伝えない
- subagent は manager がプロンプトで指定した下書き先以外に書かない（実質 read-only）。制約は subagent が SKILL.md を読まないため manager がプロンプトに書いて渡す。承認・起動・削除・Issue 作成を人の代わりに行わない。返すのは要約・所見・下書きファイルのパス
- 委譲先の型は固定しない。read-only で足りる作業（巡回の収集・ログの集計）は read-only 型を選び、下書きファイルの書き出しが要る作業だけ書き込みできる型を使う

### ADR 0010 との関係
ADR 0010 が退けた Agent Teams は「別リポジトリで開発を回す」用途の話である。本 ADR の subagent は manager 自身の準備作業（収集・読解・下書き）であり、開発を回すものではない。対象リポジトリの読み込みは spec-intake「対象プロジェクトの指定」と同じく `<path>` 起点の絶対パスで行うため cwd に依存しない。**本 ADR は ADR 0010 を覆さない。** 開発はこれまでどおりリポジトリごとの background セッション（dev-loop）で回す。

## 検討した選択肢
- 現状維持（manager が全部自分でやる）: 実装は単純だが、巡回や読解のたびに窓口が数分ふさがり、通知も遅延する。要望の趣旨に反する
- 巡回を `/loop` の定期実行にして manager のターンを空ける: 定期巡回はできるが、起票前の読解と下書きは解決しない。定期実行中もターンは占有される
- 巡回・下書きを別の background セッション（`claude --bg`）に出す: セッション間 SendMessage で結果を受け取れるが、起動と片付けのコストが Agent ツールより重く、scratchpad の共有もない。1 回の収集に対して過剰
- Agent Teams で teammate に出す: ADR 0010 が退けた理由（cwd の制約・lead 終了で全滅）がそのまま当てはまる。manager の準備作業は数分で終わる読み取りが主で、常駐の teammate は要らない

## 影響
- manager のターンは短くなり、人の割り込みと dev-loop からの通知がすぐ届く。代わりに「収集中」→「結果」の 2 往復に分かれる
- subagent は cwd = 設定を管理するリポジトリで動くため、対象リポジトリの CLAUDE.md / rules は読み込まれない（ADR 0010 と同じ cwd の制約）。必要なら manager がプロンプトに含める
- subagent が Ask ルールに当たった場合の扱いは manager と同じ端末設定を継承するため、現状の「権限の前提条件」で足りる想定。問題が出たら別 Issue で扱う
- `docs/spec/manager.md` に「実行モデル: 委譲」節を追加し、各節に委譲する部分を明記する。「対象外（v1）」に「subagent による承認・起動・削除の代行」を加える
- SKILL.md の frontmatter（`description`）は変えない。常駐トークンは description 長で決まり、応答性の話は本文で足りる
