#!/bin/bash
set -uo pipefail
TASK="$1"; COND="$2"; WF="${3:-}"
MODEL="${MODEL:-claude-haiku-4-5}"; LOGSUF="${LOGSUF:-}"
TBDIR="$HOME/dev/benchmarks-mono/terminal-bench"; TDIR="$TBDIR/$TASK"
IMG="tb_$(echo -n "$TASK" | tr -c 'a-z0-9' _)"
t0=$(date +%s)
if ! docker image inspect "$IMG" >/dev/null 2>&1; then
  LOCK="/tmp/tbbl_$IMG"
  until mkdir "$LOCK" 2>/dev/null; do sleep 2; docker image inspect "$IMG" >/dev/null 2>&1 && break; done
  docker image inspect "$IMG" >/dev/null 2>&1 || docker build -t "$IMG" "$TDIR/environment" >"/tmp/tb_build_$IMG.log" 2>&1
  rmdir "$LOCK" 2>/dev/null
fi
docker image inspect "$IMG" >/dev/null 2>&1 || { echo "RESULT $TASK $COND reward=BUILDFAIL secs=0"; exit 0; }
CID=$(docker run -d "$IMG" sleep infinity 2>/dev/null) || { echo "RESULT $TASK $COND reward=RUNFAIL secs=0"; exit 0; }
WORKDIR=$(docker exec "$CID" pwd 2>/dev/null); [ -z "$WORKDIR" ] && WORKDIR=/app
INSTR=$(cat "$TDIR/instruction.md")
PROMPT="You are an autonomous terminal agent solving a task inside a Docker container.
Container: $CID   Working directory: $WORKDIR
Run EVERY command in the task environment via:
  docker exec -w $WORKDIR $CID bash -lc '<command>'
Inspect, edit files, and complete the task. Do not ask questions; just do it. Stop when finished.

TASK:
$INSTR"
args=(-p "$PROMPT" --model "$MODEL" --allowedTools "Bash" --max-turns 50)
[ -n "$WF" ] && args+=(--append-system-prompt "$(cat "$WF")")
claude "${args[@]}" >"/tmp/tb_agent_${TASK}_${COND}${LOGSUF}.log" 2>&1
docker cp "$TDIR/tests" "$CID:/tests" >/dev/null 2>&1
docker exec "$CID" mkdir -p /logs/verifier >/dev/null 2>&1
docker exec "$CID" bash /tests/test.sh >"/tmp/tb_verify_${TASK}_${COND}${LOGSUF}.log" 2>&1
REWARD=$(docker exec "$CID" cat /logs/verifier/reward.txt 2>/dev/null | tr -d '[:space:]'); [ -z "$REWARD" ] && REWARD=0
docker rm -f "$CID" >/dev/null 2>&1
echo "RESULT $TASK $COND reward=$REWARD secs=$(( $(date +%s) - t0 ))"
