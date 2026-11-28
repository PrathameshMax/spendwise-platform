// Production Debugging Lab — traffic simulator (k6).
//
// Production is never idle: this stands in for SpendWise mobile-app users.
// Each simulated request is made AS a lab customer (lab-customer-0001..N in
// Keycloak, created by infra/keycloak-lab/lab-customers.sh), with that user's
// own access token, so it passes the same checks real traffic does: token
// validation, CUSTOMER role and scopes, per-user rate limiting at the gateway,
// and ownership (the API reads the user from the token's "sub"). Lab customer n
// has the same id as lab user n seeded by POST /lab/seed, so every request reads
// real seeded data. It runs until ./scripts/lab.sh traffic-stop.
//
//   home_screen  GET /api/v1/transactions/insights/monthly?month=yyyy-MM   HOME_SCREEN_PER_MIN (default 90/min)
//   statement    GET /api/v1/transactions?page=0&size=20                   STATEMENT_PER_MIN   (default 120/min)
//
// Constant arrival rate: requests keep arriving at the configured pace even
// when responses slow down, exactly like real users opening the app. Slow
// responses therefore pile up instead of slowing the simulator down.
// Every request carries X-Correlation-ID "sim-<scenario>-<yyyyMMdd-HHmmss-SSS UTC>-<vu>-<iter>",
// so any request can be followed in Splunk. The time is split into short digit
// groups on purpose: the services' PII masker turns any run of 13+ digits
// (account/card number shape) into ****1234, which would hide a raw epoch-millis id.
//
// Tokens: each virtual user plays ONE lab customer (VU n -> lab customer
// ((n-1) mod LAB_USERS) + 1), like one phone per customer, and keeps its own
// Keycloak session: it logs in on first use (password grant on the
// spendwise-dev-cli client, the realm's only client that allows it), then
// renews its 5-minute access token with its own refresh token shortly before
// expiry. Two reasons this matters with the realm's settings:
//   - refresh tokens are single-use (revokeRefreshToken, maxReuse 0), so a
//     refresh token must never be shared between virtual users;
//   - brute-force protection temporarily disables a user after failed logins,
//     and concurrent fallback logins for the same customer used to trip it,
//     so each session logs in once and then only refreshes. With at most 240
//     virtual users (120 per scenario) over 50 customers, no customer ever has
//     more than 5 sessions.
// A 401 from the API drops the session, and the next request logs in again.
//
// Everything is configured through environment variables, so the same script
// can later run against EKS (TARGET = the ingress or gateway service URL,
// TOKEN_URL = Keycloak's URL there):
//
//   TARGET                 API base URL                  (default http://api-gateway:8080)
//   TOKEN_URL              Keycloak token endpoint       (default http://keycloak:8080/realms/spendwise/protocol/openid-connect/token)
//   CLIENT_ID              public client with password grant (default spendwise-dev-cli)
//   LAB_USERS              lab customers to act as, 1..N (default 50; must not exceed LAB_CUSTOMERS)
//   LAB_CUSTOMER_PASSWORD  their password                (default LabCustomer#2026)
//   HOME_SCREEN_PER_MIN, STATEMENT_PER_MIN   request rates
//
// Tokens: each virtual user plays ONE lab customer (VU n -> lab customer
// ((n-1) mod LAB_USERS) + 1), like one phone per customer, and keeps its own
// Keycloak session: it logs in on first use (password grant on the
// spendwise-dev-cli client, the realm's only client that allows it), then
// renews its 5-minute access token with its own refresh token shortly before
// expiry. Two reasons this matters with the realm's settings:
//   - refresh tokens are single-use (revokeRefreshToken, maxReuse 0), so a
//     refresh token must never be shared between virtual users;
//   - brute-force protection temporarily disables a user after failed logins,
//     and concurrent fallback logins for the same customer used to trip it,
//     so each session logs in once and then only refreshes. With at most 240
//     virtual users (120 per scenario) over 50 customers, no customer ever has
//     more than 5 sessions.
// A 401 from the API drops the session, and the next request logs in again.
//
// Everything is configured through environment variables, so the same script
// can later run against EKS (TARGET = the ingress or gateway service URL,
// TOKEN_URL = Keycloak's URL there):
//
//   TARGET                 API base URL                  (default http://api-gateway:8080)
//   TOKEN_URL              Keycloak token endpoint       (default http://keycloak:8080/realms/spendwise/protocol/openid-connect/token)
//   CLIENT_ID              public client with password grant (default spendwise-dev-cli)
//   LAB_USERS              lab customers to act as, 1..N (default 50; must not exceed LAB_CUSTOMERS)
//   LAB_CUSTOMER_PASSWORD  their password                (default LabCustomer#2026)
//   HOME_SCREEN_PER_MIN, STATEMENT_PER_MIN   request rates
//
// The simulator's own output is not shipped to Splunk: it is the outside
// world, not part of the platform.

