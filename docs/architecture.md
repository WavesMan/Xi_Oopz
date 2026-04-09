# Discord-like WebRTC MVP Architecture

## Product Flow

1. User opens the site and registers or logs into an account.
2. Frontend loads bootstrap data for the default domain:
   - domain info
   - channel categories and channels
   - domain members
   - recent messages for the selected channel
   - Redis-backed online counts for voice channels
3. Frontend requests `/api/auth/me` and `/api/bootstrap` with a bearer token, then opens a WebSocket connection with `token` and `domainId`.
4. When the user joins a voice channel:
   - browser requests microphone access with `getUserMedia({ audio: true })`
   - client sends `channel.join`
   - server stores the online presence in Redis and broadcasts a join system event
   - joiner receives `presence.snapshot`
   - joiner creates WebRTC peer connections to the existing members in the channel
5. During the call:
   - text chat is delivered through WebSocket and persisted to MySQL
   - `rtc.offer`, `rtc.answer`, and `rtc.ice_candidate` are forwarded by the server
   - microphone toggle is broadcast as `voice.state`
   - screen share uses `getDisplayMedia()` and renegotiates peer connections
   - viewers can open the shared stream in an in-browser maximized preview or system fullscreen
6. When the user leaves or disconnects:
   - server removes their presence from Redis
   - server broadcasts `member.left`
   - a transient system message is broadcast only to the current voice channel and is not persisted

## Why This MVP Uses Mesh WebRTC

This version uses browser-to-browser mesh connections because the requested backend stack is Gin + Redis + WebSocket + MySQL, without an SFU such as LiveKit or mediasoup.

Tradeoff:

- good for small rooms and quick iteration
- not suitable for large voice channels because each participant publishes to every other participant

Recommended constraint for this MVP:

- voice channel `max_members <= 6`

If you later want Discord-scale rooms, keep the same domain/channel/message model and replace the media layer with an SFU.

## API Surface

### REST

- `POST /api/auth/register`
  - create an account and return a signed auth token
- `POST /api/auth/login`
  - verify email + password and return a signed auth token
- `GET /api/auth/me`
  - return the current authenticated user from the bearer token
- `GET /api/bootstrap`
  - auth: `Authorization: Bearer <token>`
  - query params: `domainId`, `channelId`
  - returns domain, categories, channels, members, selected channel messages, and online counts
- `GET /api/domains/:domainId/channels/:channelId/messages`
  - auth: `Authorization: Bearer <token>`
  - query params: `limit`, `beforeId`
  - returns recent persisted messages for the channel
- `GET /api/domains/:domainId`
  - auth: `Authorization: Bearer <token>`
  - returns the selected domain
- `PATCH /api/domains/:domainId`
  - auth: `Authorization: Bearer <token>`
  - updates name, description, accent color
- `GET /api/domains/:domainId/members`
  - auth: `Authorization: Bearer <token>`
  - returns domain members
- `GET /api/domains/:domainId/channels`
  - auth: `Authorization: Bearer <token>`
  - returns category tree, flat channel list, and online counts
- `GET /api/domains/:domainId/presence`
  - auth: `Authorization: Bearer <token>`
  - returns domain-wide online users, per-voice-channel members, and voice online counts for polling
- `POST /api/domains/:domainId/categories`
  - auth: `Authorization: Bearer <token>`
  - creates a category
- `POST /api/domains/:domainId/channels`
  - auth: `Authorization: Bearer <token>`
  - creates a text or voice channel
- `PATCH /api/channels/:channelId`
  - auth: `Authorization: Bearer <token>`
  - updates channel name, topic, position, and `maxMembers`
- `GET /healthz`
  - health check

### WebSocket

Endpoint:

- `GET /ws?token={token}&domainId={domainId}`

Client to server events:

- `hello`
- `channel.join`
- `channel.leave`
- `chat.send`
- `voice.state`
- `screen.state`
- `rtc.offer`
- `rtc.answer`
- `rtc.ice_candidate`
- `heartbeat`
- `screening.join`
- `screening.leave`
- `screening.url.replace`
- `screening.url.add`
- `screening.controller.ready`
- `screening.play`
- `screening.pause`
- `screening.seek`
- `screening.tick`
- `screening.rate`
- `screening.item.ended`

Server to client events:

