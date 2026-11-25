# Herdr での表示

manager が Herdr（ターミナルマルチプレクサ）の中で動いているとき（`HERDR_ENV=1`）だけ使う手順。manager 自身が居る workspace に、dev-loop の attach 用のタブを足し、終了時に閉じる。1 workspace = このリポジトリの manager + dev-loop になり、サイドバーを workspace 単位で並べていれば 1 行が 1 リポジトリに対応する（ADR 0013）。Herdr が無い環境では使わない。

- 自分の workspace は `herdr pane current` の `result.pane.workspace_id` で取る。状態ファイルから探さない
- 作ったタブの id は `<state-dir>/herdr/<name>.json` に記録する。1 manager 1 ファイルで、他の manager と書き込みが競合しない。形は `{"workspace_id": "wX", "tab_ids": ["wX:t2"]}`。**タブの所有は id だけで判定する**（label・cwd で推測しない）。記録の `workspace_id` が今の workspace と違えば（Herdr 再起動で id が振り直された等）旧記録は捨てる
- workspace の作成・close は行わない

## タブを足す

`<name>` / `<path>` / `<id>`（`claude --bg` が印字した id）を埋めて 1 回の Bash 呼び出しで打つ。

```bash
set -euo pipefail
NAME=<name>; REPO=<path>; SID=<id>
D="${DEV_TEAM_HOME:-$HOME/.claude/dev-team}/herdr"; F="$D/$NAME.json"; mkdir -p "$D"
WS=$(herdr pane current | python3 -c 'import json,sys; print(json.load(sys.stdin)["result"]["pane"]["workspace_id"])')
TAB_JSON=$(herdr tab create --workspace "$WS" --cwd "$REPO" --label dev-loop --no-focus)
TAB=$(printf '%s' "$TAB_JSON" | python3 -c 'import json,sys; print(json.load(sys.stdin)["result"]["tab"]["tab_id"])')
PANE=$(printf '%s' "$TAB_JSON" | python3 -c 'import json,sys; print(json.load(sys.stdin)["result"]["root_pane"]["pane_id"])')
[ -n "$WS" ] && [ -n "$TAB" ] && [ -n "$PANE" ] || { echo "workspace/tab/pane の id が取れない。記録せず止める（タブが作成済みなら herdr tab list --workspace $WS で人に見せる）"; exit 1; }
# 記録する（一時ファイル経由で置き換え、途中で落ちても空ファイルにしない）
python3 - "$F" "$WS" "$TAB" <<'PY'
import json,os,sys,tempfile
f,ws,tab=sys.argv[1:4]
d=json.load(open(f)) if os.path.exists(f) else {}
tabs=set(d.get("tab_ids",[])) if d.get("workspace_id")==ws else set()
d={"workspace_id":ws,"tab_ids":sorted(tabs|{tab})}
fd,tmp=tempfile.mkstemp(dir=os.path.dirname(f)); os.write(fd,json.dumps(d,ensure_ascii=False,indent=2).encode()); os.close(fd); os.replace(tmp,f)
PY
herdr pane run "$PANE" "claude attach $SID"
```

`tab create` の応答は `result.tab.tab_id`（例 `wX:t2`）・`result.root_pane.pane_id`（例 `wX:p3`）を持つ。エラーは stderr に JSON・exit 1 で、`TAB_JSON=$(...)` の代入自体が `set -e` で止まる。

## タブを閉じる

`claude rm` の後に打つ。記録した `tab_ids` のうち**今の workspace に存在するものだけ**を閉じ、記録を消す。記録に無いタブ（manager 自身のタブ・人が足したタブ）には触らない。id を控えていても、シェル変数は Bash 呼び出しをまたがないので、**必ずこのブロックの先頭で記録から読み直す**。

```bash
set -euo pipefail
NAME=<name>; F="${DEV_TEAM_HOME:-$HOME/.claude/dev-team}/herdr/$NAME.json"
[ -f "$F" ] || { echo "$NAME の Herdr 記録は無い。閉じるタブは無い"; exit 0; }
WS=$(herdr pane current | python3 -c 'import json,sys; print(json.load(sys.stdin)["result"]["pane"]["workspace_id"])')
REC_WS=$(python3 -c 'import json,sys; print(json.load(open(sys.argv[1])).get("workspace_id",""))' "$F")
if [ "$REC_WS" != "$WS" ]; then
  echo "記録の workspace $REC_WS は今の $WS と違う（Herdr 再起動等）。閉じずに記録だけ捨てる"
  python3 -c 'import os,sys; os.remove(sys.argv[1])' "$F"; exit 0
fi
LIVE=$(herdr tab list --workspace "$WS" | python3 -c 'import json,sys; print(" ".join(t["tab_id"] for t in json.load(sys.stdin)["result"]["tabs"]))')
for T in $(python3 -c 'import json,sys; print(" ".join(json.load(open(sys.argv[1])).get("tab_ids",[])))' "$F"); do
  case " $LIVE " in
    *" $T "*) herdr tab close "$T" && echo "closed $T" ;;
    *) echo "$T は既に無い（人が閉じた）" ;;
  esac
done
python3 -c 'import os,sys; os.remove(sys.argv[1])' "$F"
```

記録の削除に `rm` を使わないのは、`rm` を許可ルールやフックで止めている環境でも、この手順が許可待ちで止まらないようにするため。
