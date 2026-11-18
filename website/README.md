# AliceRealm public website

This directory contains the public, dependency-free AliceRealm landing page. It
is intentionally separate from `console/webapp`, which is the administrative
console.

Run locally:

```powershell
node website/server.mjs
```

The server binds to `127.0.0.1:4173` by default and proxies only the two public
website status endpoints to the API gateway. Override the bind settings with
`WEBSITE_HOST` and `WEBSITE_PORT`.

Run tests:

```powershell
node --test website/server.test.mjs
```
