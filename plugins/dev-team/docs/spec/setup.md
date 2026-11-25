# setup（初回セットアップ）

状態: 未実装（ロードマップ 段階2）

プロダクトに dev-team を導入するとき、既存ルールを検出して台帳に登録し、足りないものだけ推奨既定を提案する。**既存ルールが正**であり、プラグインの都合で上書きしない。

## 手順

1. **既存ルールの検出**: リポジトリを走査する
   - `CONTRIBUTING.md` / `docs/development-rules.md`
   - `AGENTS.md` / `CLAUDE.md`
   - `.github/PULL_REQUEST_TEMPLATE.md` / `.github/ISSUE_TEMPLATE/`
   - CI 設定 / `package.json` の scripts
   - `docs/spec` / `docs/adr`
   - `.coderabbit.yaml`（外部 AI レビュアーの有無）
2. **台帳への登録**: 見つかったものは参照として `.claude/rules/dev-team.md` に書く
3. **不足分の提案**: 無いものだけ `templates/` から推奨版を生成して提案する
   - 開発ルール雛形 / PR テンプレート / Issue テンプレート
   - SSoT の `README.md` / ADR 雛形
   - ラベル作成（`status:ready` / `in-progress` / `awaiting-review` / `blocked` / `priority:high`）
4. **トラッカーの選択**: GitHub Issues か Jira か。Jira なら接続方式（Atlassian MCP 推奨、REST フォールバック）を確認する
5. **一式を1本の PR** 「dev-team 初期セットアップ」にする

## 他スキルとの関係

他の全スキルは台帳が無ければ setup を促す。台帳は常時ロードされるため、各スキルは「読む手順」なしにトラッカーとルールの所在を知れる（ADR 0006）。

**注意**: 現行の3スキルは台帳を前提に書かれていない。dev-loop は検証コマンドを `package.json` 等から自前で特定している。段階2で台帳を導入する際、既存スキルが台帳を参照するよう改修しないと、台帳は誰にも読まれないファイルになる。この改修は段階2のスコープに含む。

## 推奨既定

| 対象 | 既定 |
|---|---|
| トラッカー | GitHub Issues + ラベル |
| マージ方式 | squash |
| ブランチ規約 | `ticket/<N>-<slug>` |
| 仕様の置き場 | `docs/spec/` + `<a id="kebab-id"></a>` アンカー |
| ADR の置き場 | `docs/adr/` MADR 軽量版 |
| 仕様変更の承認 | 会話合意で自動マージ |
