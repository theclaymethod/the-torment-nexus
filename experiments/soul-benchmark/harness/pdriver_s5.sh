#!/bin/bash
SCRATCH="/private/tmp/claude-501/-Users-clayton-dev/aabaf673-a0a6-4e71-8ace-9ac2856dcf11/scratchpad"
RES="$SCRATCH/results_s5.tsv"; LOG="$SCRATCH/matrix.log"; STOP="$SCRATCH/STOP_s5"; rm -f "$STOP"
touch "$RES"
: > "$SCRATCH/jobs_s5.txt"
while IFS= read -r task; do
  [ -z "$task" ] && continue
  for cond in C1_baseline C2_fresh C3_scarred; do
    wf=""; [ "$cond" = C2_fresh ]&&wf="$SCRATCH/profiles/C2-fresh.txt"; [ "$cond" = C3_scarred ]&&wf="$SCRATCH/profiles/C3-scarred.txt"
    grep -q "^RESULT $task $cond " "$RES" && continue
    echo "$task|$cond|$wf" >> "$SCRATCH/jobs_s5.txt"
  done
done < "$SCRATCH/tasklist.txt"
echo "[$(date +%H:%M:%S)] S5 PARALLEL(task-major) $(wc -l < "$SCRATCH/jobs_s5.txt") jobs, 6-wide, model=claude-sonnet-5" >> "$LOG"
worker() {
  STOP="$1/STOP_s5"; RES="$2"; spec="$3"
  [ -f "$STOP" ] && return
  task=${spec%%|*}; rest=${spec#*|}; cond=${rest%%|*}; wf=${rest#*|}
  out=$(MODEL=claude-sonnet-5 LOGSUF=_s5 bash "$1/tb_run.sh" "$task" "$cond" "$wf"); echo "$out" >> "$RES"
  lg="/tmp/tb_agent_${task}_${cond}_s5.log"
  [ -f "$lg" ] && grep -qiE 'usage limit|rate.?limit|reached your|overloaded|too many requests|quota' "$lg" && { echo "[$(date +%H:%M:%S)] QUOTA_HALT $task $cond" >> "$RES"; touch "$STOP"; }
}
export -f worker
cat "$SCRATCH/jobs_s5.txt" | xargs -P 6 -I{} bash -c 'worker "$@"' _ "$SCRATCH" "$RES" "{}"
echo "[$(date +%H:%M:%S)] S5 PARALLEL done: $(grep -c '^RESULT' "$RES")" >> "$LOG"
