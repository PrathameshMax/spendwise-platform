# spendwise-platform

Runs the whole SpendWise system locally: Docker Compose for every service and its infrastructure
(PostgreSQL, Redis, 3-node Kafka, Schema Registry, Keycloak, Vault, Zipkin, Prometheus, Grafana),
the Postman test collections, and the production debugging lab. No application code lives here:
every service is built and published to GHCR by its own repository.

## Repositories

| Repository | What it is | Image |
|---|---|---|
| [spendwise-shared](https://github.com/PrathameshMax/spendwise-shared) | Parent POM, `spendwise-common`, `spendwise-events` (Avro contracts), published to GitHub Packages | — |
| [spendwise-config](https://github.com/PrathameshMax/spendwise-config) | Externalized configuration served by config-server | — |
| [spendwise-discovery-server](https://github.com/PrathameshMax/spendwise-discovery-server) | Eureka registry (8761) | `spendwise-discovery-server` |
| [spendwise-config-server](https://github.com/PrathameshMax/spendwise-config-server) | Spring Cloud Config, Git backend (8888) | `spendwise-config-server` |
| [spendwise-api-gateway](https://github.com/PrathameshMax/spendwise-api-gateway) | Edge gateway and BFF (8080) | `spendwise-api-gateway` |
| [spendwise-user-service](https://github.com/PrathameshMax/spendwise-user-service) | Customer profiles (8082) | `spendwise-user-service` |
| [spendwise-transaction-service](https://github.com/PrathameshMax/spendwise-transaction-service) | Ledger, outbox, saga compensation (8083) | `spendwise-transaction-service` |
| [spendwise-budget-service](https://github.com/PrathameshMax/spendwise-budget-service) | Budgets, cap decisions, gRPC summaries (8084, gRPC 9090) | `spendwise-budget-service` |
| [spendwise-notification-service](https://github.com/PrathameshMax/spendwise-notification-service) | Alert consumer (8085) | `spendwise-notification-service` |
| [spendwise-analytics-service](https://github.com/PrathameshMax/spendwise-analytics-service) | Reactive read side (8086) | `spendwise-analytics-service` |
| [spendwise-web](https://github.com/PrathameshMax/spendwise-web) | React web app (5173) | `spendwise-web` |

Images are `ghcr.io/prathameshmax/<image>`, tagged with the commit SHA and `main`.

## Run it

```bash
docker compose pull
docker compose up -d
docker compose ps
```

Compose pulls an image only when it is missing, so `docker compose pull` is what fetches newer builds.
Which version of each service runs is set in `.env` (`main` by default). Pin a commit SHA there to run
an exact build; `docker compose config | grep image:` shows what will run.

Production-mode lab (JSON logs, `prod,lab` profiles, optional AppDynamics): `./scripts/lab.sh start --pull`.

## Test it

Import the collections in `postman/` and run them with the Collection Runner:

| Collection | What it proves |
|---|---|
| `SpendWise-Security` | Keycloak tokens, roles and scopes, ownership, gateway edge controls, service-to-service auth |
| `SpendWise-M21-Budget-Cap` | The budget-breach saga end to end: accepted, rejected by budget-service, reversed by transaction-service |
| `SpendWise` | The original per-milestone collection. Folders written before Keycloak (they log in through auth-service) no longer pass. |

## Developing one service

Stop that one container and run the service from its own repository in the IDE on the same port; the
rest keep running from images:

```bash
docker compose stop user-service
```

To try a local image instead, build it in the service repository and point compose at it:
`docker build --secret id=gh_token,env=GITHUB_PACKAGES_TOKEN -t ghcr.io/prathameshmax/spendwise-user-service:local .`,
then `USER_SERVICE_TAG=local` in `.env` and `docker compose up -d user-service`.

## History

This repository was split out of the original monorepo with its history kept. The milestone-by-milestone
notes from that period are in [docs/monorepo-milestones.md](docs/monorepo-milestones.md).
