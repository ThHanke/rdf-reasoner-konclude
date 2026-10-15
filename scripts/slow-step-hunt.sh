#!/usr/bin/env bash
# Loop 2-step Roberts runs; on a step slower than LIMIT s capture top + gdb thread dump, then stop.
cd /home/hanke/rdf-reasoner-konclude || exit 1
R=tests/fixtures/roberts-family.nt; LIMIT=110; OUT=/tmp/slowhunt
for i in $(seq 1 14); do
  D=$OUT/run$i; rm -rf $D; mkdir -p $D
  REPRO_HASH_SEED=5 REPRO_MEM=1 setarch -R ./build-native/konclude_repro --timeout 900 --out $D --seq "m:$R,m:$R" > $D/log 2>&1 &
  P=$!; t0=$(date +%s); last=$t0; seen=0
  echo "run $i pid $P start" >> $OUT/summary.txt
  while kill -0 $P 2>/dev/null; do
    sleep 5; now=$(date +%s)
    n=$(grep -cE "^    step [0-9]" $D/log); 
    if [ "$n" != "$seen" ]; then echo "run $i step $n done at $((now-t0))s (+$((now-last))s)" >> $OUT/summary.txt; seen=$n; last=$now; fi
    if [ $((now-last)) -gt $LIMIT ]; then
      echo "run $i SLOW: no step for $((now-last))s (steps done: $seen) - capturing" >> $OUT/summary.txt
      top -H -b -n1 -p $P | head -n 25 > $D/top.txt
      grep -E "MEM|POOLS" $D/log | tail -n 6 > $D/mem.txt; grep -c RMSG $D/log > $D/rmsg.txt
      timeout 150 gdb -p $P -batch -ex "thread apply all bt 12" > $D/gdb.txt 2>&1
      echo "run $i captured" >> $OUT/summary.txt
      kill $P; wait $P 2>/dev/null; echo "STOP slow run $i" >> $OUT/summary.txt; exit 0
    fi
  done
  wait $P; echo "run $i finished in $(( $(date +%s)-t0 ))s" >> $OUT/summary.txt
done
echo "no slow run in 14 runs" >> $OUT/summary.txt
