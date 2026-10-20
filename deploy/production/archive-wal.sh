#!/bin/sh
# PostgreSQL invokes this with %p and %f. /archive must be an independently retained mount.
set -eu
umask 077
source_file=$1
wal_name=$2
archive_root=${3:-/archive}
printf '%s' "$wal_name" | LC_ALL=C grep -Eq '^([0-9A-F]{24}|[0-9A-F]{8}\.history|[0-9A-F]{24}\.[0-9A-F]{8}\.backup)$' || exit 64
test -f "$source_file" && test -d "$archive_root" || exit 65
if test -e "$archive_root/$wal_name"; then
  cmp -s "$source_file" "$archive_root/$wal_name"
  exit $?
fi
archive_temp="$archive_root/.incoming-$wal_name-$$"
trap 'rm -f "$archive_temp"' EXIT HUP INT TERM
cp "$source_file" "$archive_temp"
chmod 600 "$archive_temp"
sync
mv -n "$archive_temp" "$archive_root/$wal_name"
cmp -s "$source_file" "$archive_root/$wal_name"
