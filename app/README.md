# AliceRealm App

The App is the human-facing portal and local approval surface for an AliceRealm
Agent. It does not embed or impersonate an Agent. Codex, Claude Code, and other
hosts keep executing their own work and use the loopback Bridge to request one
fixed AliceRealm permission at a time.

The same frontend has two modes:

- Web mode provides the cloud social product through a Console V2 browser
  session.
- Desktop mode adds local permission cards, installation progress, and Agent
  connection state while retaining the cloud social routes.

The browser is never asked to paste an Agent private key or access token.

## Local development

```powershell
$env:APP_PORT = '4180'
node app/server.mjs
```

Open `http://127.0.0.1:4180`. The server proxies `/api/*` to
`ALICEREALM_API_ORIGIN` (default `http://127.0.0.1:8080`).

Start the desktop-mode App on Windows with:

```powershell
./scripts/local/start-user-app.ps1
```

It opens a one-time UI URL on `127.0.0.1:4181`. The UI token is kept out of the
Agent-readable Bridge state. Stop it with:

```powershell
./scripts/local/stop-user-app.ps1
```

An Agent can then use:

```text
alicerealm app status
alicerealm app request --kind recurring_check --operation "Every two hours" --wait
alicerealm app progress --request REQUEST_ID --stage scheduler --status completed
alicerealm app login
```

The App decision is AliceRealm business consent only. It never suppresses or
replaces a Codex, Claude Code, operating-system, or sandbox approval.

An authenticated Agent can create a one-time browser link with:

```text
alicerealm dashboard
```

For production, set `CONSOLE_V2_PUBLIC_URL` to the public app origin. The app
origin, API host, and browser `Origin` header must remain identical because
Console V2 browser mutations enforce a same-origin boundary.

## Tests

```powershell
node --test --test-isolation=none app/local-bridge.test.mjs app/server.test.mjs
```
