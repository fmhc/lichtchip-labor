#!/bin/bash
# Run only on the configured test host. No local browser, Python or GPU work.
# usage: tools/remote_run.sh 'index.html?selftest' out.png [timeout_s] [WIDTHxHEIGHT[@DPR]]
set -euo pipefail
cd "$(dirname "$0")/.."
die() { printf '%s\n' "$*" >&2; exit 2; }
# Read data, never source shell code. Environment variables take precedence.
if [[ -f tools/remote.env ]]; then
  while IFS= read -r line || [[ -n $line ]]; do
    [[ -z $line || $line == \#* ]] && continue
    [[ $line == *=* ]] || die 'Invalid remote.env line'
    key=${line%%=*}; value=${line#*=}
    case $key in
      LICHTCHIP_REMOTE|LICHTCHIP_REMOTE_DIR|LICHTCHIP_PORT) [[ -v $key ]] || printf -v "$key" '%s' "$value" ;;
      *) die 'Unknown remote.env key' ;;
    esac
  done < tools/remote.env
fi
[[ $# -ge 2 && $# -le 4 ]] || die 'Expected page, screenshot, optional timeout and viewport'
remote=${LICHTCHIP_REMOTE:-}; dir=${LICHTCHIP_REMOTE_DIR:-}; port=${LICHTCHIP_PORT:-8791}
[[ $remote =~ ^([a-zA-Z0-9_][a-zA-Z0-9_.-]*@)?[a-zA-Z0-9][a-zA-Z0-9_.-]*$ ]] || die 'Invalid LICHTCHIP_REMOTE (SSH alias or user@host)'
[[ $dir =~ ^[a-zA-Z0-9_/.-]+$ && $dir != -* && $dir != / && $dir != . && $dir != *..* ]] || die 'Invalid LICHTCHIP_REMOTE_DIR'
[[ $port =~ ^[0-9]{1,5}$ ]] && ((10#$port >= 1024 && 10#$port <= 65535)) || die 'Invalid port (1024..65535)'
page=$1; png=$2; seconds=${3:-180}; viewport=${4:-1500x950}
[[ $page =~ ^(index.html|probe/index.html)(\?[^[:space:]\'\"\`\\]*)?$ ]] || die 'Invalid page'
[[ $png =~ ^[a-zA-Z0-9][a-zA-Z0-9_.-]*\.png$ ]] || die 'Invalid screenshot filename'
[[ $seconds =~ ^[0-9]{1,4}$ ]] && ((10#$seconds >= 1 && 10#$seconds <= 3600)) || die 'Invalid timeout (1..3600)'
[[ $viewport =~ ^([0-9]{3,4})x([0-9]{3,4})(@([123](\.[0-9])?))?$ ]] || die 'Invalid viewport'
((10#${BASH_REMATCH[1]} >= 320 && 10#${BASH_REMATCH[1]} <= 3840 && 10#${BASH_REMATCH[2]} >= 320 && 10#${BASH_REMATCH[2]} <= 2160)) || die 'Viewport outside 320..3840 x 320..2160'
seconds=$((10#$seconds)); port=$((10#$port))
rsync -a --delete --exclude remote.env -- sim tools "$remote:$dir/"
# Pass positional arguments to an explicit Bash script; all shell data is quoted.
printf -v command 'bash -s -- %q %q %q %q %q %q' "$dir" "$port" "$page" "$png" "$seconds" "$viewport"
rc=0
ssh -- "$remote" "$command" <<'REMOTE' || rc=$?
set -euo pipefail
cd -- "$1"
timeout "$(($5 + 30))" python3 -m http.server "$2" --bind localhost >/dev/null 2>&1 &
server=$!
trap 'kill "$server" 2>/dev/null || true' EXIT
sleep 1
timeout "$(($5 + 20))" nice -n 10 venv/bin/python tools/run_page.py "http://localhost:$2/sim/$3" "$4" "$5" "$6"
REMOTE
mkdir -p shots
scp -q -- "$remote:$dir/$png" "shots/$png" || { ((rc != 0)) || rc=1; }
exit "$rc"
