#!/usr/bin/env bash
# ============================================================
# FUSION ONE — canonical build: application data restore
# ============================================================
# Restores application data from a verified pg_dump -Fc backup into
# a database whose schema was just built by database/production/*.sql.
#
# WHY per-table ordered restore: this database's data-only dumps are
# emitted in table-name order (pg_dump falls back to alphabetical
# ordering because inventory_items carries a self-referential FK).
# Restoring in dump order would violate foreign keys, and the usual
# --disable-triggers workaround requires superuser (Supabase's
# postgres role is not superuser). This script therefore restores
# each table's data in the explicit dependency order below, with
# every FK constraint live — a restore that succeeds has proven all
# relationships hold.
#
# NOTE: pg_restore -t takes the bare TABLE NAME (schema-qualified
# patterns silently match nothing in this pg_restore generation);
# the dump is public-schema-only, so bare names are unambiguous.
#
# USAGE
#   ./restore-data.sh <DB_URL> <APP_DUMP>
#     DB_URL    postgresql://... target database (schema already built)
#     APP_DUMP  path to the application-scoped pg_dump -Fc backup
#
# SAFETY GUARDS (the script refuses to run unless ALL pass)
#   1. The target's public schema contains the canonical build
#      (schema_migrations exists).
#   2. Every business table is EMPTY (no destructive overwrite of
#      live data, ever).
#   3. Every table restores EXACTLY the number of rows present in
#      the backup (parsed from the dump itself) — a silent no-op
#      cannot pass.
#   4. Auth-anchored rows (public.users) reference existing
#      auth.users identities — Supabase Auth users are NEVER
#      created, modified or restored by this script.
#
# schema_migrations is deliberately NOT restored from the backup:
# the canonical build owns it (12_migration_bookkeeping.sql).
# ============================================================
set -euo pipefail

DB_URL="${1:?usage: restore-data.sh <DB_URL> <APP_DUMP>}"
APP_DUMP="${2:?usage: restore-data.sh <DB_URL> <APP_DUMP>}"

# Dependency-ordered restore list (parents first). Derived from the
# live FK graph; message_jobs/reminder_settings last (they reference
# payments/sales/purchases/proformas). party_documents sits after
# parties (its only dependency): a backup from a pre-0016 schema has
# no data block for it — the expected count then defaults to 0, which
# is the correct restore for that state.
TABLES=(
  financial_years
  bank_accounts
  payment_modes
  parties
  party_documents
  users
  store
  whatsapp_settings
  inventory_items
  proforma_invoices
  purchases
  sales
  purchase_items
  sale_items
  proforma_invoice_items
  proforma_trade_ins
  trade_ins
  payments_in
  payments_out
  account_fund_entries
  account_transactions
  account_transfers
  message_jobs
  reminder_settings
)

# Tables whose COPY block may reference LATER rows of the SAME table
# (self-referential FK in non-insertion order — the reason pg_dump
# emits this database's data-only dumps alphabetically with a
# circular-dependency warning). For these, the self-FK is dropped
# before the COPY and re-added (with full validation) after it:
# the re-added constraint PROVES the restored references are sound.
SELF_REF_FKS=(
  "inventory_items|inventory_items_origin_inventory_item_id_fkey|FOREIGN KEY (origin_inventory_item_id) REFERENCES public.inventory_items(id)"
)
selfref_entry_for() {
  for entry in "${SELF_REF_FKS[@]}"; do
    [ "$(echo "$entry" | cut -d'|' -f1)" = "$1" ] && { echo "$entry"; return; }
  done
  echo ""
}

echo "[restore-data] target: ${DB_URL%%@*}@***"
echo "[restore-data] backup: ${APP_DUMP}"

# ── Expected row counts, parsed from the dump itself ────────────────────────
# (COPY ... FROM stdin blocks; data lines until the \. terminator)
declare -A EXPECTED
while read -r tbl n; do
  EXPECTED["$tbl"]="$n"
