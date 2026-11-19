# Deployment privacy notice template

**Operator instructions — remove this section before publication.** Complete every bracketed field, remove unused optional-service rows, and verify the wording against your deployed version using the [data-handling reference](data-handling.md). Have the institution's privacy office approve the notice and the operational practices behind it. This draft does not itself authorize collection or establish legal compliance. Publish accessible, institution-approved translations as needed.

The IP-address paragraph below describes the current application. Do not replace it with an administrator-only promise until the relevant API restrictions have been implemented and tested. Retention entries must describe enforceable schedules, including backups and exports. Avoid a generic “by using this service you consent to everything” clause.

---

# Privacy notice for [institution]'s Qlicker service

Effective date: [date]. Notice version: [version]. Service address: [deployment URL].

## Who operates this service

[Institution's legal name] operates this Qlicker service for [teaching, classroom participation, assessment, and other actual purposes]. This notice applies to students, instructors, teaching assistants, administrators, and signed-in guests using this deployment. Our institutional privacy policy is available at [policy URL].

Questions about collection can be directed to [official's position title], [business postal address], [business telephone number], [email]. The privacy office can be reached at [contact and website]. Technical support is available at [support contact].

## Why we collect information

We collect information under [specific enabling statute and section or other applicable legal authority, approved by the institution]. We use it to [state the actual principal purposes, such as authenticate accounts, deliver teaching activities, record participation, assess coursework, provide feedback, and operate and secure the service]. [Describe any additional authorized use separately.]

[Explain which activities and information are required for the course, which are optional, and the practical consequences of not providing them. Give the contact and process for available alternatives or accommodations. Describe any separately authorized research or academic-integrity use explicitly; do not imply that ordinary classroom participation authorizes all later uses.]

## What we record

- Account and identity information: [actual local-account and SSO fields, including name, email, student number where supplied, role, profile image, and preferences].
- Course and activity information: enrollment and activity access, joins, submitted answers, attempts, timestamps, quiz submission status, marks, and feedback. Quiz answers can be saved before you select Submit, and saved unsubmitted answers can be included after a quiz ends.
- Discussion and content: posts, comments, votes, relevant viewing/moderation records, and files or questions you supply.
- Security and service information: login/session IP addresses and times, IP addresses associated with named responses, and [actual application, proxy, identity-provider, and monitoring log fields].
- Optional features: [AI conversations and processing, video, or other enabled services; remove features not used].

Information comes from you, [the institutional identity provider or enrollment source], and your interactions with the service. The service uses authentication cookies and browser storage for sign-in and preferences. [Describe other cookies, external resources, or analytics actually used.]

## Who can see information

**Your instructors and authorized teaching assistants** can access relevant course identities, participation, named responses, timestamps, marks, feedback, and moderation information according to their assigned permissions. They can export permitted results. In the current Qlicker version, authorized course instructors can also retrieve the IP addresses stored with named responses through the results API.

**Other participants** can see discussion content and any answers or statistics released for viewing, including in classroom presentations. Your private grades are not generally shared with classmates. Ordinary chat's anonymous labels may hide your identity from classmates while allowing instructors to identify you for moderation.

**Administrators and technical operators** have access appropriate to [describe approved responsibilities and controls]. Qlicker administrators can see login and active-session IP information. Authorized database, hosting, backup, or support personnel may have technical access beyond what teaching screens show. [Identify the teams/providers and approved purposes; describe any investigation or exceptional-access procedure.]

**Service providers** receive information as described below. [Describe other authorized disclosures, including legally required disclosures, with institutional review.]

## Anonymous activities

An activity explicitly marked anonymous hides your identity in instructor results and applies minimum-response release rules. It has no grades. Eligible answers from the same participant can still appear together under a respondent label.

You still sign in. Qlicker stores activity-specific pseudonyms that its server can recompute for your account, and it does not store your IP address in the anonymous response record. Authentication records, activity access records, and infrastructure logs may still exist. Authorized personnel with sufficient technical access may be able to associate participation with an account. Identifying details in your answers can also reveal who you are. Anonymous mode therefore does not guarantee that identification is impossible.

## Providers and locations

| Service | Provider and purpose | Information received | Processing, storage, and support locations | Provider retention and privacy terms |
| --- | --- | --- | --- | --- |
| Hosting, database, and backups | [complete] | [complete] | [complete] | [complete] |
| Institutional sign-in | [complete] | [complete] | [complete] | [complete] |
| Email | [complete] | [complete] | [complete] | [complete] |
| File storage | [complete or remove] | [complete] | [complete] | [complete] |
| AI | [complete or remove] | [prompts, answers, course context, other actual data] | [complete] | [retention, training use, contractual terms] |
| Video and other services | [complete or remove] | [complete] | [complete] | [complete] |

[Explain applicable cross-border processing and access. For AI, explain whether instructors use it for response analysis or grading, who reviews results, how students can question an outcome, and any available alternatives. Distinguish private conversations from provider/operator access.]

## How long information is kept

| Information | Retention period and starting event | Disposal or anonymization process |
| --- | --- | --- |
| Accounts and authentication records | [complete] | [complete] |
| Enrollment, participation, answers, marks, and feedback | [complete] | [complete] |
| Response IP addresses | [complete] | [complete] |
| Discussions, uploads, and notifications | [complete] | [complete] |
| AI conversations, outputs, and logs | [complete or remove] | [complete] |
| Application, proxy, and security logs | [complete] | [complete] |
| Backups and exported copies | [complete] | [complete] |

Archiving a discussion or closing an account does not necessarily delete its records. [Explain backup expiry, restrictions on backup use, restoration handling, and any legal/appeal holds that extend retention.]

## Access, correction, and concerns

You can view [available account and released coursework information] in Qlicker. To request access to other personal information, request correction, or raise a concern, contact [institutional process and privacy office]. [Explain applicable rights, limits, and the separate process for contesting grades.] Requests for deletion are considered under applicable law and institutional retention obligations; immediate deletion of all records is not guaranteed.

[For applicable Ontario institutions: explain the right to complain or appeal to the Information and Privacy Commissioner of Ontario, and link to the appropriate IPC process. Provide the institution's incident-reporting contact and explain how legally required breach notifications will be delivered.]

## Changes to this notice

[Explain where updates and previous versions are available, how material changes are communicated before a new practice begins, and how additional notice or consent is obtained when required.]
