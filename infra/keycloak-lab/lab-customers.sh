#!/bin/sh
# Production Debugging Lab — creates the "lab customers" in Keycloak.
#
# Why: since the security work, every business API takes the user from the
# access token (user id = the token's "sub"). POST /lab/seed generates data for
# synthetic users whose ids come from LabIds (1ab5eed0-0000-0001-..., -0002-...).
# For that data to be reachable through the real APIs, a Keycloak user must exist
# with exactly the same id. This script creates lab-customer-0001..N with those
# ids, so logging in as lab-customer-0007 reads lab user #7's seeded statement.
#
# How: one Keycloak admin REST call, partialImport with ifResourceExists=SKIP.
# Users that already exist are left untouched, so running it again is safe.
# Keycloak's realm import keeps the ids given in the payload.
#
# Portable on purpose: plain sh + curl, configured only through environment
# variables, so the same file runs as a one-shot Docker Compose service today
# (docker-compose.lab.yml) and as a Kubernetes Job later (EKS), pointed at
# whichever Keycloak URL that environment uses.
#
#   KEYCLOAK_URL            base URL reachable from where this runs (default http://keycloak:8080)
#   KEYCLOAK_REALM          target realm (default spendwise)
#   KEYCLOAK_ADMIN_USER     admin user in the master realm (default admin)
#   KEYCLOAK_ADMIN_PASSWORD its password (default admin)
#   LAB_CUSTOMERS           how many lab customers to create (default 50, max 9999)
#   LAB_CUSTOMER_PASSWORD   password for every lab customer (default LabCustomer#2026,
#                           which satisfies the realm's password policy)
set -eu

KEYCLOAK_URL="${KEYCLOAK_URL:-http://keycloak:8080}"
KEYCLOAK_REALM="${KEYCLOAK_REALM:-spendwise}"
KEYCLOAK_ADMIN_USER="${KEYCLOAK_ADMIN_USER:-admin}"
KEYCLOAK_ADMIN_PASSWORD="${KEYCLOAK_ADMIN_PASSWORD:-admin}"
LAB_CUSTOMERS="${LAB_CUSTOMERS:-50}"
LAB_CUSTOMER_PASSWORD="${LAB_CUSTOMER_PASSWORD:-LabCustomer#2026}"

case "$LAB_CUSTOMERS" in
  ''|*[!0-9]*) echo "LAB_CUSTOMERS must be a number, got '$LAB_CUSTOMERS'" >&2; exit 1 ;;
esac
if [ "$LAB_CUSTOMERS" -lt 1 ] || [ "$LAB_CUSTOMERS" -gt 9999 ]; then
  echo "LAB_CUSTOMERS must be between 1 and 9999, got $LAB_CUSTOMERS" >&2
  exit 1
fi

work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT

echo "Getting an admin token from $KEYCLOAK_URL ..."
attempt=0
until curl -fs -o "$work/token.json" "$KEYCLOAK_URL/realms/master/protocol/openid-connect/token" \
    --data-urlencode "grant_type=password" \
    --data-urlencode "client_id=admin-cli" \
    --data-urlencode "username=$KEYCLOAK_ADMIN_USER" \
    --data-urlencode "password=$KEYCLOAK_ADMIN_PASSWORD"; do
  attempt=$((attempt + 1))
  if [ "$attempt" -gt 30 ]; then
    echo "Could not get an admin token from $KEYCLOAK_URL (wrong URL or admin password?)" >&2
    exit 1
  fi
  sleep 5
done
admin_token=$(sed -n 's/.*"access_token":"\([^"]*\)".*/\1/p' "$work/token.json")
if [ -z "$admin_token" ]; then
  echo "Keycloak answered without an access_token" >&2
  exit 1
fi

# Build the users. Lab user n has id 1ab5eed0-XXXX-YYYY-0000-000000000000 where
# XXXXYYYY is n as 8 hex digits: the same scheme as LabIds.userId(n) in
# transaction-service.
{
  printf '{"ifResourceExists":"SKIP","users":['
  i=1
  while [ "$i" -le "$LAB_CUSTOMERS" ]; do
    hex=$(printf '%08x' "$i")
    id="1ab5eed0-$(echo "$hex" | cut -c1-4)-$(echo "$hex" | cut -c5-8)-0000-000000000000"
    num=$(printf '%04d' "$i")
    [ "$i" -gt 1 ] && printf ','
    printf '{"id":"%s","username":"lab-customer-%s","email":"lab-customer-%s@spendwise.dev",' "$id" "$num" "$num"
    printf '"emailVerified":true,"firstName":"Lab","lastName":"Customer %s","enabled":true,' "$num"
    printf '"credentials":[{"type":"password","value":"%s","temporary":false}],' "$LAB_CUSTOMER_PASSWORD"
    printf '"realmRoles":["default-roles-%s"]}' "$KEYCLOAK_REALM"
    i=$((i + 1))
  done
  printf ']}'
} > "$work/users.json"

status=$(curl -s -o "$work/result.json" -w '%{http_code}' \
  -X POST "$KEYCLOAK_URL/admin/realms/$KEYCLOAK_REALM/partialImport" \
  -H "Authorization: Bearer $admin_token" \
  -H "Content-Type: application/json" \
  --data-binary "@$work/users.json")

if [ "$status" != "200" ]; then
  echo "partialImport failed with HTTP $status:" >&2
  cat "$work/result.json" >&2
  exit 1
fi

added=$(sed -n 's/.*"added":\([0-9]*\).*/\1/p' "$work/result.json")
skipped=$(sed -n 's/.*"skipped":\([0-9]*\).*/\1/p' "$work/result.json")
echo "Lab customers in realm '$KEYCLOAK_REALM': ${added:-0} created, ${skipped:-0} already present (lab-customer-0001..$(printf '%04d' "$LAB_CUSTOMERS"))."
