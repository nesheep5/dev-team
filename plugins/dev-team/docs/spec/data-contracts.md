# データ契約

工程（スキル）同士は会話の文脈を共有しない。GitHub とリポジトリ内のファイルだけを介して受け渡す。ここで定める形式が工程間の唯一の接点である。

## ルール台帳 `.claude/rules/dev-team.md`

状態: 未実装（ロードマップ 段階2）

コミット対象。Claude Code がセッション開始時に自動ロードする共有指示ファイル（ADR 0006）。**所在と選択だけを書き、ルール本文は書かない**。常時ロードされるため短く保つ。frontmatter は使わない（`paths:` 用に予約されているため）。

```markdown
# dev-team プラグインのプロダクト設定

## トラッカー
- 種別: GitHub Issues（Jira なら base URL / プロジェクトキー / ステータス対応表 / 依存の表現）
- 状態: status:ready / in-progress / awaiting-review / blocked, priority:high

## ルールの所在
- 開発ルール: docs/development-rules.md（実装前に読む。dev-retro の提案先）
- PR ルール: .github/PULL_REQUEST_TEMPLATE.md、squash マージ、ブランチ ticket/<N>-<slug>、既定レビュアー、外部 AI レビュアーと待機時間
- 仕様（SSoT）: docs/spec/ 、ADR: docs/adr/ 、仕様変更の承認フロー: 会話合意で自動マージ
- 検証コマンド: npm run lint / format:check / typecheck / test / build

## このプロダクト固有の注意
```

台帳が無い場合、各スキルは setup を促す。

## 実行時データの置き場

状態: 一部実装（累積データは実装済み。揮発データは現行 `.claude/dev-loop/` に置いている）

性質で2つに分ける（ADR 0008）。

| 種別 | 置き場 | git | 中身 |
|---|---|---|---|
| 揮発データ | `.claude/dev-team/` | gitignore | `events.jsonl`、`servers/*.json`、`logs/*.log` |
| 累積データ | `.claude/dev-team-log/` | **コミット対象** | `review-log.jsonl`、`friction-log.jsonl` |

累積データは計測と振り返りの入力であり、端末やチェックアウトをまたいで残る必要がある。追記のみとし、行の書き換えと削除はしない（マージコンフリクトを避けるため）。

**現行実装は `.claude/dev-loop/` に揮発データを置いている。** `.claude/dev-team/` へ移す際（ROADMAP 段階 3a の残り）、ダッシュボードの読み取りパス（`server.mjs` の `eventsPathFor()`）も同時に変える。

## events.jsonl（揮発）

状態: 実装済み

処理の節目で1行 JSON を追記する。ダッシュボードがこれを読んで稼働状況を可視化する。

```
{"ts":"<ISO 8601>","agent":"main","ticket":<Issue番号|null>,"event":"stage|log|loop","stage":"<工程>","detail":{...}}
```

`stage` の値と書き出しポイントは [loop.md](loop.md) にある。`agent` は直列運転では `"main"` 固定。並列運転時は各エージェントのラベルを入れる（将来の拡張余地）。

書き出しの失敗（権限・ディスク等）でチケット処理を止めない。

## review-log.jsonl（累積）

状態: 実装済み（dev-loop のレビュー反復で記録する。`external:*` の source は自動ゲート（段階 3b）と一緒に足す）

dev-loop が指摘を処理するたびに1行追記する。フィードバックループと計測の共通データ（ADR 0004）。

```
{"ts":"...","ticket":N,"pr":M,"iteration":k,
 "source":"subagent:code-reviewer|external:coderabbit|human:<login>|ci",
 "severity":"high|low","category":"bug|test|error-handling|spec-mismatch|style|...",
 "file":"...","summary":"...","action":"fixed|rejected|deferred","reason":"..."}
```

`human:*` の行が「自動レビューをすり抜けた指摘」であり、フィードバックループの主入力になる。

## friction-log.jsonl（累積）

状態: 実装済み（記録のみ。集計は dev-retro、段階 5）

ループが**自分の指示の不備に気づいた瞬間**に1行追記する。プラグイン自身の改善に使う。review-log とは別物である。review-log は「プロダクトのコードの問題」、friction-log は「dev-team の指示の問題」を記録する。

```
{"ts":"...","ticket":N,"skill":"dev-loop","step":"<SKILL.md の節を指す安定 ID>",
 "kind":"ambiguous|undefined|contradicted|human-intervened|retry",
 "what":"何に詰まったか","resolved":"どう解決したか","cost":{"iterations":2}}
```

`step` は**自由記述ではなく SKILL.md の節を指す安定 ID** にする（例 `review-arbitration`。ID の一覧は dev-loop の SKILL.md にある）。同じ `step` が複数チケットから報告されることが改善すべき箇所の信号になるため、集計可能なキーであることが要件である。

`kind` の意味は次のとおり。

| kind | 意味 |
|---|---|
| `ambiguous` | 手順に複数の解釈があり、どちらか選ぶ必要があった |
| `undefined` | 手順に書かれていない判断をした |
| `contradicted` | 手順どおりにやると別の手順と矛盾した |
| `human-intervened` | 人が口を出して初めて進めた |
| `retry` | 同じ工程を想定外に繰り返した |

記録は**詰まった瞬間に行う**。チケット完了時にまとめて振り返ると、記憶からの再構成になり一般論に流れて具体性を失う。

## チケット

状態: 一部実装（4セクション構成は実装済み。仕様参照と `[ui]` `[e2e]` マークは未実装）

目的 / 設計 / 受け入れ条件 / 補足の4セクション。設計欄に仕様セクション参照（`docs/spec/auth.md#login-flow`）と関連 ADR 番号を書く。受け入れ条件の `[ui]` は ui-verifier の確認対象、`[e2e]` は E2E コード化対象。

状態遷移は `status:ready → in-progress → awaiting-review → closed`、`status:blocked` は別枝。ISSUE_TEMPLATE があればそちらを優先する。

依存は補足に `depends: #N` と書く。実装上の前提があるときだけ書く（先行チケットの型・関数を使う等）。着手順の希望だけでは書かない。依存を直列に連ねると、1件が blocked になった時点で後続すべてが着手不能になる。

## SSoT 仕様（プロダクト側）

状態: 未実装（ロードマップ 段階4）

既定 `docs/spec/`。台帳で変更可。`README.md`（目次と SSoT 宣言）と領域ごとの `<領域>.md`。セクションは見出し直前に `<a id="kebab-id"></a>` を置き、チケット・ADR・PR はこの ID で参照する（見出しの文言を変えても参照が壊れない。GitHub 上でも非表示でリンクが効く）。

「現在の仕様」だけを書き、変更履歴・未実装は書かない（ADR 0005）。仕様と実装のずれの一覧は `status:ready` / `in-progress` / `awaiting-review` のチケット群と定義する。

## ADR（プロダクト側）

状態: 未実装（ロードマップ 段階4）

既定 `docs/adr/NNNN-<slug>.md`。MADR 軽量版（タイトル / ステータス / 背景 / 決定 / 検討した選択肢 / 影響）。追記のみ。書き手は spec-intake と dev-retro だけ（ADR 0005）。

## PR 本文

状態: 一部実装（`Closes` と受け入れ条件チェックリストのみ）

必須要素は次のとおり。

- `Closes #<N>`
- 受け入れ条件ごとの充足状況チェックリスト
- 参照した仕様セクション ID（未実装）
- ui-verifier の確認結果（スクリーンショットは PR コメント）（未実装）
- 「仕様からの逸脱: なし / あり（理由）」（未実装）
