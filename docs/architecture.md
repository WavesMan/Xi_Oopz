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
- `error`

## Redis Strategy

Redis is only used for online room state and fast counts.

Keys:

- `online:channels`
  - set of active voice channel IDs
- `channel:presence:{channelId}`
  - hash keyed by `userId`, value is a JSON payload with mic/screen/display name/avatar color

Lifecycle:

- on join: `SADD online:channels`, `HSET channel:presence:{id}`
- on toggle: `HSET channel:presence:{id}`
- on leave: `HDEL channel:presence:{id}`
- if hash becomes empty: `SREM online:channels`

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
