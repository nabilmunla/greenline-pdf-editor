#!/bin/bash
# Run e2e suites one after another; prints each suite's failures and summary only.
#   tests/run-suites.sh [suite ...]      (GCC_RENDERERS=4 to force 4 drawing engines)
#   tests/run-suites.sh stress           MuPDF references stress run (PLAN 10.19): npm test, fuzz-evil and
#                                        e2e-combine with a full garbage collection forced each time 50
#                                        more MuPDF calls were made, at the end of that task (PDFED_GC_EVERY,
#                                        mupdf-guard.ts; build first) - nothing may regress, 0 "memory
#                                        access out of bounds"
cd "$(dirname "$0")/.."
mkdir -p tests/out
if [ "$1" = stress ]; then
  export PDFED_GC_EVERY=${PDFED_GC_EVERY:-50}
  echo "=== npm test (gc every $PDFED_GC_EVERY MuPDF calls)"
  timeout 7200 npm test > tests/out/stress-unit.log 2>&1
  grep -E "^not ok|^# (pass|fail|cancelled)" tests/out/stress-unit.log | tail -12
  echo "=== fuzz-evil"
  timeout 1200 npx tsx tests/fuzz-evil.ts > tests/out/stress-fuzz-evil.log 2>&1; echo "  exit $?"
  tail -3 tests/out/stress-fuzz-evil.log
  echo "  out of bounds: $(cat tests/out/stress-unit.log tests/out/stress-fuzz-evil.log | grep -c 'out of bounds')"
  shift
  set -- e2e-combine "$@"
fi
SUITES=${@:-e2e e2e-view e2e-tabs e2e-windows e2e-export e2e-merge e2e-extract e2e-area e2e-insert e2e-bookmarks e2e-searchall e2e-pictures e2e-links e2e-comments e2e-undo e2e-annots e2e-draw e2e-print e2e-clip e2e-find e2e-textedge e2e-ai e2e-mt e2e-update e2e-update-notes e2e-reports e2e-fonts e2e-richtext e2e-spell e2e-measure e2e-measure085 e2e-measure-polish e2e-measure-aids e2e-labels-snapshot e2e-redraw e2e-aids-fixes e2e-snap-busy e2e-cont-tip e2e-bocr-restart e2e-4gb e2e-counttag e2e-update-web e2e-update-restore e2e-bridge e2e-journey e2e-audit e2e-share-reports e2e-sheets e2e-layers e2e-count e2e-saveas-temp e2e-layers-stress}
for t in $SUITES; do
  echo "=== $t"
  timeout 1200 xvfb-run -a -s "-screen 0 2000x1200x24" node tests/$t.mjs > tests/out/suite-$t.log 2>&1
  grep -E "FAIL|✗|PAGEERROR|Error:|passed|failed" tests/out/suite-$t.log | grep -v "^PASS" | tail -12
  grep -cE "^PASS|✓" tests/out/suite-$t.log | sed 's/^/  checks passed: /'
done
