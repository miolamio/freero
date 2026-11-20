#!/usr/bin/env sh
# Freero database backup: a compressed, consistent pg_dump (custom format) with retention,
# optionally encrypted to a public key before it leaves the machine.
#
#   DATABASE_URL=postgres://user:pass@host:5432/freero scripts/backup.sh [backup-dir]
#
# Environment:
#   DATABASE_URL          required. The database to dump.
#   BACKUP_DIR            where dumps go (default: ./backups, or the first argument)
#   BACKUP_KEEP_DAYS      delete dumps older than this many days (default 14; 0 keeps everything)
#   BACKUP_S3_URI         optional, e.g. s3://my-backups/freero/ — upload each dump with the aws CLI
#                         (any S3-compatible target: set AWS_ENDPOINT_URL for MinIO/R2/B2)
#   BACKUP_GPG_RECIPIENT  optional: encrypt each dump to this GnuPG key (id, fingerprint or email;
#                         its PUBLIC key must be in the keyring) → freero-<stamp>.dump.gpg
#   BACKUP_AGE_RECIPIENT  optional, instead: encrypt with age to this recipient (age1… or an ssh
#                         public key) → freero-<stamp>.dump.age
#   PG_DUMP               pg_dump binary (default: pg_dump). Its major version must be >= the server's.
#                         Without a local client, run it from the official image, e.g.
#                         PG_DUMP="docker run --rm --network host -e PGPASSWORD postgres:17-alpine pg_dump"
#   PG_RESTORE            pg_restore binary used to check each dump (default: pg_restore); the dump is
#                         sent to its stdin. Without it the backup is still made, but a warning says it
#                         was NOT verified. Without a local client:
#                         PG_RESTORE="docker run --rm -i postgres:17-alpine pg_restore"
#                         When pg_restore runs and cannot read the dump, the script fails and removes it.
#
# The password in DATABASE_URL is passed to pg_dump as PGPASSWORD, not on its command line, so it
# is not visible in `ps`. (A password given as a ?password= query parameter is not handled: put it
# in the URL's user:password part or in PGPASSWORD.)
#
# With a recipient set, only the encrypted file is kept or uploaded: the plain dump exists only
# while it is checked (owner-only permissions) and is deleted right after encrypting. The private
# key never needs to be on this machine; keep it offline and test a restore with it
# (docs/operations.md#restore, "Encrypted dumps").
#
# Restore: docs/operations.md#restore. Uploaded files live in object storage: protect them with
# bucket versioning (+ replication), not with this script.
set -eu

: "${DATABASE_URL:?DATABASE_URL is required}"
BACKUP_DIR="${1:-${BACKUP_DIR:-./backups}}"
KEEP_DAYS="${BACKUP_KEEP_DAYS:-14}"
PG_DUMP="${PG_DUMP:-pg_dump}"
PG_RESTORE="${PG_RESTORE:-pg_restore}"
GPG_TO="${BACKUP_GPG_RECIPIENT:-}"
AGE_TO="${BACKUP_AGE_RECIPIENT:-}"

if [ -n "$GPG_TO" ] && [ -n "$AGE_TO" ]; then
  echo "backup: set BACKUP_GPG_RECIPIENT or BACKUP_AGE_RECIPIENT, not both" >&2
  exit 2
fi
# Whether the dump can be checked afterwards. A host without pg_restore still gets its backup.
# shellcheck disable=SC2086 # PG_RESTORE may be a command with arguments
set -- $PG_RESTORE
can_verify=1
command -v "$1" >/dev/null 2>&1 || can_verify=0
# Fail before dumping when the encryption tool or key is missing: never fall back to plain text.
if [ -n "$GPG_TO" ]; then
  command -v gpg >/dev/null 2>&1 || { echo "backup: BACKUP_GPG_RECIPIENT is set but gpg is not installed" >&2; exit 2; }
  gpg --batch --list-keys "$GPG_TO" >/dev/null 2>&1 || { echo "backup: no public key for BACKUP_GPG_RECIPIENT in the keyring (gpg --import it first)" >&2; exit 2; }
fi
if [ -n "$AGE_TO" ]; then
  command -v age >/dev/null 2>&1 || { echo "backup: BACKUP_AGE_RECIPIENT is set but age is not installed" >&2; exit 2; }
fi

# Dumps hold every account and board: readable by this user only.
umask 077
mkdir -p "$BACKUP_DIR"
stamp="$(date -u +%Y%m%dT%H%M%SZ)"
file="$BACKUP_DIR/freero-$stamp.dump"
tmp="$file.partial"

