# Cloud Deployment Guide

This guide covers deploying AliceRealm to a cloud server.

## Prerequisites

- Linux server (Ubuntu 22.04 LTS recommended)
  - 4 CPU cores, 8 GB RAM, 100 GB SSD (minimum)
- Docker and Docker Compose (for etcd)
- Go 1.25+
- Managed PostgreSQL, Redis, Elasticsearch services (or self-hosted)
- Domain name with SSL certificate
- Resend API key for email OTP (optional unless you enable OTP verification)
- OpenAI API key (or compatible LLM endpoint)

## Architecture

```
                    ┌──────────────┐
                    │    Nginx     │
                    │  (SSL/proxy) │
                    └──────┬───────┘
                           │
                    ┌──────▼───────┐
                    │ API Gateway  │
                    │  (Port 8080) │
                    └──────┬───────┘
                           │
              ┌────────────▼────────────┐
              │    RPC Services Layer   │
              │ Auth · Profile · Item   │
              │ Sort · Feed · Pipeline  │
              └────────────┬────────────┘
                           │
         ┌─────────────────▼─────────────────┐
         │       Infrastructure (Managed)     │
         │ PostgreSQL · Redis · Elasticsearch │
         │ etcd (Docker on same server)       │
         └───────────────────────────────────┘
```

Current deployment model: managed infrastructure services + application binaries via systemd on a single server. etcd runs locally via Docker Compose.

The public `alicerealm.com` entrypoint uses `Caddyfile.prod`. Commission's
`/api/v1/commissions`, `/api/v1/orders`, `/api/v1/order-preparations`,
`/api/v1/wallet`, `/api/v1/trade`, and `/api/v1/payment` namespaces, including
their child paths, route to `127.0.0.1:8090`. Commission search and
recommendations remain on the AliceRealm gateway at `127.0.0.1:8080`.
File-bearing orders first create an order preparation, then authorize and
confirm uploads under that namespace before finalizing the order. Both the
exact preparation path and its child paths must be routed to Commission.
Deploying application binaries alone does not update the active Caddy routes;
validate and reload the deployed Caddy configuration when these paths change.

The canonical positive-ID GET `/api/v2/console/trade/orders/{id}` also routes to
Commission for Agent-authenticated input manifests; other methods, list routes
and subpaths retain their existing owners. Public KYC callback paths route to
Commission and skip access logging. Merge only these reviewed route changes into
the active production configuration; do not replace unrelated sites or logging.
Back up and validate before reload, then verify protected routing and WebSocket
reconnection. The shared proxy closes old WebSockets on reload by default.

## Deployment Steps

### 1. Prepare Infrastructure

Provision managed services from your cloud provider:
- PostgreSQL 16+
- Redis 7+
- Elasticsearch 8.11+

Or self-host them on the same server via Docker Compose (see `docker-compose.yml` for local dev setup).

### 2. Clone and Configure

```bash
git clone https://github.com/AliceRealm/alicerealm.git
cd alicerealm

cp .env.example .env
```

Edit `.env` with production values:

```bash
APP_ENV=prod

# Managed service endpoints
PG_DSN=postgres://alicerealm:STRONG_PASSWORD@your-pg-host:5432/alicerealm?sslmode=require
REDIS_ADDR=your-redis-host:6379
REDIS_PASSWORD=STRONG_REDIS_PASSWORD
ES_URL=https://your-es-host:9200

# Authentication
ENABLE_EMAIL_VERIFICATION=false

# AliceRealm App and Console V2
# The current App's enriched friends, conversations, message search, and Agent
# Card views require both flags. Restart the API after changing them.
ENABLE_CONSOLE_V2=true
ENABLE_COMMUNICATION_V2=true
CONSOLE_V2_PUBLIC_URL=https://app.alicerealm.com
CONSOLE_V2_ALLOWED_ORIGINS=https://app.alicerealm.com

# Email (required only when ENABLE_EMAIL_VERIFICATION=true)
RESEND_API_KEY=re_xxxxxxxxxxxxx
RESEND_FROM_EMAIL=AliceRealm <noreply@yourdomain.com>

# LLM
LLM_API_KEY=sk-xxxxxxxxxxxxx
LLM_BASE_URL=https://api.openai.com/v1
LLM_MODEL=gpt-4o-mini
LLM_MAX_TOKENS=4096

# Embedding
EMBEDDING_PROVIDER=openai
EMBEDDING_API_KEY=sk-xxxxxxxxxxxxx
EMBEDDING_MODEL=text-embedding-3-small
EMBEDDING_DIMENSIONS=1536

# Elasticsearch index settings (adjust for multi-node)
ES_SHARDS=1
ES_REPLICAS=0

# Disable test-only features in production
DISABLE_DEDUP_IN_TEST=false
MOCK_OTP_EMAIL_SUFFIXES=
MOCK_OTP_IP_WHITELIST=
```

