#!/bin/sh
# Install or update Ender Studio on the Pi from its git checkout.
#
# First time (on the Pi):
#   git clone https://github.com/SnorbWorks/ender3-pi ~/ender3-pi
#   sh ~/ender3-pi/studio/deploy/install.sh
#
# Updates: studio/server/updater.py pulls the new commits, then runs a copy
# of this script with REPO=<checkout> and PREV=<commit before the pull>.
# If Ender Studio or Klipper doesn't come back, it resets to PREV and
# installs that again.  The outcome goes to ~/printer_data/studio_update.json.
#
# Only things that changed are copied/restarted, so running it twice is safe.

REPO=${REPO:-$(cd "$(dirname "$0")/../.." && pwd)}
PREV=${PREV:-}
D=$REPO/studio/deploy
CFG=$HOME/printer_data/config
RESULT=$HOME/printer_data/studio_update.json
MR=http://127.0.0.1:7125
KLIPPY=$HOME/klipper/klippy/extras

changed() { ! cmp -s "$1" "$2"; }      # changed <new> <installed>

apply() {
  KLIPPER=none
  # nginx serves ~/studio/web and the service runs ~/studio/server, so
  # ~/studio points into the checkout (an older copied-in folder is kept).
  if [ -d "$HOME/studio" ] && [ ! -L "$HOME/studio" ]; then
    mv "$HOME/studio" "$HOME/studio.old-$(date +%Y%m%d-%H%M%S)"
  fi
  ln -sfn "$REPO/studio" "$HOME/studio"

  # Klipper macros + the include that loads them
  if changed "$D/studio_macros.cfg" "$CFG/studio_macros.cfg"; then
    cp "$D/studio_macros.cfg" "$CFG/studio_macros.cfg"; KLIPPER=reload
  fi
  if ! grep -q "^\[include studio_macros.cfg\]" "$CFG/printer.cfg"; then
    sed -i "0,/^\[include mainsail.cfg\]/s//[include mainsail.cfg]\n[include studio_macros.cfg]/" "$CFG/printer.cfg"
    KLIPPER=reload
  fi
  # Z guard (Klipper extra: a Python module, so Klipper itself restarts)
  if [ -d "$KLIPPY" ] && changed "$REPO/klipper_extras/z_guard.py" "$KLIPPY/z_guard.py"; then
    cp "$REPO/klipper_extras/z_guard.py" "$KLIPPY/z_guard.py"; KLIPPER=restart
  fi

  # Moonraker's print queue (used by the "Queue" buttons)
  if ! grep -q "^\[job_queue\]" "$CFG/moonraker.conf"; then
    printf "\n[job_queue]\nload_on_startup: False\nautomatic_transition: False\n" >> "$CFG/moonraker.conf"
    sudo systemctl restart moonraker
  fi

  # The helper service
  if changed "$D/ender-studio.service" /etc/systemd/system/ender-studio.service; then
    sudo cp "$D/ender-studio.service" /etc/systemd/system/
    sudo systemctl daemon-reload
    sudo systemctl enable ender-studio
  fi

  # nginx: Ender Studio on port 80, Mainsail kept on 8080 as a fallback
  NGINX=no
  if grep -q "listen 80 default_server;" /etc/nginx/sites-available/mainsail 2>/dev/null; then
    sudo sed -i "s/listen 80 default_server;/listen 8080;/; s/listen \[::\]:80 default_server;/listen [::]:8080;/" /etc/nginx/sites-available/mainsail
    NGINX=yes
  fi
  if changed "$D/nginx-studio.conf" /etc/nginx/sites-available/studio; then
    sudo cp "$D/nginx-studio.conf" /etc/nginx/sites-available/studio
    NGINX=yes
  fi
  if [ ! -L /etc/nginx/sites-enabled/studio ]; then
    sudo ln -sf /etc/nginx/sites-available/studio /etc/nginx/sites-enabled/studio
    NGINX=yes
  fi
  if [ $NGINX = yes ]; then sudo nginx -t && sudo systemctl reload nginx; fi

  sudo systemctl restart ender-studio
  case $KLIPPER in
    restart) sudo systemctl restart klipper ;;
    reload)  curl -s -X POST $MR/printer/restart >/dev/null ;;
  esac
}

# 0 = Ender Studio answers and Klipper (if restarted) loaded its config.
verify() {
  i=0
  until curl -sf http://127.0.0.1:8091/studio-api/update >/dev/null; do
    i=$((i + 1)); [ $i -ge 30 ] && { WHY="Ender Studio didn't start"; return 1; }
    sleep 1
  done
  [ $KLIPPER = none ] && return 0
  # Wait for Klipper to finish starting.  A printer that's switched off
  # ("mcu ... Unable to connect") isn't the update's fault.
  i=0
  while :; do
    INFO=$(curl -s $MR/printer/info)
    STATE=$(printf '%s' "$INFO" | python3 -c 'import json,sys
try: r=json.load(sys.stdin)["result"]; print(r["state"]); print(r.get("state_message","").splitlines()[0] if r.get("state_message") else "")
except Exception: print("unknown")')
    case $STATE in
      ready*) return 0 ;;
      error*)
        case $STATE in *mcu*|*"Unable to connect"*) return 0 ;; esac
        WHY="Klipper config error: $(printf '%s' "$STATE" | sed -n 2p)"; return 1 ;;
    esac
    i=$((i + 1)); [ $i -ge 60 ] && return 0     # still starting: leave it
    sleep 1
  done
}

# result <ok|rolled_back|failed> <message> [bad commit]
# The updater won't install a "bad" commit again on its own.
result() {
  python3 - "$1" "$2" "$(git -C "$REPO" rev-parse --short HEAD)" "${3:-}" "$RESULT" <<'PY'
import json, sys, time
res, msg, sha, bad, path = sys.argv[1:6]
json.dump({"result": res, "message": msg, "sha": sha, "bad": bad,
           "time": time.strftime("%Y-%m-%dT%H:%M:%S%z")}, open(path, "w"))
PY
}

main() {
  echo "install: $(git -C "$REPO" log -1 --format='%h %s')"
  WHY=""
  apply
  if verify; then
    result ok "Installed"; echo "install: ok"; return 0
  fi
  echo "install: FAILED - $WHY"
  if [ -n "$PREV" ]; then
    BAD=$(git -C "$REPO" rev-parse HEAD)
    FIRST=$WHY
    git -C "$REPO" reset --hard --quiet "$PREV"
    echo "install: rolling back to $(git -C "$REPO" log -1 --format='%h %s')"
    apply
    if verify; then result rolled_back "The update didn't work ($FIRST), so it went back to the previous version" "$BAD"
    else result failed "The update didn't work ($FIRST) and going back failed too ($WHY)" "$BAD"; fi
  else
    result failed "$WHY"
  fi
  return 1
}

main "$@"; RC=$?
case $0 in */ender-studio-install-*.sh) rm -f "$0" ;; esac    # the updater's temp copy
exit $RC
