#!/bin/sh
set -eu
# Deliberately offline: no Maven, download, Docker startup, env sourcing or implicit database target.
if [ "$#" -ne 0 ]; then printf '%s\n' 'No arguments accepted; configure the explicit secret file through the environment.' >&2; exit 2; fi
: "${JXC_DB_URL:?Set the exact authorized JDBC target explicitly}"
: "${JXC_DB_USER:?Set the non-owner runtime database role explicitly}"
: "${JXC_BOOTSTRAP_CONFIG_FILE:?Set the owned regular 0600 operator JSON path}"
: "${JXC_APP_JAR:?Set the already built executable application jar path}"
if [ ! -f "$JXC_APP_JAR" ]; then printf '%s\n' 'Build artifact does not exist; build explicitly before offline bootstrap.' >&2; exit 2; fi
export SPRING_PROFILES_ACTIVE=bootstrap
export SPRING_MAIN_WEB_APPLICATION_TYPE=none
export SPRING_FLYWAY_ENABLED=false
export SPRING_MAIN_BANNER_MODE=off
# Bind the explicit target even if this shell inherited a different Spring datasource.
export SPRING_DATASOURCE_URL="$JXC_DB_URL"
export SPRING_DATASOURCE_USERNAME="$JXC_DB_USER"
export SPRING_DATASOURCE_PASSWORD="${JXC_DB_PASSWORD:-}"
exec java -jar "$JXC_APP_JAR"
