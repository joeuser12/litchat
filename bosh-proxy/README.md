# bosh-proxy

A lightweight keepalive proxy for BOSH/XMPP sessions. Intended for use with mobile clients (iOS/Android) where the OS backgrounds apps and drops network connections.

## How it works

Mobile apps lose their BOSH session when backgrounded because the OS kills network activity. This proxy solves that without storing credentials:

1. The mobile app authenticates **directly** to the BOSH server and gets a `sid` and `rid`
2. The app registers the session with bosh-proxy: `POST /sessions`
3. The proxy sends periodic empty BOSH polls to keep the server-side session alive
4. When the app resumes, it fetches the current `sid`/`rid` from the proxy and resumes the session directly

**What the proxy stores:** `sid`, current `rid`, BOSH endpoint URL, and a last-poll timestamp. No passwords, no message content.

## API

### Register a session

```
POST /sessions
Content-Type: application/json

{ "bosh_url": "https://example.com/http-bind", "sid": "abc123", "rid": 1000 }
```

Response:
```json
{ "token": "a3f8c1d2e4b5f6a7b8c9d0e1f2a3b4c5" }
```

### Get session state

```
GET /sessions/:token
```

Response:
```json
{
  "sid": "abc123",
  "rid": 1047,
  "bosh_url": "https://example.com/http-bind",
  "last_poll": "2024-01-15T10:30:00Z",
  "active": true,
  "created_at": "2024-01-15T09:00:00Z"
}
```

### Deregister

```
DELETE /sessions/:token
```

Returns `204 No Content`.

### Health check

```
GET /health
```

Returns `{ "ok": true, "sessions": 3 }`.

## Running

```sh
go build -o bosh-proxy .
./bosh-proxy
```

## Configuration

| Environment variable | Default | Description |
|---|---|---|
| `PORT` | `8080` | HTTP listen port |
| `KEEPALIVE_MARGIN` | `10` | Seconds before inactivity timeout to send keepalive |
| `DEFAULT_INACTIVITY` | `60` | Assumed BOSH inactivity timeout (seconds) until server tells us otherwise |
| `SESSION_TTL` | `86400` | Seconds before an idle session is auto-removed |
| `MAX_SESSIONS` | `1000` | Maximum concurrent sessions |

## Deployment

The server speaks plain HTTP. In production, front it with nginx or Caddy to terminate TLS.

### Self-hosting (recommended)

Because this proxy holds session tokens (not credentials), it is suitable for self-hosting. Anyone can audit what it stores by reading the source.

### Multi-tenancy

Multiple users' sessions are safe to run on the same instance — `sid` values are opaque tokens scoped to their own XMPP server, and tokens are 128-bit random values.
