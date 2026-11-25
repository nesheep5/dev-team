#!/bin/bash
# dev-loop（background セッション）が開発サーバーだけを許可プロンプト無しで
# 安全に停止できるようにするスクリプト。
#
# 生の kill / pkill / killall は許可せず、このスクリプト 1 本だけを許可する
# 運用を想定している。そのため「本当に開発サーバーのプロセスグループだけを殺す」ことを
# スクリプト内部で厳格に検査し、少しでも怪しければ何も殺さず exit 2 する
# （フェイルセーフ側に倒す。判定に必要な情報が取れない場合も同様に何もしない）。
#
# 使い方:
#   stop-dev-server.sh --root DIR (--port N | --pgid N | --pid N)... [--dry-run] [--timeout SEC]
#   --root は必須。停止してよいプロセスの cwd の範囲（dev-loop では
#   <メインリポジトリ>/.claude/worktrees）を絶対パスで渡す。
#   --port / --pgid / --pid は複数指定可（例: --port 3001 --port 3086）。
#   複数指定時は対象グループを 1 つずつ「検査 → 停止」する（全グループを
#   先に検査してから一括で停止する all-or-nothing ではない）。そのため
#   途中のグループが安全条件で拒否されると、それより前に指定したグループは
#   既に停止済みのまま exit 2 で終わる
#
# 対象の解決:
#   --port N  : lsof で N を LISTEN している pid を探し、その pgid を対象にする
#   --pid N   : N の pgid に引き上げて対象にする
#   --pgid N  : N をそのまま対象にする
#   いずれの場合も、対象は「pgid に属する全プロセス」に展開して検査する
#   （pgrep -g PGID）。
#
# 安全条件（グループ内の全 pid で検査。1 つでも外れたら何も殺さず exit 2）:
#   1. 各 pid の cwd が --root 配下（symlink は実体で判定）
#   2. グループ内の少なくとも 1 プロセスが TCP LISTEN ソケットを持つ
#   3. コマンド名（ps -o comm=、フルパスの basename）または第 1 引数が保護リスト
#      （claude 本体、tmux、シェル本体、ghostty、ssh 等）に一致しない。
#      判定はコマンド全体の文字列一致ではなく argv[0]/argv[1] の basename に対して
#      行う（例: `sh -c "npm run dev; true"` のような通常の dev サーバー起動で
#      グループに残る sh -c ラッパーまで誤って保護しないため）。シェル本体
#      （bash/zsh/sh/fish）は「引数なしで起動されたそれ自身」だけを保護する
#      （対話シェル・ログインシェルを想定。`sh -c ...` は保護しない）
#   4. pid > 1、pgid がスクリプト自身の pgid と異なる、pgid != 1
#
# 停止: kill -TERM -PGID → --timeout（既定 5 秒）まで 0.5 秒間隔で生存確認
#       → 残っていれば kill -KILL -PGID
#
# 終了コード: 0 = 成功（対象なしも含む・冪等）,
#            2 = 安全条件で拒否 or KILL 後も生存プロセスが残った（停止失敗）,
#            64 = 引数エラー
set -u
STOP_FAILED=0

ROOT=""
TIMEOUT=5
DRY_RUN=0
declare -a PORTS=()
declare -a PIDS=()
declare -a PGIDS=()

usage() {
  echo "使い方: $0 --root DIR (--port N | --pgid N | --pid N)... [--dry-run] [--timeout SEC]" >&2
  exit 64
}

while [ $# -gt 0 ]; do
  case "$1" in
    --root)
      [ $# -ge 2 ] || usage
      case "$2" in /*) ;; *) usage ;; esac
      ROOT="${2%/}"; shift 2 ;;
    --port)
      [ $# -ge 2 ] || usage
      case "$2" in ''|*[!0-9]*) usage ;; esac
      PORTS+=("$2"); shift 2 ;;
    --pid)
      [ $# -ge 2 ] || usage
      case "$2" in ''|*[!0-9]*) usage ;; esac
      PIDS+=("$2"); shift 2 ;;
    --pgid)
      [ $# -ge 2 ] || usage
      case "$2" in ''|*[!0-9]*) usage ;; esac
      PGIDS+=("$2"); shift 2 ;;
    --dry-run)
      DRY_RUN=1; shift ;;
    --timeout)
      [ $# -ge 2 ] || usage
      case "$2" in ''|*[!0-9]*) usage ;; esac
      TIMEOUT="$2"; shift 2 ;;
    *)
      usage ;;
  esac
done

if [ -z "$ROOT" ]; then
  usage
fi
if [ ${#PORTS[@]} -eq 0 ] && [ ${#PIDS[@]} -eq 0 ] && [ ${#PGIDS[@]} -eq 0 ]; then
  usage
fi

# 物理パスでの --root（symlink 経由対策）。存在しなければ文字列のまま比べる
# （その場合、配下に cwd を持つプロセスも存在しない）
ROOT_PHYS=$(cd "$ROOT" 2>/dev/null && pwd -P)
[ -z "$ROOT_PHYS" ] && ROOT_PHYS="$ROOT"

under_root() {  # $1: 絶対パス
  case "$1" in
    "$ROOT"/*|"$ROOT_PHYS"/*) return 0 ;;
    *) return 1 ;;
  esac
}

# 保護対象コマンド名（basename で比較。フルパスでもコマンド名だけでも一致する）
PROTECTED_NAMES='claude herdr tmux ghostty ssh sshd launchd loginwindow'
SHELL_NAMES='bash zsh sh fish'

basename_of() {  # $1: パス or コマンド名
  printf '%s' "${1##*/}"
}

