# Grading Guide

This guide explains how Qlicker turns participation and responses into visible grades. It supplements the [Professor manual](professor.md) and [Student manual](student.md).

## The grading lifecycle

```text
Students respond → instructor ends session → grade rows are created/recalculated
                  → manual work is completed → reviewability releases results
```

These states are intentionally separate:

- **Running/visible** controls participation.
- **Ended** unlocks instructor grading and creates grade items.
- **Reviewable** controls whether students can see the session/grade under the student workflow.
- Grade visibility can be managed while corrections or manual work are underway.

An instructor can review live response data while an interactive session is running, but cannot edit/recalculate grades until it ends.

## Instructor workflow

1. End the activity.
2. Open session **Review → Grading**, or open course **Grades**.
3. Recalculate when grades have not been created or scoring/content changed.
4. Resolve warnings and manually grade short-answer responses.
5. Add actionable feedback.
6. Confirm question points, total points, percentages, and participation.
7. Make the session reviewable/visible when release is intended.
8. Export CSV and inspect the selected columns before importing elsewhere.

![Course grade table with one completed quiz selected](../assets/manuals/professor-grades.png)

In the course table, select sessions through **Show Grade Table**. Select a percentage to inspect one student's grade, then select a question label such as `Q1(MC)` or `Q2(SA)` for the response and mark editor.

## Automatic scoring

Qlicker automatically grades:

- multiple choice
- true/false
- multi-select
- numerical responses (using the configured correct value/tolerance)

Short answer normally requires manual grading. If points are not set, short answer defaults to `0` while other answerable types default to `1`; instructors should set deliberate point values before delivery.

When a student has multiple responses, grading uses that student's latest attempt for the question, based on attempt number and response update time.

### Multi-select methods

The session editor selects one method:

| Method | Meaning |
| --- | --- |
| Right minus wrong | Rewards correct selections, subtracts for incorrect selections, and never goes below zero |
| All or nothing | Awards credit only for the exact correct set |
| Correctness ratio | Awards a proportional score based on correctly classified options |

Explain the selected policy before students begin. A learner may make different choices when wrong selections are penalized.

### Low-participation exclusion

For a single-attempt question, if unique responders are fewer than 10% of the students who joined, the question is treated as `outOf = 0`. This prevents a nearly unused question from distorting grades. Check joined/responded counts when a question unexpectedly contributes no points.

### Blank short answers

A submitted blank short answer counts as participation but is automatically worth zero and does not remain in the manual-grading queue.

## Manual marks and feedback

Open the question detail from the course grade table or session grading view:

1. Read the exact prompt, response, and attempt.
2. Enter manual points within the allowed total.
3. Write feedback that identifies the next useful action.
4. Save and verify that the overall grade updates.

A manually edited question mark is an override. Recalculation preserves it and reports a conflict if the new automatic value differs. You can explicitly restore automatic scoring for an autogradeable mark or the overall value.

Good feedback is brief and specific: “Your setup is correct; explain why the membrane is selectively permeable” is more useful than “needs work.” Publishing new feedback creates a student notification.

## Changing points after delivery

Changing a question's point value from session review prompts for confirmation and recalculates the whole session. Existing manual marks remain preserved, but the total/percentage may change.

Before confirming:

- verify that the new point value is intentional
- tell the teaching team that percentages may change
- review conflicts after recalculation
- re-export any grade file created earlier

Avoid changing the meaning/correct answer of a question after students have responded. Some edits are restricted for this reason.

## Student visibility

Students see only their own grades and only activities released through the current reviewability/visibility rules. They may see:

- their submitted answer and attempt
- released correct answer and solution
- earned/possible points
- instructor feedback
- participation information

They do not see instructor-only grading conflicts or other students' identities/marks. A non-reviewable activity can be present in instructor grade data while absent from the student's course/grade view.

## Recalculation scenarios

### New completed session

End the session and recalculate if the grade rows are not already available. Resolve any short-answer/manual warnings before release.

### Correct answer or scoring rule changed

Recalculate, inspect conflict/warning summaries, sample several students, and communicate material grade changes.

### Late manual grade

Open the specific student/question, save the mark and feedback, and confirm the overall percentage. A full recalculation is not normally needed just to save a manual mark.

### Manual mark conflicts with automatic score

Keep the manual mark if it represents an intentional academic decision. Accept/restore automatic only after confirming the configured answer/scoring rule is correct.

### A zero-point question says it needs grading

Zero-point items should not require grading even if an older record contains a stale flag. Check the actual point value and current visual cue before doing unnecessary manual work.

## Export checklist

Before using **Export grades to CSV**:

- select the intended sessions/columns
- confirm manual grading is complete
- confirm reviewability/visibility separately (export does not publish)
- open the CSV and spot-check names, session headings, and percentages
- store the file according to institutional privacy policy

CSV is a transfer/report file, not a Qlicker database backup.

## Troubleshooting

### Grading controls are locked

The session is probably still running/visible rather than ended. End it first.

### A student has no grade

Confirm enrollment, participation/submission, session ended state, and whether grade recalculation completed. For a quiz, confirm final submission and availability rules.

### A grade changed after recalculation

Check the correct answer, point value, multi-select method, numerical tolerance, latest attempt, and low-participation rule. Manual overrides should be preserved and listed as conflicts rather than silently replaced.

### A student cannot see a grade

Confirm the activity is reviewable and its grade is visible to students. Manual grading can exist instructor-side before release.

### Duplicate or inconsistent legacy rows appear

Do not fix production data manually in MongoDB. Operators/developers should back up first and use the documented maintenance scripts and current server protections; see [developer grading notes](../developer/grading.md).