done < <(pg_restore --data-only -f - "$APP_DUMP" | awk '
  /^COPY public\./ {
    tbl = $2
    sub(/^public\./, "", tbl)
    intable = 1
    next
  }
  intable && /^\\\.$/ { intable = 0; next }
  intable { count[tbl]++ }
  END { for (t in count) printf "%s %d\n", t, count[t] }
')

for t in "${TABLES[@]}"; do
  # Tables absent from the backup's schema default to zero expected
  # rows (the correct restore for a backup taken before the table
  # existed — e.g. party_documents on a pre-0016 backup).
  EXPECTED["$t"]="${EXPECTED[$t]:-0}"
done
echo "[restore-data] expected rows parsed from backup: ${#EXPECTED[@]} tables"

# Extra business tables found in the backup but not in the canonical
# list (should not happen for known schemas — restored AFTER the main
# list with a loud warning so no data can silently disappear).
EXTRAS=()
for tbl in "${!EXPECTED[@]}"; do
  case " ${TABLES[*]} " in
    *" $tbl "*) ;;
    *) [ "$tbl" != "schema_migrations" ] && EXTRAS+=("$tbl") ;;
  esac
done
if [ "${#EXTRAS[@]}" -gt 0 ]; then
  echo "[restore-data] WARNING: unexpected extra tables in backup (restoring after the canonical list): ${EXTRAS[*]}" >&2
  for t in "${EXTRAS[@]}"; do
    TABLES+=("$t")
    EXPECTED["$t"]="${EXPECTED[$t]:-0}"
  done
fi

# ── Guard 1: canonical build present ────────────────────────────────────────
if ! psql "$DB_URL" -X -Atc "SELECT 1 FROM information_schema.tables
       WHERE table_schema='public' AND table_name='schema_migrations'" | grep -q 1; then
  echo "ABORT: canonical schema not built (public.schema_migrations missing). Build database/production/*.sql first." >&2
  exit 1
fi

# ── Guard 2: all business tables empty ──────────────────────────────────────
for t in "${TABLES[@]}"; do
  n=$(psql "$DB_URL" -X -Atc "SELECT count(*) FROM public.\"$t\"")
  if [ "$n" != "0" ]; then
    echo "ABORT: public.$t is not empty ($n rows) — refusing to overwrite live data." >&2
    exit 1
  fi
done
echo "[restore-data] guard passed: all ${#TABLES[@]} business tables are empty"

# ── Restore each table's data, in dependency order, verified ────────────────
for t in "${TABLES[@]}"; do
  selffk=$(selfref_entry_for "$t")
  if [ -n "$selffk" ]; then
    psql "$DB_URL" -X -q -c "ALTER TABLE public.\"$t\" DROP CONSTRAINT \"$(echo "$selffk" | cut -d'|' -f2)\";"
  fi
  pg_restore -d "$DB_URL" --data-only --table="$t" --exit-on-error "$APP_DUMP"
  if [ -n "$selffk" ]; then
    psql "$DB_URL" -X -q -c "ALTER TABLE public.\"$t\" ADD CONSTRAINT \"$(echo "$selffk" | cut -d'|' -f2)\" $(echo "$selffk" | cut -d'|' -f3);"
  fi
  n=$(psql "$DB_URL" -X -Atc "SELECT count(*) FROM public.\"$t\"")
  if [ "$n" != "${EXPECTED[$t]}" ]; then
    echo "ABORT: public.$t restored $n rows but the backup holds ${EXPECTED[$t]}." >&2
    exit 1
  fi
  echo "[restore-data] restored $t: $n rows"
done

# ── Guard 4: auth anchoring of public.users ─────────────────────────────────
orphans=$(psql "$DB_URL" -X -Atc "SELECT count(*) FROM public.users u
       WHERE NOT EXISTS (SELECT 1 FROM auth.users a WHERE a.id = u.id)")
if [ "$orphans" != "0" ]; then
  echo "ABORT: $orphans public.users rows have no auth.users identity — auth users are never created by this script; they must already exist on the target." >&2
  exit 1
fi
echo "[restore-data] guard passed: every public.users row is anchored to an existing auth identity"

echo "[restore-data] DONE — run the post-restore verification (see README.md)."
