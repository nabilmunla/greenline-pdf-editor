#!/bin/sh
# stop test runs and app windows (patterns built so this script never matches itself)
P1="node tests/e2e"".mjs"; P2="electron/dist/elec""tron"
for p in $(pgrep -f "$P1"); do kill $p 2>/dev/null; done
for p in $(pgrep -f "$P2"); do kill $p 2>/dev/null; done
exit 0