# Whatever the run leaves half-done is removed when it fails: a partial or unchecked dump must never
# sit among the backups, and with a recipient set the plain dump never outlives a failed encryption.
stage=dump
cleanup() {
  status=$?
  if [ "$status" -ne 0 ]; then
    rm -f "$tmp"
    case "$stage" in
      check) rm -f "$file" ;;
      encrypt) rm -f "$file" "$file.gpg" "$file.age" ;;
    esac
    echo "backup: FAILED (exit $status)" >&2
  fi
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

# Keep the password out of pg_dump's arguments (`ps` shows those to every user): hand it over as
# PGPASSWORD, percent-decoded, and dump from the URL without it.
urldecode() {
  printf '%s' "$1" | awk 'BEGIN { for (i = 0; i < 256; i++) h[sprintf("%02X", i)] = sprintf("%c", i) }
    { s = $0; out = ""
      while ((m = index(s, "%")) > 0) {
        hex = toupper(substr(s, m + 1, 2))
        if (hex in h) { out = out substr(s, 1, m - 1) h[hex]; s = substr(s, m + 3) }
        else { out = out substr(s, 1, m); s = substr(s, m + 1) }
      }
      printf "%s", out s }'
}
dump_url="$DATABASE_URL"
if printf '%s' "$DATABASE_URL" | grep -Eq '^postgres(ql)?://[^:@/]*:[^@/]*@'; then
  PGPASSWORD="$(urldecode "$(printf '%s' "$DATABASE_URL" | sed -E 's#^postgres(ql)?://[^:@/]*:([^@/]*)@.*#\2#')")"
  export PGPASSWORD
  dump_url="$(printf '%s' "$DATABASE_URL" | sed -E 's#^(postgres(ql)?://[^:@/]*):[^@/]*@#\1@#')"
fi

echo "backup: dumping to $file"
# --format=custom: compressed, restorable selectively and in parallel with pg_restore.
# --no-owner/--no-privileges: restorable into a database with a different owner/role setup.
# shellcheck disable=SC2086 # PG_DUMP may be a command with arguments
$PG_DUMP --format=custom --compress=6 --no-owner --no-privileges --dbname="$dump_url" > "$tmp"
mv "$tmp" "$file"

# A dump that pg_restore cannot list is not a backup (set -e stops here, and cleanup removes it).
stage=check
if [ "$can_verify" = 1 ]; then
  # shellcheck disable=SC2086 # PG_RESTORE may be a command with arguments
  $PG_RESTORE --list < "$file" >/dev/null
else
  {
    echo "backup: WARNING: $file was NOT verified: pg_restore is not installed here, so nobody has checked"
    echo "backup: that the archive can be read back. Install the PostgreSQL client tools, or set PG_RESTORE"
    echo "backup: (e.g. PG_RESTORE=\"docker run --rm -i postgres:17-alpine pg_restore\"), and test a restore."
  } >&2
fi
stage=encrypt
size="$(wc -c < "$file" | tr -d ' ')"
if [ "$can_verify" = 1 ]; then echo "backup: ok ($size bytes, verified)"; else echo "backup: done ($size bytes, NOT verified)"; fi

if [ -n "$GPG_TO" ]; then
  gpg --batch --yes --trust-model always --encrypt --recipient "$GPG_TO" --output "$file.gpg" "$file"
  rm -f "$file"
  file="$file.gpg"
  echo "backup: encrypted to $GPG_TO ($file)"
elif [ -n "$AGE_TO" ]; then
  age --encrypt --recipient "$AGE_TO" --output "$file.age" "$file"
  rm -f "$file"
  file="$file.age"
  echo "backup: encrypted with age ($file)"
fi

stage=finished

if [ -n "${BACKUP_S3_URI:-}" ]; then
  echo "backup: uploading to $BACKUP_S3_URI"
  aws s3 cp "$file" "${BACKUP_S3_URI%/}/$(basename "$file")"
fi

if [ "$KEEP_DAYS" -gt 0 ] 2>/dev/null; then
  find "$BACKUP_DIR" -maxdepth 1 \( -name 'freero-*.dump' -o -name 'freero-*.dump.gpg' -o -name 'freero-*.dump.age' \) -type f -mtime +"$KEEP_DAYS" -print -delete |
    sed 's/^/backup: pruned /'
fi
