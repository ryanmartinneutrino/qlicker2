# Grading (Developer Notes)

## Scope

Core grading is implemented in:

- `server/src/services/grading.js`
- `server/src/routes/grades.js`
- `client/src/components/grades/CourseGradesPanel.jsx`
- `client/src/components/grades/SessionQuestionGradingPanel.jsx`
- `client/src/components/grades/SpeedGradingModal.jsx`
- `client/src/utils/responses.js`

Session reviewable integration is in:

- `server/src/routes/sessions.js`

## Grading Lifecycle

- Scheduled quizzes with stored `status: visible` automatically transition to `done` on session access after their last time window (including extensions); there is no timer-driven background grading job.
- Grade rows are seeded when a session reaches `status: 'done'`, even if `reviewable` is still `false`.
- Manual mark edits, overall-value edits, recalculation, and AI grading are rejected until the session is ended and no active/upcoming quiz extensions remain. The boundary is inclusive: grading unlocks only after an extension deadline.
- Publishing `reviewable: true` through session updates, `/reviewable`, or `/end` recalculates automatic grades, including incomplete or stale existing rows, and synchronizes student visibility. Manual mark and overall-value overrides are preserved by the grading service. Ending without publication also refreshes existing automatic marks. This repairs the early-end → resume schedule → automatic-close path, which previously retained stale no-response marks.
- An ended quiz can still accept responses from individually authorized extension students. Its instructor status stays `done`; the student's effective status and displayed dates reflect their own access window. Publishing reviewability after extensions finish includes responses received after the initial grade seeding.
- Active or upcoming extensions block review publication. Granting a remaining extension clears `reviewable` and hides previously published grades; restarting a session also clears reviewability. Removing/expiring extensions does not automatically publish grades.

- Reading session grades does not create missing rows. The instructor payload includes `gradingLockReason` (`not-ended`, `extensions`, `missing-grades`, or `null`). The grading panel offers **Create grade items**, using `POST /sessions/:id/grades/recalculate` with `missingOnly: true`, once closure permits grading.
- Manual-grading flags are normalized on reads against current latest responses and question types, including existing production rows. An automatic zero for a nonblank, positive-point short answer remains pending; `automatic: false` records a confirmed score, including zero. No schema migration is needed. Use **Re-calculate all grades** on an already affected ended quiz to persist repaired automatic marks and totals; manual scores are preserved.
- Blank detection includes whitespace, empty rich-text markup, and non-breaking spaces; rich-text-only and image answers count as content. AI grading uses saved response content, regardless of join/submission membership, and rechecks session readiness before saving each result.

## Latest Attempt and Legacy Data

- Per-student grading always uses that student's latest attempt for the question.
- "Latest" means highest `attempt`, with `updatedAt || createdAt` as the tie-breaker.
- The same latest-attempt rule is shared on the client through `client/src/utils/responses.js`; do not duplicate that logic in grading dialogs or review pages.
- Legacy databases may contain duplicate `Grade` rows for the same `{ userId, courseId, sessionId }`. Recalculation and manual mark updates must synchronize all rows for that identity, not just one `_id`.

## Grade Calculation Rules

- SA defaults to `0` points unless explicitly configured in `question.sessionOptions.points`.
- Other question types default to `1` point if unset.
- Supported autogradeable types: MC, TF, MS, NU.
- Attempt weighting uses `question.sessionOptions.maxAttempts` and `attemptWeights`.
- Low-response exclusion: for single-attempt questions only, if unique responders are fewer than 10% of joined students, that question is graded as `outOf=0`.

## Multiple-Select Scoring

- `right-minus-wrong` (default): `max(0, min(1, (2C - S) / K))`
- `all-or-nothing`: exact set match required
- `correctness-ratio`: correctly labeled options / total options

Where:

- `C`: number of selected options that are correct
- `S`: total number of selected options
- `K`: total number of correct options

## Manual Override Semantics

- Mark-level manual override: `mark.automatic = false`. Publication preserves both its points and denominator, even if the question was subsequently excluded or assigned zero points. Explicit instructor recalculation retains the scoring-rule change behavior.
- Grade-level manual override: `grade.automatic = false`.
- Recalculation preserves manual values and emits conflict records in `summary.manualMarkConflicts`.
- `POST /grades/:gradeId/marks/:questionId/set-automatic` restores mark autograding for one mark.
- `POST /grades/:gradeId/value/set-automatic` restores automatic overall grade value.
- Feedback edits keep `feedbackUpdatedAt` in sync so students receive targeted update notifications.

## Route Summary

- `POST /api/v1/sessions/:id/grades/recalculate` (`status: 'done'` only)
- `GET /api/v1/sessions/:id/grades`
- `PATCH /api/v1/sessions/:id/grades/visibility`
- `PATCH /api/v1/grades/:gradeId/marks/:questionId` (`status: 'done'` only)
- `POST /api/v1/grades/:gradeId/marks/:questionId/set-automatic` (`status: 'done'` only)
- `PATCH /api/v1/grades/:gradeId/value` (`status: 'done'` only)
- `POST /api/v1/grades/:gradeId/value/set-automatic` (`status: 'done'` only)
- `GET /api/v1/courses/:courseId/grades`

Related session lifecycle routes:

- `POST /api/v1/sessions/:id/end`
- `PATCH /api/v1/sessions/:id`

## Testing

Server grading coverage:

- `server/test/routes/grades.test.js`
- `server/test/services/grading.test.js`

Client grading coverage:

- `client/src/components/grades/CourseGradesPanel.test.jsx`
- `client/src/components/grades/SessionQuestionGradingPanel.test.jsx`

Run tests:

```bash
npm test --prefix server
```

Frontend validation:

```bash
npm run build --prefix client
npm test --prefix client -- --passWithNoTests
```