import http from 'k6/http';
import { check } from 'k6';
import exec from 'k6/execution';

const TARGET = __ENV.TARGET || 'http://api-gateway:8080';
const TOKEN_URL = __ENV.TOKEN_URL || 'http://keycloak:8080/realms/spendwise/protocol/openid-connect/token';
const CLIENT_ID = __ENV.CLIENT_ID || 'spendwise-dev-cli';
const LAB_USERS = parseInt(__ENV.LAB_USERS || '50', 10);
const LAB_CUSTOMER_PASSWORD = __ENV.LAB_CUSTOMER_PASSWORD || 'LabCustomer#2026';
const HOME_SCREEN_PER_MIN = parseInt(__ENV.HOME_SCREEN_PER_MIN || '90', 10);
const STATEMENT_PER_MIN = parseInt(__ENV.STATEMENT_PER_MIN || '120', 10);
const RENEW_BEFORE_SECONDS = 30;

export const options = {
  discardResponseBodies: true,
  summaryTrendStats: ['avg', 'p(95)', 'p(99)', 'max'],
  scenarios: {
    home_screen: {
      executor: 'constant-arrival-rate',
      exec: 'homeScreen',
      rate: HOME_SCREEN_PER_MIN,
      timeUnit: '1m',
      duration: '12h',
      preAllocatedVUs: 10,
      maxVUs: 120,
    },
    statement: {
      executor: 'constant-arrival-rate',
      exec: 'statement',
      rate: STATEMENT_PER_MIN,
      timeUnit: '1m',
      duration: '12h',
      preAllocatedVUs: 10,
      maxVUs: 120,
    },
  },
};

function username(index) {
  return `lab-customer-${String(index).padStart(4, '0')}`;
}

function tokenRequest(form) {
  return http.post(TOKEN_URL, Object.assign({ client_id: CLIENT_ID }, form), {
    responseType: 'text',
    timeout: '15s',
    tags: { name: 'keycloak token' },
  });
}

function toEntry(res) {
  const body = res.json();
  return {
    access: body.access_token,
    refresh: body.refresh_token,
    expiresAt: Date.now() / 1000 + body.expires_in,
  };
}

function login(index) {
  const res = tokenRequest({ grant_type: 'password', username: username(index), password: LAB_CUSTOMER_PASSWORD });
  return res.status === 200 ? toEntry(res) : null;
}

// Fail fast, once, with a clear message instead of a wall of 401s.
export function setup() {
  if (login(1) === null) {
    exec.test.abort(`Login failed for ${username(1)} at ${TOKEN_URL}. Are the lab customers created `
      + '(keycloak-lab-customers job in docker-compose.lab.yml)?');
  }
  console.log(`Lab customers can log in; ${LAB_USERS} customers will send traffic to ${TARGET}`);
}

// Per virtual user: which customer it plays, and that customer's session.
const MY_CUSTOMER = ((__VU - 1) % LAB_USERS) + 1;
let session = null;

function accessToken() {
  if (session !== null && session.expiresAt - Date.now() / 1000 > RENEW_BEFORE_SECONDS) {
    return session.access;
  }
  if (session !== null) {
    const refreshed = tokenRequest({ grant_type: 'refresh_token', refresh_token: session.refresh });
    session = refreshed.status === 200 ? toEntry(refreshed) : null;
  }
  if (session === null) {
    session = login(MY_CUSTOMER);
  }
  return session === null ? '' : session.access;
}

function afterResponse(res) {
  if (res.status === 401) {
    session = null;
  }
}

// 2026-11-28T14:41:13.533Z -> 20261128-144113-533 (no digit run long enough to be masked)
function timeStamp() {
  return new Date().toISOString().replace(/[-:]/g, '').replace('T', '-').replace('.', '-').replace('Z', '');
}

function params(scenario, name, token) {
  return {
    timeout: '30s',
    tags: { name },
    headers: {
      Authorization: `Bearer ${token}`,
      'X-Correlation-ID': `sim-${scenario}-${timeStamp()}-${__VU}-${__ITER}`,
    },
  };
}

export function homeScreen() {
  const month = new Date().toISOString().slice(0, 7);
  const res = http.get(
    `${TARGET}/api/v1/transactions/insights/monthly?month=${month}`,
    params('home', 'GET /api/v1/transactions/insights/monthly', accessToken()));
  afterResponse(res);
  check(res, { 'home screen 200': (r) => r.status === 200 });
}

export function statement() {
  const res = http.get(
    `${TARGET}/api/v1/transactions?page=0&size=20&sort=transactionDate,desc`,
    params('statement', 'GET /api/v1/transactions', accessToken()));
  afterResponse(res);
  check(res, { 'statement 200': (r) => r.status === 200 });
}
