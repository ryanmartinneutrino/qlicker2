# Repairing shared question references

The library-copy bug could save the same question ID in multiple positions of a session. Older workflows could also attach a library or another session's question directly. Student responses are keyed by question ID, so those positions share one answer.

Deploy the copy fix before repairing data. The repair utility is `server/scripts/repair-question-references.js`; it is also included in the server image at `/app/scripts/repair-question-references.js`.

## Audit first

From a repository checkout with server dependencies installed:

```bash
node server/scripts/repair-question-references.js
node server/scripts/repair-question-references.js --session SESSION_ID
node server/scripts/repair-question-references.js --course COURSE_ID
```

The script reads `MONGO_URI` or `MONGO_PORT` from the environment or the root/server `.env`. It never prints the connection URI. Without `--apply`, it performs no writes, including collection/index creation. Each affected session produces a JSON report containing IDs and one-based positions, followed by a summary. No student answers or names are printed.

Reports use these statuses:

| Status | Meaning |
| --- | --- |
| `would-repair` | A hidden session with no participation, responses, or grades can be repaired. |
| `manual-review` | History, visibility, or missing question documents prevents automatic repair. Reasons are included. |
| `repaired` | Independent question copies were created and linked. |
| `conflict` | The session changed during repair; the replacement was rejected and new copies removed. |
| `unchanged` | No duplicate or foreign references remain; counted in the summary only. |

Exit code `0` means the audit/apply completed with no blocked cases. Code `2` means a session needs manual review, a conflict occurred, or the selection matched nothing. Code `1` indicates an execution error. A run can repair eligible sessions and still exit `2` because other sessions were blocked.

## Apply to unused drafts

1. Back up MongoDB and test the repair on a restored copy first.
2. Stop **all** application instances and other database writers; leave MongoDB running. The session snapshot check cannot prevent a response or grade being inserted concurrently in another collection.
3. Apply to a specific session, review the report, and run the audit again:

   ```bash
   node server/scripts/repair-question-references.js --session SESSION_ID --apply
   node server/scripts/repair-question-references.js --session SESSION_ID
   ```

4. Restart the application and verify question order, content, answers, points, and visibility before opening the quiz.

For production Docker deployments, use the updated server image:

```bash
cd production_setup
./backup.sh --label manual
docker compose run --rm --no-deps server node scripts/repair-question-references.js --session SESSION_ID
# After reviewing the audit, stop application writers before applying.
docker compose stop nginx server client
docker compose run --rm --no-deps server node scripts/repair-question-references.js --session SESSION_ID --apply
docker compose run --rm --no-deps server node scripts/repair-question-references.js --session SESSION_ID
docker compose up -d server client nginx
```

The first occurrence of a question owned by the target session is retained. Later occurrences become fresh copies. Foreign references are copied even at their first occurrence. The repair preserves ordering, point/attempt configuration, correct answers, solutions, provenance, and unknown legacy question fields. Copies receive fresh Meteor-compatible string IDs and reset live response/statistics state. The current-question pointer is updated when its source was copied. Responses and grades are never changed.

Re-running a successful repair makes no further copies. Failed insertions and rejected session updates clean up known unattached copies. A process crash or an uncertain database write can leave unattached question documents; inspect the backup and affected session before deleting anything. They are deliberately retained if deleting them might break a successfully updated session. Restore the backup with application writers stopped if a full rollback is needed.

## Quizzes that already have answers or grades

Automatic repair is deliberately blocked if **any** referenced question has responses or grade marks, even in another session, or if the session has grade rows or participation records. This includes manual grade overrides. Hiding an answered quiz does not bypass these checks.

A shared question ID has only one response history per student/attempt. There is no reliable record of which duplicate position the student intended to answer. Choose an academic resolution before changing that history:

- **Remove accidental duplicate positions:** retain the original question ID and its responses. Review the assessment denominator and participation counts, then deliberately recalculate automatic grades while preserving manual overrides. This changes the effective question count.
- **Require independent answers:** create fresh copies for the duplicate positions and arrange a new attempt or replacement assessment. Do not invent separate historical answers.
- **Count the shared answer more than once:** only if the instructor explicitly decides that this is fair. This needs a separate, reviewed response/grade migration; the utility does not duplicate credit automatically.

If the intended second question was different but its content was never saved, recover it from a known backup or recreate it. Generating a new ID cannot reconstruct missing content.

For shared references across sessions, response rows do not store a session ID. Session membership alone may be ambiguous, especially when the same student attended both sessions. Handle those records individually; do not assign responses to a session by guesswork.
