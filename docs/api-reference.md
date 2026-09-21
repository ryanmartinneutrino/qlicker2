# API and Realtime Reference

Qlicker's Fastify route schemas are the authoritative machine-readable API reference. This page explains how to access them and maps the major API/realtime areas; it is not a hand-maintained list of all 200+ operations.

## Generated OpenAPI documentation

Set `ENABLE_API_DOCS=true` for a trusted development/administration environment, start the server, then use:

- Swagger UI: `http://localhost:3001/docs`
- OpenAPI JSON: `http://localhost:3001/docs/json`

The Swagger UI is admin-protected. Production defaults keep it disabled on internet-facing installations. Do not enable it publicly just for convenience.

Fastify schemas supply parameters, request bodies, response shapes, tags, and bearer-auth metadata. If generated documentation and a prose example disagree, fix the route schema and implementation together.

## Conventions

- Versioned REST routes use `/api/v1`.
- Authenticated API requests generally use `Authorization: Bearer <access-token>`.
- State-changing browser requests also carry `X-Requested-With: XMLHttpRequest` for the CSRF policy.
- Access tokens are short-lived; the browser uses an HTTP-only refresh cookie to obtain a new token within the configured session hard expiry.
- Normal API errors use `{ "error": "...", "message": "..." }`.
- Legacy SAML aliases remain outside the versioned prefix for identity-provider compatibility.
- Uploaded images are read through authenticated `/uploads/<key>` paths.

## Route families

| Prefix/area | Responsibilities |
| --- | --- |
| `/api/v1/auth` and legacy SAML paths | Registration, login/logout, refresh, email verification, reset, SAML metadata/callback/logout |
| `/api/v1/users` | Current profile/avatar/password plus admin account search, creation, role, state, properties, and password support |
| `/api/v1/settings` | Public settings, admin configuration, backup health, storage, SAML, video, and AI policy |
| `/api/v1/courses` | Course CRUD, enrollment, rosters, sessions, groups, grades, and course video endpoints |
| `/api/v1/sessions` | Session CRUD/copy/import/export, live state/actions, quiz saves/submission, review, grading integration, and session chat |
| `/api/v1/questions` and course/session question paths | Question CRUD, visibility, library search/copy/import/export, aggregates, and ordering |
| `/api/v1/grades` and course/session grade paths | Grade tables, recalculation, point/feedback/manual overrides, visibility, and CSV data |
| `/api/v1/.../chat` | Course/session posts, comments, votes, quick posts, moderation, settings, summaries, and review payloads |
| `/api/v1/notifications` | System/course notice management, active notices, dismissal, and feedback notifications |
| `/api/v1/ai` and `/ai` media proxy | Admin/course AI configuration, chats, tool-backed operations, histories, rubrics, and allowlisted media |
| `/api/v1/images` and `/uploads/*` | Validated image write/delete and authenticated reads across local/S3/Azure storage |
| `/api/v1/health` | Process health timestamp plus WebSocket/Redis availability |

Permission checks vary by operation. A global professor role and course instructor membership are not interchangeable; API tests should cover unauthenticated, wrong-role, and non-member access.

## Quiz extensions and review access

