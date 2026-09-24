#!/usr/bin/env bash
set -euo pipefail

if [[ "$(id -u)" -ne 0 ]]; then
  echo "Bibo backup must run as root" >&2
  exit 1
fi

umask 077
backup_dir=/var/backups/bibo-planet
data_dir=/var/lib/bibo-planet
gpg_home=/etc/bibo-planet/backup-gnupg
recipient=5F8E8F0ACD781073015DA60736B6237F21ECE2A9

install -d -m 700 "$backup_dir"
exec 9>/run/lock/bibo-planet-backup.lock
flock -n 9 || exit 0

if [[ "$(systemctl is-active bibo-planet)" != active ]]; then
  echo "Bibo is not active; refusing to back up an unknown state" >&2
  exit 1
fi
test -f "$data_dir/accounts.json"
test -f "$data_dir/spirits/mori/state.json"
test -f "$data_dir/spirits/piko/state.json"
test -f "$data_dir/spirits/sela/state.json"
gpg --homedir "$gpg_home" --list-keys "$recipient" >/dev/null

timestamp=$(date +%Y-%m-%d-%H%M%S)
archive=$(mktemp "$backup_dir/.archive.XXXXXXXX.tar.gz")
encrypted=$(mktemp "$backup_dir/daily-$timestamp.XXXXXXXX.tar.gz.gpg")
stopped=false
finished=false
cleanup() {
  if [[ "$stopped" == true ]]; then
    systemctl start bibo-planet || true
  fi
  rm -f -- "$archive"
  if [[ "$finished" != true ]]; then
    rm -f -- "$encrypted"
  fi
}
trap cleanup EXIT

systemctl stop bibo-planet
stopped=true
tar -C "$data_dir" -czf "$archive" accounts.json spirits
systemctl start bibo-planet
stopped=false

gpg --homedir "$gpg_home" --batch --yes --trust-model always \
  --recipient "$recipient" --output "$encrypted" --encrypt "$archive"
test -s "$encrypted"
chmod 600 "$encrypted"
finished=true
sha256sum "$encrypted"
/opt/bibo-ossutil/bin/ossutil cp "$encrypted" \
  "oss://bibo-planet-backups-peiiii-2026/daily/$(basename "$encrypted")" \
  --mode EcsRamRole --ecs-role-name BiboPlanetBackupRole \
  -e oss-cn-hangzhou-internal.aliyuncs.com
