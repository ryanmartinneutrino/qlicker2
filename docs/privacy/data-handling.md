# Qlicker data handling

This reference describes the React/Fastify implementation reviewed on November 19, 2026. It supports a [deployment privacy notice](notice-template.md); hosting configuration, optional services, modifications, and legacy records require a deployment-specific review. Application permissions and infrastructure access are separate: a database or backup operator may have technical access to records that a Qlicker screen withholds.

## Records and visibility

| Category | Information recorded | Access and purpose |
| --- | --- | --- |
| Accounts and authentication | Names, email addresses and verification status, student numbers when supplied, roles, course associations, profile images, language/theme preferences, password hashes for local accounts, SSO identifiers, login times/IPs, and refresh-session metadata | Account operation and authentication. Course staff can receive relevant roster identity; administrators manage accounts and see login/session audit information. Passwords are stored as hashes, not readable passwords. |
| Course participation | Enrollment, instructor membership, activity-code grants, joins and join times, quiz submission status, and activity relationships | Course administration and participation tracking. A shared-activity grant admits a signed-in account to that activity only; it does not enroll the account or grant course roster, course chat, AI, or library access. |
| Answers and assessment | Answer content, question and attempt, creation/update/submission times, response IPs in named activities, correctness, marks, and feedback | Instructors assigned to the course and administrators can review eligible named results. Students can access their own work according to release rules. Answers are saved during quiz autosave, before final submission; ended-quiz results can include saved answers from people who never submitted. |
| Discussions | Posts, comments, authors or activity pseudonyms, timestamps, votes and voter identifiers, moderation/archive state, and course-chat last-viewed times | Enabled course/session discussions and moderation. Anonymous labels in ordinary chat do not necessarily hide identity from instructors. Anonymous-activity chat hides identities from other participants and instructors. Text can identify its author. |
| Content and notifications | Questions, uploads, profile pictures, notification content and dismissals | Teaching, sharing, account presentation, and communications. Visibility depends on the feature and sharing settings; do not upload confidential material on the assumption that knowing its URL is the only access path. |
| Optional AI | Conversation messages, generated content/artifact references, grading jobs, summaries, instructions, drafts, and grading logs | The configured backend receives prompts and any course/assessment context supplied by the relevant workflow. Conversation routes are scoped to the owner; instructor status does not itself grant browsing of student conversations. Infrastructure operators may have wider technical access. |
| Operations | Application and proxy request logs, errors, system metrics, live-session performance aggregates, and Redis user-activity timestamps when enabled | Troubleshooting, security, and service monitoring. Hosting, proxy, identity-provider, and external monitoring systems may record additional information. Log fields and retention depend on configuration. |

Other participants may see released answer distributions, answer text, and discussion content, including in a classroom presentation. This does not make another student's private gradebook available. Instructors can export permitted results; downloaded copies require institutional handling and retention rules too.

## IP addresses and logs

Named live answers and quiz autosaves store `submittedIpAddress`. Autosaving an answer updates that field, so it is not a complete history of every address used. Anonymous activity writes leave it empty. Login and active authentication-session IP information is separately exposed in administrator account payloads.

**Response IP addresses are not currently restricted to administrators.** `GET /api/v1/sessions/:id/results` permits course instructors and administrators and returns stored named-response objects, including their IP fields. Answer-write responses also return the submitting participant's response object. A field need not appear visibly on screen to be accessible through an API.

Request logs can contain addresses, routes, and timestamps, but they are not guaranteed to preserve a real client IP or establish which person submitted an answer. Proxies, shared networks, configured trust, log rotation, and logging settings affect that evidence. Logging is a separate collection requiring its own purpose, access restrictions, and retention; it is not a justification for retaining response-linked IPs indefinitely.

## What anonymous activities mean

Anonymous activities are anonymous to instructors. An administrator with access to the underlying system can identify a respondent; this is an accepted administrative capability, not an instructor feature. There is no existing administrator UI for reversing the mapping.

Participants still sign in. Response and attendance ownership uses a separate HMAC-derived pseudonym per activity, rather than the account ID. The server recomputes the pseudonym to prevent duplicate responses and show a participant their own work. A database-only copy does not directly reveal the mapping, but someone with the relevant server secret and account identifiers can recompute it. Activity-code grants also retain the account's association with an activity. This is not irreversible anonymization.

Instructor review hides identities and response timestamps and uses respondent labels that link eligible answers within the activity. Four-respondent thresholds and live release batches reduce disclosure from small groups; see the [anonymous survey workflow](../user-manual/professor.md#run-an-anonymous-survey) for the different live, ended, and AI release rules. Anonymous activities have no grades. Named guests have tracked responses without grades until they enroll.

Identifying text or unique answer combinations can also reveal who wrote an answer. The short user notice should explain the instructor/admin distinction without requiring readers to understand the pseudonym implementation.

## Retention and external services

Course-chat retention defaults to 14 days, but expiry marks older posts as archived; it does not erase their content. Backup retention is configured separately, with default counts of seven daily, four weekly, and twelve monthly backups. These counts are not an institutional records-retention schedule. Deleting a live record does not necessarily remove backup or exported copies.

There is no single configurable disposal schedule covering all account, response, assessment, chat, AI, and log data. Operators must establish and verify category-specific disposal, legal holds, backup expiry, and restoration procedures before promising deletion dates.

Optional integrations include SAML identity providers, email delivery, object storage, AI backends, and video services. Identify each actual provider, the data it receives, processing/support locations, retention, and contractual restrictions. A local application server does not imply that all processing stays on campus or in Canada. AI disclosure includes instructor-triggered grading and analysis, not just students choosing to use AI Chat.

The browser uses a refresh authentication cookie and local storage for features including sign-in synchronization, language/format preferences, and AI model selection. Review deployment additions and embedded/external resources before making claims about tracking or third-party cookies.

## Implementation references

- [User model](../../server/src/models/User.js) and [administrator payloads](../../server/src/routes/users.js): `buildAdminUserPayload`.
- [Response model](../../server/src/models/Response.js) and [session routes](../../server/src/routes/sessions.js): answer writes, `/sessions/:id/results`, and `sanitizeAnonymousReviewResponse`.
- [Anonymous participant utilities](../../server/src/utils/anonymousSession.js), [session model](../../server/src/models/Session.js), and [activity grants](../../server/src/models/ActivityGrant.js).
- [Chat model](../../server/src/models/Post.js) and [course-chat routes](../../server/src/routes/courseChat.js): `archiveExpiredCourseChatPosts`.
- [AI routes](../../server/src/routes/ai.js), [conversations](../../server/src/models/AiConversation.js), and [grading logs](../../server/src/models/AiLog.js).
- [Application logging](../../server/src/app.js), [user activity](../../server/src/services/userActivity.js), [browser API client](../../client/src/api/client.js), and [production backup retention](../../production_setup/README.md#backup-retention).