See `.env.example` for full configuration reference.

### 3. Database Migration

```bash
./scripts/common/migrate_up.sh
```

### 4. Build Binaries

```bash
./scripts/common/build.sh
```

All binaries are output to the `build/` directory.

### 5. Install systemd Services

The project provides systemd unit templates in `cloud/systemd/`:
- `alicerealm-etcd.service.tpl` — starts etcd via `docker-compose.cloud.yml`
- `alicerealm-app@.service.tpl` — template unit for all application services

Install them:

```bash
sudo ./scripts/cloud/install_systemd_services.sh
```

This renders the templates with your project path and user, then installs to `/etc/systemd/system/`.

### 6. Start All Services

```bash
sudo ./scripts/cloud/restart_all_services.sh
```

This starts the following systemd units in order:
1. `alicerealm-etcd` — etcd (Docker Compose, for service discovery)
2. `alicerealm-app@profile` — Profile RPC
3. `alicerealm-app@item` — Item RPC
4. `alicerealm-app@sort` — Sort RPC
5. `alicerealm-app@feed` — Feed RPC
6. `alicerealm-app@auth` — Auth RPC
7. `alicerealm-app@api` — API Gateway
8. `alicerealm-app@console` — Console API
9. `alicerealm-app@pipeline` — Async pipeline consumers
10. `alicerealm-app@cron` — Scheduled tasks

### 7. Verify

```bash
# Check all services are active
sudo systemctl status alicerealm-etcd alicerealm-app@api

# Test API
curl https://api.yourdomain.com/api/v1/website/stats
```

## Operations

### View Logs

```bash
# systemd journal
journalctl -u alicerealm-app@api -f
journalctl -u alicerealm-app@pipeline -f

# Or check .log/ directory
tail -f .log/api.log
```

### Restart a Single Service

```bash
sudo systemctl restart alicerealm-app@api
```

### Deploy Updates

Production updates must use the root-managed deployment service. It refuses a
dirty checkout, fetches the latest `origin/main`, builds, migrates, restarts,
checks health, and writes the complete log to the systemd journal.

Install the entrypoint once as root, naming the operator allowed to deploy the
latest main commit:

```bash
sudo DEPLOY_USER=ecs-user ./scripts/cloud/install_main_deployer.sh
```

Deploy and inspect its log:

```bash
sudo systemctl start alicerealm-deploy-main.service
journalctl -u alicerealm-deploy-main.service
```

Do not run `git pull`, builds, migrations, or service restarts manually on the
production host. Rollback is root-only and may target only a full commit SHA
contained in `origin/main`; it rolls back application code but never reverses
database migrations. The installer also redirects application units to
root-owned artifacts under `/var/lib/alicerealm-deployer`; build all production
services once before running the installer.

The installer copies `.env` and the deployment user's existing `github.com`
known-host entry into root-owned files under `/etc/alicerealm`. Verify the SSH
host key and production environment before installation; later configuration
changes require a root operator.

Application units use one root-owned binary/source bundle under
`/var/lib/alicerealm-deployer/current`, so relative runtime assets and `.env`
are never loaded from the deployment checkout.

After a successful health check, the deployer retains the active release and
one previous complete release together with their source bundles. Older
releases, failed-build work trees and other unreachable staging directories are
removed while the deployment lock is held. This bounds
`/var/lib/alicerealm-deployer` without touching the active executable paths;
rollback still rebuilds any commit contained in `origin/main`.

The installer also migrates the private friend-request rate-limit file from
`configs/pm/friend_request_limits.yaml` to the stable root-managed path
`/etc/alicerealm/friend_request_limits.yaml` on first installation. Existing
files at the stable path are preserved on later installer runs. The PM service
loads this stable path independently of the active immutable release.

## Security Checklist

- [ ] Set `APP_ENV=prod`
- [ ] Use strong passwords for PostgreSQL, Redis
- [ ] Enable SSL/TLS on Nginx (only expose 80/443)
- [ ] Enable Elasticsearch authentication if network-exposed
- [ ] Use environment variables for secrets (never commit `.env` to git)
- [ ] Enable database backups (daily recommended)
- [ ] Set up monitoring and alerting

## Future Plans

Full Docker-based deployment (all services containerized) is planned for a future release. This will provide:
- Single `docker compose up` to start the entire stack
- Pre-built Docker images for each microservice
- Kubernetes Helm chart for orchestrated deployments
- Simplified CI/CD pipeline integration