`GET /api/v1/courses/:courseId/sessions`, `GET /api/v1/sessions/:id`, and `PATCH /api/v1/sessions/:id` return the same user-specific effective `session.status` and extension flags. PATCH accepts the stored status: `hidden` hides access, `visible` enables the quiz schedule, `running` explicitly opens access regardless of dates, and `done` closes general access while honoring individual extensions. A successful PATCH to `visible` can therefore return `running` or `done`. Clients must use the returned status rather than recalculate it from dates. See the [session lifecycle](developer/data-model.md#session-status-and-quiz-access).

`PATCH /api/v1/sessions/:id/extensions` assigns individual quiz windows to enrolled students, including when the stored session status is `done`. Students with an active extension receive effective status `running` and their own `quizStart`/`quizEnd` in session payloads; an upcoming extension is `visible`. The instructor still sees the ended status. Saving and submitting enforce the individual window, enrollment, and existing submission locks.

Session payloads expose `quizHasActiveExtensions`, `activeExtensionsCount`, and `quizHasRemainingExtensions` (active or upcoming). Remaining extensions block review publication through generic session updates, `/reviewable`, and `/end`. Granting a remaining extension clears reviewability and student-visible grades. Expiry or removal does not automatically republish results.

Publishing `reviewable: true` through `PATCH /sessions/:id`, `PATCH /sessions/:id/reviewable`, or `POST /sessions/:id/end` recalculates automatic grades, including existing grade rows, and preserves manual overrides. The grading summary reports outstanding manual grading.

## Question copies and ordering

`POST /questions/:id/copy-to-session` always creates a fresh question ID. `POST /sessions/:sessionId/questions` attaches a newly created question belonging to that session if it is not yet listed; otherwise it copies the source. Library insertion uses the explicit copy endpoint. Session copies and practice-question selection also create independent question documents. `PATCH /sessions/:sessionId/questions/order` rejects duplicate IDs and newly added references to questions belonging outside the session with HTTP 400.

## Admin system-monitoring query

`GET /api/v1/users/admin/system-monitoring?range=24h` requires an authenticated administrator. `range` accepts `6h`, `24h` (default), or `7d`; invalid values return 400. The response includes `status` (`healthy`, `stale`, `unavailable`), `latest`, downsampled `history`, up to five `peakPeriods`, up to 50 seven-day collector `events`, `generatedAt`, `retentionDays`, and `bucketSeconds` (60, 300, or 1800).

Missing measurements are `null`. Resource history fields are bucket averages; activity fields are bucket maxima. The endpoint caches each range for 30 seconds per API process, coalesces concurrent reads, and caps database queries at 20,161 samples and two seconds. This is a single-host collector contract; see [metric definitions](user-manual/admin.md#understand-the-measurements). There is no metric-ingestion or arbitrary-log-reading HTTP endpoint: the collector writes directly to MongoDB.

`latest.memory` includes `usedBytes`, `totalBytes`, `availableBytes`, and `usedPercent` for the whole host. `latest.network.interfaces` identifies the selected measurement interfaces; rate fields are bytes per second, not bits. Automatic selection prefers non-tunnel default routes to avoid counting a VPN and its uplink together. A missing explicitly selected interface reports unavailable network counters/rates rather than substituting other interfaces. The sample timestamp uses wall-clock time, while new collector snapshots use monotonic elapsed time to calculate rates.

## WebSocket connection

The browser connects to:

```text
ws://localhost:3001/ws?token=<access-token>
```

The native browser WebSocket API cannot set an Authorization header, so the access token is passed in the query string. Do not log or share the full URL. The server verifies the token, limits incoming messages, closes the socket at token expiry, and clients reconnect after refresh. Production uses `wss://` behind TLS.

Server messages have an event name and data payload. Important event families include:

- `session:question-changed`, `session:question-updated`, and `session:status-changed`
- `session:response-added`, `session:attempt-changed`, and aggregate/statistics updates
- `session:participant-joined`, join-code, visibility, and quiz-submission updates
- `session:chat-settings-changed` and `session:chat-updated`
- `session:feedback-updated`
- course question/library and course-chat updates
- notification updates
- `video:updated`

Clients should patch local state when the delta is sufficient and perform a targeted refresh for legacy/incomplete payloads. Do not respond to a high-frequency event with an unconditional full-session refetch.

`session:response-added` carries the single submitted response when the viewer
may see it. Multiple-choice statistics include the small option distribution;
short-answer and numerical statistics include updated totals or summary fields
without repeating the accumulated answer/value arrays. Clients append the new
response to their existing snapshot.

Instructor `session:question-changed`, `session:visibility-changed`,
`session:question-updated` (for the current question), and `session:response-added`
events also include an `audience` payload for presentation windows authenticated
as the instructor. This uses the same public question/statistics projection as
student events; `audience: null` on a response event means statistics are not
shared. Presentation clients must consume this projection, or refresh
`GET /sessions/:id/live?view=presentation` when an older event omits it. That
endpoint returns the student visibility flags and sanitized question/statistics,
alongside presentation session details such as the join code. It omits student
names and hidden response lists.

Redis publishes user-targeted/broadcast events between API replicas. Without Redis, WebSockets work only within a single server process.

## Adding or changing an endpoint

1. Define/update Fastify request and response schema.
2. Apply authentication, global role, and resource-membership checks.
3. Validate imported content, external URLs, IDs, paging, and limits.
4. Keep errors/status codes consistent.
5. Add success, validation, and authorization tests.
6. Update the client and any WebSocket delta/fallback contract.
7. Start with `ENABLE_API_DOCS=true` and inspect `/docs` and `/docs/json`.
8. Update this overview only when the route family or integration contract changes.
9. Update user/developer/operations manuals when behavior is visible outside the API.

## Local verification

```bash
npm test --prefix server
npm test --prefix client
npm run build --prefix client
./scripts/qlicker.sh e2e
```

For authentication, SSO, uploads, AI URL policy, grading, or WebSocket changes, add focused security/permission cases rather than relying only on the broad suite.

## Grading readiness

`GET /api/v1/sessions/:id/grades` reads existing grades without creating missing rows. Instructor responses include `gradingLockReason`: `not-ended`, `extensions`, `missing-grades`, or `null`. Active and upcoming extensions prevent grading even when the stored session status is `done`.

`POST /api/v1/sessions/:id/grades/recalculate` with `{ "missingOnly": true }` explicitly creates missing grade items. Recalculation, manual mark/value updates (including bulk updates and resetting automatic scoring), and starting AI grading return `409` until the session and all extension windows have ended. Existing instructor authorization checks still apply. Grade reads derive pending manual work from current responses; a confirmed manual zero remains graded.
