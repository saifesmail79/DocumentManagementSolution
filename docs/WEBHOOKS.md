# Webhooks

A webhook is a URL the DMS calls with an HTTP POST when something you
subscribed to happens. It is the push direction of integration; an API key is
the pull direction, where another system calls the DMS as a user.

Webhooks are created on the administration screen. Each one has a name, a URL,
a list of events, and a signing secret shown exactly once at creation.

## Events

| Event                    | Fires when                                                        |
| ------------------------ | ----------------------------------------------------------------- |
| `document.created`       | A new document is uploaded. Not for a new version of an old one.  |
| `document.updated`       | Title, type, fields or tags change. Not when content changes.     |
| `document.deleted`       | A document is moved to the recycle bin.                           |
| `document.version_added` | A new version of an existing document is uploaded.                |
| `approval.requested`     | An approval starts on a document. Once per request, not per step. |
| `approval.decided`       | Every approve or reject on any step.                              |

## Delivery

```
POST <your url>
Content-Type: application/json
X-DMS-Event: document.created
X-DMS-Delivery: 1234
X-DMS-Timestamp: 1756894800
X-DMS-Signature: v1=3f0c...e9

{"event":"document.created","at":"2026-09-03T10:20:00.000Z","data":{...}}
```

`X-DMS-Delivery` is unique per delivery and repeats on retries, so a receiver
can deduplicate. The body is sent byte for byte as stored, so the signature is
computed over exactly what arrives.

### Payloads

Document events carry:

```json
{ "documentId": "18565", "folderId": "4421", "title": "عقد إيجار", "actor": "alice" }
```

`approval.requested` adds `requestId`, `templateId` and `step` (always the
first step). `approval.decided` adds `requestId`, `step`, `decision`
(`approved` or `rejected`) and `outcome`, which says what the decision did to
the request: `advanced`, `approved`, `rejected`, or `awaiting_others` for a
step that needs every member of a group.

### Retries

Delivery runs in the background and never blocks the action that caused it.
A delivery is attempted up to five times with a fifteen second timeout each;
any 2xx response counts as success. After the fifth failure the delivery is
marked failed, and the count is shown on the administration screen. Pausing a
webhook stops both queueing and retries; resuming continues them.

## Verifying the signature

Every delivery from a webhook that has a secret carries `X-DMS-Timestamp`
(Unix seconds) and `X-DMS-Signature`. The signature is:

```
v1=HEX( HMAC-SHA256( secret, timestamp + "." + rawBody ) )
```

Compute it from the raw request body before any JSON parsing, compare with a
constant-time comparison, and reject deliveries whose timestamp is older than
a few minutes so a captured request cannot be replayed.

Node example:

```js
import { createHmac, timingSafeEqual } from 'node:crypto';

export function verify({ secret, headers, rawBody, toleranceSeconds = 300 }) {
  const timestamp = headers['x-dms-timestamp'];
  const signature = headers['x-dms-signature'];
  if (!timestamp || !signature) return false;

  if (Math.abs(Date.now() / 1000 - Number(timestamp)) > toleranceSeconds) return false;

  const expected = 'v1=' + createHmac('sha256', secret).update(`${timestamp}.${rawBody}`).digest('hex');
  const a = Buffer.from(expected);
  const b = Buffer.from(signature);
  return a.length === b.length && timingSafeEqual(a, b);
}
```

A webhook created before signing was introduced has no secret the server can
use and is marked "بلا توقيع" on the administration screen. Its deliveries go
out without the two headers until an administrator issues a secret from the
row's action menu. Rotating a secret takes effect at the next delivery sweep,
including for deliveries already queued, so update the receiver first.
