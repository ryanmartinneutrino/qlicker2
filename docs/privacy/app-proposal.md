# Proposed privacy page and admin controls

**Proposal only. No application changes are included in this PR.** The goal is one short page users can read and a few settings administrators can manage without editing policy text or database records.

## A Privacy link users can find

Add a public `/privacy` page using the plain-language [Your data in Qlicker](notice-template.md) text. Link it from sign-in, registration, the landing page, and the signed-in account menu. Include the link in activity-code entry so guests can find it too. Add a short collection notice beside sign-in/registration, including SSO entry.

Keep the public page focused on what is collected, who can see it, anonymity, external services, retention, and a contact. Keep legal background and implementation details in the operator documentation. Use the existing translation system and accessible page components.

Show the institution's details and effective retention settings automatically. The public page explains that instructor IP access depends on the course. Inside a course or activity, show the actual status: **“Your instructors can see IP addresses recorded with named answers”** or **“Your instructors cannot see response IP addresses.”** Anonymous activities always show their own explanation, regardless of the course setting. Do not expose private course names or settings through the public page.

## Admin → Privacy

Provide a preview of exactly what users will see, with these settings:

| Setting | Admin experience |
| --- | --- |
| Institution and contact | Institution name, privacy email, phone, office title/address, and institutional policy link |
| Collection notice | A short institution-approved statement of purpose and legal authority |
| External services | Plain descriptions of hosting, email, storage, video, and AI providers and processing locations; highlight enabled integrations missing a description |
| Retention | Periods and starting events described below, plus cleanup status |
| Instructor IP access | Searchable course list with an admin-only toggle, following the existing video/AI course controls |

Use structured fields and a small optional institution-specific paragraph rather than a general policy editor. Record the published version/date and changes to privacy settings. Warn administrators about missing institution details; show an honest “not configured” state instead of inventing a contact or deletion period.

## Retention that actually removes data

Use the admin interface for normal configuration. Production `.env` overrides may lock individual retention values for centrally managed deployments. An override wins over the database setting, appears read-only with **“Managed by server configuration”**, and supplies the same effective value to cleanup and the public notice. Removing an override restores the saved admin value. These overrides do not exist yet.

Keep retention categories separate so an institution can remove response IPs sooner than coursework:

| Category | Proposed starting event and action |
| --- | --- |
| Response IPs | Days after the answer's last save; clear the IP field and keep the answer, grade, and timestamps |
| Sign-in audit information | Days after the recorded event; clear expired audit information without breaking active authentication sessions |
| Coursework | Period after an explicit course closure date; remove linked participation, answers, and grades together only when the course is eligible |
| Chat | Days after the last activity on a thread; delete eligible threads, separately from the current archive setting |
| AI history and logs | Days after the last conversation activity or job completion; remove eligible history, logs, and associated artifacts |
| Inactive accounts | Period after last activity; delete only when no retained coursework or other required records depend on the account |

An unset period means **“Automatic deletion not configured”**, not a guessed default. Do not silently start deleting existing data on upgrade. Before enabling cleanup or shortening a period, show affected record counts and ask the admin to apply the change. Support a preservation hold for records needed for an appeal or investigation. Periods must follow the institution's approved schedule; see [Ontario guidance](ontario-deployment.md).

Run cleanup regularly, show the last successful run and any failures, and test it on linked records as well as individual fields. Backups keep their existing separate controls. App/proxy logs need deployment-level rotation settings; display their configured policy without claiming the app can erase externally managed logs. Explain backup expiry and require restored data to pass through the same cleanup/hold rules before normal use. Downloaded exports remain the institution's responsibility.

## Per-course instructor access to response IPs

Add **“Allow instructors to view response IP addresses”**, default **off**, controlled only by administrators. Use the existing admin course selection pattern for video and AI. Teachers can see whether it is enabled but cannot enable it themselves.

| Viewer | Named activity, toggle off | Named activity, toggle on | Anonymous activity |
| --- | --- | --- | --- |
| Student or guest | No access to others' IPs | No access to others' IPs | No response IP collected |
| Assigned instructor/TA | No response IP access | Response IPs available in review | No response IP collected; no identity disclosure |
| Administrator | Response IPs available in review | Response IPs available in review | No response IP collected; existing ability to identify accounts through the underlying system remains |

The toggle controls access, not collection or retention. Turning it on exposes retained IPs for earlier named answers too; explain this beside the toggle. Turning it off removes access on subsequent requests and clears visible/cached details, but cannot recall downloaded copies. Publish the changed course notice when the setting changes.

Enforce the permission on the server for every results, response-detail, export, and WebSocket path. Do not send restricted IPs and merely hide their column. Keep response IPs out of class presentations, student broadcasts, and AI context; permission for a teacher to inspect an IP does not imply sending it to an AI provider. The course toggle must never bypass anonymous-session identity or release protections.

## Where instructors and admins see IPs

Add a **Response details** action to a student's named-session review. An authorized viewer sees question, attempt, saved/submitted time, and IP address. For quiz autosaves, label the IP as the **last saved answer's IP**, since the existing field is updated on each save. Show “Not recorded” or “Removed under the retention policy” where that distinction is known; never guess a historical address from unrelated logs.

Keep the panel usable on phones and by keyboard. Offer an explicit **Include response IP addresses** option on result exports only for authorized viewers, unchecked by default. Record who viewed or exported response IPs and which activity was involved without copying the IP values into another audit log.

Explain briefly: an IP identifies a network connection, not necessarily one person or physical location. It should not be treated as proof of misconduct on its own.

## Anonymous activity wording

Use the same short explanation in the privacy page, instructor setup, and participant notice:

> Anonymous activities hide your identity from instructors. Administrators with access to the underlying system can identify the account behind a response. Avoid identifying yourself in your answer text.

Keep the existing pseudonyms, minimum-response release rules, linked respondent rows, and no-grade behavior. This proposal does not add an instructor override or a new administrator screen for identifying anonymous respondents.

## Implementation checks

Before shipping, verify the off/on permission matrix, unauthorized courses, anonymous activities, old responses, and permission changes during an open review. Check HTTP, WebSockets, exports, and AI paths. Verify that retention clears only the intended fields/records, respects holds, and reports failures. Confirm the privacy page matches effective settings, remains accessible without signing in, and has translated interface text.