is_protected_command() {  # $1: comm(ps -o comm=), $2: command全体（ps -o command=）
  local comm="$1" full="$2"
  local name_comm name0 name1
  name_comm=$(basename_of "$comm")
  # command 全体の第1語（argv[0] 相当）。comm は macOS の一部プロセス（例:
  # Claude Code のバックグラウンド daemon）でスペース入りの独自表示名になり
  # 実行ファイル名と一致しないことがあるため、command 側からも取り直して
  # 両方を判定に使う（どちらか一方が一致すれば保護）。
  name0=$(printf '%s' "$full" | awk '{print $1}')
  name0=$(basename_of "$name0")

  # シェル本体は「引数なしで起動されたそれ自身」だけ保護する（sh -c ... は保護しない）
  local w
  for w in $SHELL_NAMES; do
    if [ "$name_comm" = "$w" ] || [ "$name_comm" = "-$w" ] || [ "$name0" = "$w" ] || [ "$name0" = "-$w" ]; then
      # command 全体がコマンド名 1 語だけ（空白区切りの引数が無い）なら対話/ログインシェル
      case "$full" in
        *[[:space:]]*) ;;  # 引数がある = sh -c 等。保護しない
        *) return 0 ;;
      esac
      return 1
    fi
  done
  for w in $PROTECTED_NAMES; do
    [ "$name_comm" = "$w" ] && return 0
    [ "$name0" = "$w" ] && return 0
  done
  # 第1引数（argv[1]）が claude の場合（例: env 経由起動）も保護対象にする。
  # 仕様上の「コマンド名または第 1 引数」の対象は claude 本体のみに絞る
  # （tmux/sh 等を argv[1] まで広げると "node run-tmux-test.js" のような
  # dev サーバー起動を誤検知する余地が生まれるため）
  name1=$(printf '%s' "$full" | awk '{print $2}')
  name1=$(basename_of "$name1")
  [ "$name1" = "claude" ] && return 0
  return 1
}

SELF_PGID=$(ps -o pgid= -p $$ 2>/dev/null | tr -d ' ')

# --- 対象 pgid の収集 -------------------------------------------------
declare -a TARGET_PGIDS=()

add_pgid() {
  local pg="$1"
  for existing in "${TARGET_PGIDS[@]:-}"; do
    [ "$existing" = "$pg" ] && return 0
  done
  TARGET_PGIDS+=("$pg")
}

for port in "${PORTS[@]:-}"; do
  [ -z "$port" ] && continue
  pid=$(lsof -nP -iTCP:"$port" -sTCP:LISTEN -t 2>/dev/null | head -1)
  if [ -z "$pid" ]; then
    echo "対象なし: --port $port を LISTEN しているプロセスが見つかりません"
    continue
  fi
  pg=$(ps -o pgid= -p "$pid" 2>/dev/null | tr -d ' ')
  [ -n "$pg" ] && add_pgid "$pg"
done

for pid in "${PIDS[@]:-}"; do
  [ -z "$pid" ] && continue
  pg=$(ps -o pgid= -p "$pid" 2>/dev/null | tr -d ' ')
  if [ -z "$pg" ]; then
    echo "対象なし: --pid $pid のプロセスが見つかりません"
    continue
  fi
  add_pgid "$pg"
done

for pg in "${PGIDS[@]:-}"; do
  [ -z "$pg" ] && continue
  add_pgid "$pg"
done