- `ready`
- `presence.snapshot`
- `member.joined`
- `member.left`
- `chat.message`
- `voice.state`
- `screen.state`
- `rtc.offer`
- `rtc.answer`
- `rtc.ice_candidate`
- `screening.snapshot`
- `screening.playlist.updated`
- `screening.play`
- `screening.pause`
- `screening.seek`
- `screening.tick`
- `screening.rate`
- `error`

## Screening Room MVP

### Product Goal

Add a new channel type:

- `screening`

A screening room does not relay media streams between members. Every viewer loads the same playable direct video URL locally, while the server synchronizes only realtime room state through Redis + WebSocket.

The first version keeps screening room state **out of MySQL**. Redis is the source of truth for:

- current controller
- current item URL
- playback state
- playback time
- playback rate
- viewers currently in the room
- queued playlist items

### Playback Rules

1. A controller chooses a direct video URL.
2. The controller can:
   - replace the current video and start after ready
   - append the URL to the playlist
3. Replacing the current item changes the room state to `loading`.
4. Viewers load the same URL locally.
5. Playback starts only after the controller confirms the player has buffered enough data.
6. While playing, the controller sends periodic sync ticks.
7. Viewer drift under `3s` is ignored.
8. Viewer drift at or above `3s` triggers a seek correction.

### Redis Keys

For `channelId = 123`:

- `screening:room:123:state`
  - type: `HASH`
  - fields:
    - `controller_user_id`
    - `current_item_id`
    - `current_url`
    - `current_title`
    - `playback_state`
    - `current_time`
    - `playback_rate`
    - `updated_at`
    - `started_at`
    - `awaiting_ready`
    - `sync_token`

- `screening:room:123:viewers`
  - type: `HASH`
  - field: `userId`
  - value: JSON viewer payload

- `screening:room:123:playlist`
  - type: `LIST`
  - value: JSON playlist item

### Room Flow

1. User selects a `screening` channel.
2. Frontend loads messages as usual and sends `screening.join`.
3. Backend stores the viewer in Redis and returns `screening.snapshot`.
4. Controller replaces current URL:
   - backend updates Redis state to `loading`
   - backend broadcasts new snapshot
   - all clients load the new source locally
5. Controller reaches a ready state in the player and sends `screening.controller.ready`.
6. Backend changes room state to `playing` and broadcasts `screening.play`.
7. Controller emits `screening.tick` every `2-3s`.
8. Clients compare their local position with the target position and only seek on `>= 3s` drift.

### Frontend MVP Notes

The first implementation uses the native HTML5 `<video>` player for speed and integration simplicity.

This first version supports:

- direct file URLs such as `mp4`, `webm`, and compatible direct media sources
- replace-now playback
- append-to-playlist
- controller-ready gate before playback begins
- periodic playback synchronization

The player shell can be upgraded later without changing the Redis or WebSocket contract.

## Redis Strategy

Redis is only used for online room state and fast counts.

Keys:

- `online:channels`
  - set of active voice channel IDs
- `channel:presence:{channelId}`
  - hash keyed by `userId`, value is a JSON payload with mic/screen/display name/avatar color
- `screening:room:{channelId}:state`
  - hash storing current playback state for a screening channel
- `screening:room:{channelId}:viewers`
  - hash keyed by `userId`, value is a JSON viewer payload
- `screening:room:{channelId}:playlist`
  - list storing queued playable URLs

Lifecycle:

- on join: `SADD online:channels`, `HSET channel:presence:{id}`
- on toggle: `HSET channel:presence:{id}`
- on leave: `HDEL channel:presence:{id}`
- if hash becomes empty: `SREM online:channels`
- screening room state is updated on controller actions and periodic playback ticks

## MySQL Tables

- `users`
- `user_credentials`
- `domains`
- `channel_categories`
- `channels`
- `domain_members`
- `messages`

Persisted messages include:

- normal text chat

## Client State

Frontend state slices:

- auth session
- selected domain
- selected channel
- messages
- members
- online counts
- current voice presence
- peer connections
- local media state

## External References Used

- MDN WebRTC signaling and peer connection guidance
- MDN `getDisplayMedia()` and `addTrack()` usage
- Redis command docs for `SADD`, `HSET`, `HDEL`, `SMEMBERS`, `SCARD`
- open-source Discord/WebRTC room patterns, mainly using WebSocket signaling and browser peer connections
