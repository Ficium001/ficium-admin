#!/usr/bin/env bash
# Apply pending migrations to one admin database, in order, each in its own
# transaction, recording a SHA-256 per file. Refuses to run if an applied
# file has since been edited (migrations are immutable: add a new file).
#
#   OPERATOR_URL=postgres://<operator>@<host>/postgres ./migrate.sh cluster
#   OPERATOR_URL=...                                  ./migrate.sh app_admin
#   OPERATOR_URL=...                                  ./migrate.sh portal_admin
set -euo pipefail
cd "$(dirname "$0")"
: "${OPERATOR_URL:?set OPERATOR_URL to the operator connection string (any database)}"
target="${1:?usage: migrate.sh cluster|app_admin|portal_admin}"
url_for() { python3 -c 'import sys,urllib.parse as u;p=u.urlsplit(sys.argv[1]);print(u.urlunsplit(p._replace(path="/"+sys.argv[2])))' "$OPERATOR_URL" "$1"; }
psql_() { psql "$1" -X -q -v ON_ERROR_STOP=1 "${@:2}"; }

if [[ "$target" == cluster ]]; then
  psql_ "$(url_for postgres)" --single-transaction -f cluster/0000_roles.sql
  for db in app_admin portal_admin; do
    if [[ -z "$(psql_ "$(url_for postgres)" -tAc "SELECT 1 FROM pg_database WHERE datname='$db'")" ]]; then
      psql_ "$(url_for postgres)" -c "CREATE DATABASE $db OWNER ${db}_owner"
    fi
  done
  echo "cluster ready"; exit 0
fi

[[ "$target" == app_admin || "$target" == portal_admin ]] || { echo "unknown target $target" >&2; exit 2; }
db_url="$(url_for "$target")"
has_ledger="$(psql_ "$db_url" -tAc "SELECT to_regclass('meta.schema_migration') IS NOT NULL")"

for f in "$target"/[0-9]*.sql; do
  v="$(basename "$f" .sql)"; sum="$(sha256sum "$f" | cut -c1-64)"
  if [[ "$has_ledger" == t ]]; then
    applied="$(psql_ "$db_url" -tAc "SELECT checksum FROM meta.schema_migration WHERE version='$v'")"
    if [[ -n "$applied" ]]; then
      [[ "$applied" == "$sum" ]] || { echo "CHECKSUM MISMATCH: $f was edited after being applied" >&2; exit 1; }
      continue
    fi
  fi
  echo "applying $target/$v"
  { cat "$f"; echo; echo "INSERT INTO meta.schema_migration (version, checksum) VALUES ('$v', '$sum');"; } \
    | psql_ "$db_url" --single-transaction
  has_ledger=t
done
echo "$target up to date"
