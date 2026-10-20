#!/bin/sh
set -eu
# Read one explicit Docker secret. Never echo values or fall back to an owner's credential.
read_secret() {
  test -f "$2" && test -r "$2" || { echo "Required secret unavailable: $1" >&2; exit 78; }
  secret_value=$(cat "$2")
  test -n "$secret_value" || { echo "Required secret empty: $1" >&2; exit 78; }
  export "$1=$secret_value"
  unset secret_value
}
case "${1:-runtime}" in
 runtime)
  test ! -e /run/secrets/migration_password || { echo 'Migration credential must not be mounted in runtime' >&2; exit 78; }
  test -z "${JXC_MIGRATION_PASSWORD:-}" || { echo 'Migration credential must not be set in runtime' >&2; exit 78; }
  read_secret JXC_DB_PASSWORD /run/secrets/runtime_password
  read_secret JXC_BANK_ENCRYPTION_KEY /run/secrets/bank_key
  read_secret JXC_STORAGE_ACCESS_KEY /run/secrets/storage_access_key
  read_secret JXC_STORAGE_SECRET_KEY /run/secrets/storage_secret_key
  exec java -XX:MaxRAMPercentage=70 -XX:+ExitOnOutOfMemoryError -jar /app/app.jar --spring.profiles.active=production --spring.flyway.enabled=false
  ;;
 migrate)
  test ! -e /run/secrets/runtime_password || { echo 'Runtime credential must not be mounted in migrator' >&2; exit 78; }
  read_secret JXC_MIGRATION_PASSWORD /run/secrets/migration_password
  exec java -Dloader.main=com.hs.jxc.migration.MigrationMain -cp /app/app.jar org.springframework.boot.loader.launch.PropertiesLauncher
  ;;
 *) echo 'Only runtime or migrate is supported' >&2; exit 64 ;;
esac
