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