if [ ${#TARGET_PGIDS[@]} -eq 0 ]; then
  echo "対象なし"
  exit 0
fi

deny() {
  echo "拒否: $1" >&2
  exit 2
}

# --- 各 pgid ごとに検査・停止 -------------------------------------------
for PGID in "${TARGET_PGIDS[@]}"; do
  case "$PGID" in ''|*[!0-9]*) deny "不正な pgid: $PGID" ;; esac

  if [ "$PGID" -le 1 ]; then
    deny "pgid が保護範囲です（<=1）: $PGID"
  fi
  if [ -n "$SELF_PGID" ] && [ "$PGID" = "$SELF_PGID" ]; then
    deny "pgid がこのスクリプト自身のプロセスグループです: $PGID"
  fi

  members=$(pgrep -g "$PGID" 2>/dev/null)
  if [ -z "$members" ]; then
    echo "対象なし: pgid $PGID に属する生存プロセスがありません"
    continue
  fi

  has_listen=0
  # 停止後の報告用に、検査時点の cwd/command を退避しておく
  # （kill 後は ps/lsof でプロセス情報が引けなくなるため）。
  # 連想配列（declare -A）は macOS 標準の /bin/bash（3.2）に無いため、
  # pid をインデックスに使う添字配列（bash の疎配列）で代用する。
  declare -a MEMBER_CWD=()
  declare -a MEMBER_CMD=()
  live_members=""
  for pid in $members; do
    if [ "$pid" -le 1 ]; then
      deny "グループ内に保護 pid が含まれます（<=1）: $pid (pgid $PGID)"
    fi

    # 既に終了したがまだ回収されていない zombie は cwd/command が引けず
    # 誤って拒否の原因になる。生存プロセスとして扱わずスキップする
    # （停止対象としては何もしなくてよい存在のため安全側にも合致する）
    stat=$(ps -o stat= -p "$pid" 2>/dev/null | tr -d ' ')
    case "$stat" in
      Z*) continue ;;
    esac
    live_members="$live_members $pid"

    # 条件1: cwd が --root 配下
    cwd_line=$(lsof -a -p "$pid" -d cwd -Fn 2>/dev/null | sed -n 's/^n//p')
    if [ -z "$cwd_line" ]; then
      deny "pid $pid の cwd を取得できません（判定不能のため停止しません）"
    fi
    if [ -d "$cwd_line" ]; then
      cwd_phys=$(cd "$cwd_line" 2>/dev/null && pwd -P)
    else
      cwd_phys=""
    fi
    if [ -z "$cwd_phys" ] || ! under_root "$cwd_phys"; then
      deny "pid $pid の cwd が $ROOT 配下ではありません（cwd: ${cwd_phys:-$cwd_line}）"
    fi

    # 条件3: 保護コマンドに一致しない（comm=argv[0]、command=全体）
    comm=$(ps -o comm= -p "$pid" 2>/dev/null)
    command_line=$(ps -o command= -p "$pid" 2>/dev/null)
    if [ -z "$command_line" ]; then
      deny "pid $pid のコマンドを取得できません（判定不能のため停止しません）"
    fi
    if is_protected_command "$comm" "$command_line"; then
      deny "pid $pid が保護対象コマンドに一致します: $command_line"
    fi

    MEMBER_CWD[$pid]="$cwd_line"
    MEMBER_CMD[$pid]="$command_line"

    # 条件2: グループ内のどれかが LISTEN を持つか
    if lsof -nP -a -p "$pid" -iTCP -sTCP:LISTEN >/dev/null 2>&1; then
      has_listen=1
    fi
  done

  # グループ内の生存プロセスが全て zombie で除外された場合、停止すべき対象は
  # 実質存在しない（zombie は kill できない）。開発サーバーでないと拒否する
  # のではなく、対象なしとして冪等に扱う
  if [ -z "$live_members" ]; then
    echo "対象なし: pgid $PGID の生存プロセスは全て zombie です"
    continue
  fi

  if [ "$has_listen" -eq 0 ]; then
    deny "pgid $PGID 内に TCP LISTEN を持つプロセスがありません（開発サーバーと確認できません）"
  fi

  echo "対象確定: pgid $PGID"
  for pid in $live_members; do
    echo "  pid=$pid cwd=${MEMBER_CWD[$pid]} command=${MEMBER_CMD[$pid]}"
  done

  if [ "$DRY_RUN" -eq 1 ]; then
    continue
  fi

  kill -TERM -"$PGID" 2>/dev/null

  elapsed=0
  # awk で 0.5 刻みの比較を行う（bash の算術は整数のみのため）
  while awk -v e="$elapsed" -v t="$TIMEOUT" 'BEGIN{exit !(e<t)}'; do
    remaining=$(pgrep -g "$PGID" 2>/dev/null)
    [ -z "$remaining" ] && break
    sleep 0.5
    elapsed=$(awk -v e="$elapsed" 'BEGIN{printf "%.1f", e+0.5}')
  done

  remaining=$(pgrep -g "$PGID" 2>/dev/null)
  if [ -n "$remaining" ]; then
    kill -KILL -"$PGID" 2>/dev/null
    sleep 0.5
  fi

  # KILL 後も生存していれば停止失敗として exit 0 で終わらせない
  # （表示だけ「停止」と言って実は生きている、という嘘の報告を防ぐ）
  still_alive=$(pgrep -g "$PGID" 2>/dev/null)
  if [ -n "$still_alive" ]; then
    echo "停止失敗: pgid $PGID にまだ生存プロセスがあります: $still_alive" >&2
    STOP_FAILED=1
  fi

  for pid in $live_members; do
    echo "停止: pid=$pid cwd=${MEMBER_CWD[$pid]} command=${MEMBER_CMD[$pid]}"
  done
  unset MEMBER_CWD MEMBER_CMD
done

[ "${STOP_FAILED:-0}" -eq 1 ] && exit 2
exit 0
