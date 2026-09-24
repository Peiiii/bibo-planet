#!/usr/bin/env bash
set -euo pipefail

if [[ "$(id -u)" -ne 0 ]]; then
  echo "Install ossutil as root" >&2
  exit 1
fi

archive_sha=85edf66b2fb7238f5c7e25cab820cf29312319fe4935b7c86a6b8485eb434f3c
archive_url=https://gosspublic.alicdn.com/ossutil/v2/2.4.0/ossutil-2.4.0-linux-amd64.zip
work=$(mktemp -d /tmp/bibo-ossutil-v2.XXXXXXXX)
trap 'rm -r -- "$work"' EXIT

curl --fail --location --silent --show-error "$archive_url" -o "$work/ossutil.zip"
printf '%s  %s\n' "$archive_sha" "$work/ossutil.zip" | sha256sum --check --status
python3 -m zipfile -e "$work/ossutil.zip" "$work"
install -d -m 755 /opt/bibo-ossutil-v2/bin
install -m 755 "$work/ossutil-2.4.0-linux-amd64/ossutil" \
  /opt/bibo-ossutil-v2/bin/ossutil
/opt/bibo-ossutil-v2/bin/ossutil version
