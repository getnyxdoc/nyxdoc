#!/bin/sh
set -eu

ensure_node_directory() {
  target="$1"

  if [ -z "$target" ]; then
    return
  fi

  mkdir -p "$target"

  owner="$(stat -c '%u:%g' "$target")"
  if [ "$owner" != '1000:1000' ]; then
    chown node:node "$target"
  fi
}

if [ "$(id -u)" = '0' ]; then
  database_path="${NYXDOC_DB_PATH:-/data/nyxdoc.db}"
  database_directory="$(dirname "$database_path")"
  media_root="${NYXDOC_MEDIA_ROOT:-/data/media}"
  backup_root="${NYXDOC_BACKUP_ROOT:-/data/backups}"

  ensure_node_directory "$database_directory"
  ensure_node_directory "$media_root"
  ensure_node_directory "$backup_root"

  for database_file in "$database_path" "$database_path-wal" "$database_path-shm"; do
    if [ -f "$database_file" ]; then
      owner="$(stat -c '%u:%g' "$database_file")"
      if [ "$owner" != '1000:1000' ]; then
        chown node:node "$database_file"
      fi
    fi
  done

  exec gosu node "$@"
fi

exec "$@"
