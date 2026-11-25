#!/bin/bash
# dev-loop の開発サーバー停止スクリプトのテスト。
# 一時ディレクトリで本物の TCP サーバー（node）を別のプロセスグループとして起動し、
# --root の内側なら止め、外側なら止めないことを確かめる
REPO=$(cd "$(dirname "$0")/.." && pwd)
SCRIPT="$REPO/plugins/dev-team/skills/dev-loop/scripts/stop-dev-server.sh"
T="$REPO/tmp/stop-dev-server-test"; rm -rf "$T"; mkdir -p "$T"
INSIDE="$T/repo/.claude/worktrees/ticket-1"
OUTSIDE="$T/elsewhere"
mkdir -p "$INSIDE" "$OUTSIDE"
ROOT="$T/repo/.claude/worktrees"
fail=0
check() { if [ "$1" = "$2" ]; then echo "ok   $3"; else echo "NG   $3 (expect=$1 got=$2)"; fail=1; fi; }
run() { bash "$SCRIPT" "$@" >/dev/null 2>&1; echo $?; }

free_port() { python3 -c 'import socket; s=socket.socket(); s.bind(("127.0.0.1", 0)); print(s.getsockname()[1])'; }
listening() { [ -n "$(lsof -nP -iTCP:"$1" -sTCP:LISTEN -t 2>/dev/null)" ]; }
# $1: cwd, $2: port。setsid で新しいプロセスグループにして起動し、LISTEN を待つ
start_server() {
  (cd "$1" && python3 -c 'import os, sys; os.setsid(); os.execvp(sys.argv[1], sys.argv[1:])' \
    node -e 'require("http").createServer((q, r) => r.end("ok")).listen(Number(process.argv[1]), "127.0.0.1")' "$2" \
    >/dev/null 2>&1 & disown) 2>/dev/null
  for _ in $(seq 1 50); do listening "$2" && return 0; sleep 0.1; done
  echo "サーバーが起動しなかった（port $2）" >&2; return 1
}

# 引数の検査
check 64 "$(run)" "引数なしは 64"
check 64 "$(run --port 3000)" "--root が無ければ 64"
check 64 "$(run --root relative/path --port 3000)" "--root が相対パスなら 64"
check 64 "$(run --root "$ROOT" --port abc)" "--port が数でなければ 64"

# 対象が無いときは何もせず 0（冪等）
P=$(free_port)
check 0 "$(run --root "$ROOT" --port "$P")" "LISTEN しているプロセスが無ければ 0"

# --root の内側のサーバー
P=$(free_port); start_server "$INSIDE" "$P" || fail=1
check 0 "$(run --root "$ROOT" --port "$P" --dry-run)" "--dry-run は 0 で終わる"
listening "$P" && got=alive || got=stopped
check alive "$got" "--dry-run では止めない"
check 0 "$(run --root "$ROOT" --port "$P")" "--root の内側のサーバーを止めて 0"
listening "$P" && got=alive || got=stopped
check stopped "$got" "止めたあとポートが空く"

# --root の外側のサーバーは止めない
P=$(free_port); start_server "$OUTSIDE" "$P" || fail=1
check 2 "$(run --root "$ROOT" --port "$P")" "--root の外側なら拒否して 2"
listening "$P" && got=alive || got=stopped
check alive "$got" "拒否したときは止めない"
# 後片付けも同じスクリプトで行う（外側を含む範囲を --root に渡せば止められる）
check 0 "$(run --root "$T" --port "$P")" "外側を含む範囲を --root に渡せば止められる"

rm -rf "$T"
exit $fail
