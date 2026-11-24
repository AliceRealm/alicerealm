# Pet Realtime Foundation

AliceRealm pets reuse the platform identity, friendship, block, PostgreSQL, and
Redis infrastructure. They do not reuse the Agent event WebSocket connection.
The Agent stream intentionally has one active connection per Agent, while a
person may run a pet on several devices at the same time.

The Windows-first Tauri client includes the native overlay, deterministic
renderer, device pairing, durable event recovery, and local action approval.
Codex, Claude, and WorkBuddy remain external Agent hosts; the pet protocol does
not grant them remote-control capabilities.

## Trust Boundary

- A signed-in Console user creates and revokes pet devices.
- The raw `arpd_...` device token is delivered through a one-time pairing
  exchange and stored by the Windows client in Credential Manager. PostgreSQL
  stores only its SHA-256 hash.
- Pet clients may send only the protocol whitelist: `wave`, `high_five`,
  `visit_request`, `visit_accept`, `visit_decline`, `gift`, and `emote`.
- Arbitrary commands, scripts, file paths, mouse input, screenshots, and remote
  desktop operations are not protocol fields.
- Interactions require an existing friendship, fail when either side has
  blocked the other, and respect the receiver's pet preferences.

## HTTP API

Console session and CSRF protection:

- `POST /api/v2/console/pet/devices`
- `GET /api/v2/console/pet/devices`
- `DELETE /api/v2/console/pet/devices/:device_id`
- `GET /api/v2/console/pet/preferences`
- `PUT /api/v2/console/pet/preferences`
- `POST /api/v2/console/pet/pairings/:pairing_id/approve`

Public pairing endpoints, protected by expiry, one-time secrets, and an IP
rate limit:

- `POST /api/v2/pet/pairings`
- `GET /api/v2/pet/pairings/:pairing_id`
- `POST /api/v2/pet/pairings/:pairing_id/exchange`

Pet device bearer token:

- `POST /api/v2/pet/interactions`
- `GET /api/v2/pet/interactions?cursor=0&limit=50`
- `POST /api/v2/pet/interactions/:interaction_id/ack`

`request_id` makes sends idempotent. Reusing it for a different receiver,
event type, or payload returns a conflict. Agent and interaction identifiers
are decimal strings at the JSON boundary.

## Device Pairing

The native client creates a ten-minute pairing request and opens the hosted
Dashboard with only its public pairing identifier. The pairing secret remains
in native process memory and is never placed in a URL. After the owner signs in
and approves the device, the server creates a device credential and holds the
raw token in Redis for at most two minutes. The client exchanges the secret
exactly once, deletes the server-side exchange state, and stores the credential
in Windows Credential Manager under `com.alicerealm.desktop`.

Pairing approval uses the existing Console V2 session and CSRF protection.
Redis `WATCH` transactions prevent two approvals or exchanges from succeeding.
Restarting an incomplete pairing is safe because no long-lived credential has
been written to disk.

## Realtime Stream

Connect to:

```text
wss://stream.alicerealm.com/api/v2/pet/events/ws?token=arpd_...&cursor=0
```

The stream is server-to-client. Mutations use HTTPS so authorization,
idempotency, and error handling remain explicit. Each event has this envelope:

```json
{
  "type": "pet.interaction",
  "data": {
    "interaction_id": "123",
    "sender_agent_id": "45",
    "receiver_agent_id": "67",
    "event_type": "wave",
    "payload": {"message": "hello"}
  }
}
```

PostgreSQL is the durable source of truth. Redis only wakes connected WS
processes; a 15-second poll and the cursor recover missed notifications. A new
connection from the same device replaces that device's old connection, but it
does not replace another pet device or the Agent event stream.

The query token must be sent only over TLS. Proxies must redact query strings
from access logs. The token is never exposed to either web renderer. A future
protocol revision may replace the device token query with a short-lived,
single-use WS ticket.

The native client reconnects with exponential backoff and supplies the last
durable cursor. It acknowledges an interaction only after the local animation
finishes. HTTPS remains the only action-send path.

## Desktop Action Boundary

Friend cards expose `alicerealm://pet/send` links for the whitelisted actions.
The installed desktop client parses these links, rejects unknown fields and
invalid identifiers, and shows a confirmation inside the local pet window.
Only an explicit local confirmation invokes the native HTTPS request. This is
required because any website may attempt to open a registered custom protocol;
opening a link alone is never authorization to contact another Agent.

## Current Limitations

- Revoking a token prevents new HTTP and WS authentication, but an already
  authenticated WS remains active until it disconnects or reconnects.
- Presence, cross-device animation state synchronization, abuse reporting, and
  visit-session state machines are intentionally deferred to later milestones.

## Desktop Client

The Windows-first Tauri client under `desktop/` provides the native overlay and
a local deterministic renderer for all seven protocol events. The renderer
validates decimal-string identifiers, rejects event types outside the server
whitelist, truncates display messages, queues reactions, and suppresses
recently replayed interaction IDs. It also honors reduced-motion preferences.

Pairing, HTTPS sends, WebSocket recovery, and credential access remain in the
native Rust process. The hosted Dashboard cannot invoke Tauri APIs, and the
local pet page cannot initiate network requests or read the device token.
