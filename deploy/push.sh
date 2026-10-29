#!/bin/sh
# From the Mac: copy Ender Studio to the Pi and reload what changed.
#   sh studio/deploy/push.sh
set -e
HERE=$(cd "$(dirname "$0")/.." && pwd)
SSH="ssh -i $HOME/.ssh/sidecar_ed25519 -o BatchMode=yes -o LogLevel=ERROR"
PI=admin@raspberrypi-1.local
rsync -a --delete -e "$SSH" "$HERE/" $PI:studio/
$SSH $PI 'set -e
  CFG=~/printer_data/config
  if ! cmp -s ~/studio/deploy/studio_macros.cfg $CFG/studio_macros.cfg; then
    cp ~/studio/deploy/studio_macros.cfg $CFG/studio_macros.cfg
    echo "macros changed - reloading Klipper config"
    curl -s -X POST localhost:7125/printer/restart >/dev/null || true
  fi
  sudo systemctl restart ender-studio
  echo deployed'
