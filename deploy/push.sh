#!/bin/sh
# Publish an update from the Mac:  commit, then  sh studio/deploy/push.sh
#
# Pushes master to GitHub.  The Pi checks GitHub each time it starts up (once
# its services have settled) and installs when the printer is idle; if the
# Pi is on right now, this also asks it to install straight away.
set -e
cd "$(dirname "$0")/../.."
PI=${PI:-raspberrypi-1.local}
if [ -n "$(git status --porcelain --untracked-files=no)" ]; then
  echo "Commit your changes first:"; git status --short --untracked-files=no; exit 1
fi
git push origin master
# -4: the Pi's web server only listens on IPv4.
if ! curl -4 -s -m 5 "http://$PI/studio-api/update" >/dev/null 2>&1; then
  echo "Pushed. The Pi isn't reachable - it will update itself after it's switched on."
  exit 0
fi
curl -4 -s -m 120 -X POST "http://$PI/studio-api/update/check" >/dev/null
curl -4 -s -m 30 -X POST "http://$PI/studio-api/update/install" | python3 -c '
import json, sys
r = json.load(sys.stdin)
if r.get("error") and "version" not in r: print("Pushed. The Pi will install it later:", r["error"])
else: print("Pushed - the Pi is installing it now (Maintenance page shows the result).")'
