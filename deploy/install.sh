#!/bin/sh
# Run on the Pi after syncing ~/studio:  sh ~/studio/deploy/install.sh
set -e
D=$(dirname "$0")
CFG=~/printer_data/config
cp "$D/studio_macros.cfg" $CFG/studio_macros.cfg
grep -q "^\[include studio_macros.cfg\]" $CFG/printer.cfg || \
  sed -i "0,/^\[include mainsail.cfg\]/s//[include mainsail.cfg]\n[include studio_macros.cfg]/" $CFG/printer.cfg
# Moonraker's print queue (used by the "Queue" buttons).
grep -q "^\[job_queue\]" $CFG/moonraker.conf || \
  printf "\n[job_queue]\nload_on_startup: False\nautomatic_transition: False\n" >> $CFG/moonraker.conf
sudo cp "$D/ender-studio.service" /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now ender-studio
sudo systemctl restart ender-studio
# Mainsail stays available as a fallback on port 8080.
sudo sed -i "s/listen 80 default_server;/listen 8080;/; s/listen \[::\]:80 default_server;/listen [::]:8080;/" /etc/nginx/sites-available/mainsail
sudo cp "$D/nginx-studio.conf" /etc/nginx/sites-available/studio
sudo ln -sf /etc/nginx/sites-available/studio /etc/nginx/sites-enabled/studio
sudo nginx -t && sudo systemctl reload nginx
sudo systemctl restart moonraker
echo "Ender Studio installed"
