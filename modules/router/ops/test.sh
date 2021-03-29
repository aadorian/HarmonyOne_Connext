#!/bin/bash
set -eE

if [[ -d "modules/router" ]]
then cd modules/router|| exit 1
fi

# Poke sqlite file
sqlite_file=${VECTOR_SQLITE_FILE:-/tmp/store.sqlite}
echo "Using SQLite store at $sqlite_file"
touch "$sqlite_file"
export VECTOR_DATABASE_URL="sqlite://$sqlite_file"

# Migrate db
prisma migrate deploy --preview-feature --schema prisma-sqlite/schema.prisma

# Launch tests
nyc ts-mocha --check-leaks --exit --timeout 60000 'src/**/*.spec.ts' "$@"
