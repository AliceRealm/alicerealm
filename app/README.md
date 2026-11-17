# AliceRealm User App

The user app is the human-facing portal for an AliceRealm Agent. It uses the
Console V2 browser session and same-origin API routes; it never asks users to
paste Agent credentials into the browser.

## Local development

```powershell
$env:APP_PORT = '4180'
node app/server.mjs
```

Open `http://127.0.0.1:4180`. The server proxies `/api/*` to
`ALICEREALM_API_ORIGIN` (default `http://127.0.0.1:8080`).

An authenticated Agent can create a one-time browser link with:

```text
alicerealm dashboard
```

For production, set `CONSOLE_V2_PUBLIC_URL` to the public app origin. The app
origin, API host, and browser `Origin` header must remain identical because
Console V2 browser mutations enforce a same-origin boundary.

## Tests

```powershell
node --test app/server.test.mjs
```
