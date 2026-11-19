# Ontario institutional deployment guidance

Use this guidance with the [notice template](notice-template.md) and [technical reference](data-handling.md). It reflects sources reviewed on November 19, 2026. The institution's privacy office should confirm applicability and current requirements before adoption. A published notice supports transparency; compliance also depends on lawful practices, contracts, controls, and institutional decisions.

## Applicable framework

Ontario public universities generally fall under the Freedom of Information and Protection of Privacy Act (FIPPA); public school boards fall under its municipal counterpart, MFIPPA. Private institutions and commercial service providers need a separate applicability assessment. See Ontario's [institutional roles and coverage guidance](https://www.ontario.ca/document/freedom-information-and-protection-privacy-manual/chapter-2-government-roles-and-responsibilities).

PIPEDA is not generally the governing law for the core educational activities of public universities and schools. Commercial activities or providers can raise additional obligations. See the federal privacy commissioner's [MUSH-sector interpretation](https://www.priv.gc.ca/en/privacy-topics/privacy-laws-in-canada/the-personal-information-protection-and-electronic-documents-act-pipeda/r_o_p/02_05_d_25/).

## Institutional decisions before collection

1. **Establish authority and necessity.** Identify the institution's enabling authority and why each category is necessary. FIPPA section 38(2) and MFIPPA section 28(2) constrain collection. Do not simply insert “FIPPA” as a universal authorization, or treat a compulsory-course consent checkbox as a substitute for lawful collection. Assess response-linked IP storage separately from operational logging.
2. **Provide collection notice.** FIPPA section 39(2) and MFIPPA section 29(2) address notice of legal authority, principal purposes, and the title, business address, and business telephone number of an official who can answer collection questions. Add email and an accessible full notice. Place short notices at the relevant collection points, including SSO onboarding and guest entry. Ontario's [privacy fundamentals guidance](https://www.ontario.ca/document/freedom-information-and-protection-privacy-manual/chapter-7-privacy-fundamentals) explains collection, notice, use, disclosure, and retention.
3. **Complete the privacy impact assessment.** FIPPA's mandatory PIA requirements took effect July 1, 2025; equivalent MFIPPA requirements take effect January 1, 2027. Review collection and significant changes to uses/disclosures, including new AI services. Use the IPC's [PIA guide](https://www.ipc.on.ca/en/resources/planning-success-privacy-impact-assessment-guide-ontarios-public-institutions).
4. **Assign operational responsibility.** Name the service owner, privacy contact, records owner, incident lead, and staff authorized for support or investigations. Apply least privilege to the app, database, logs, exports, secrets, and backups. A technical ability to read data is not permission to use it for unrelated purposes.
5. **Review service arrangements.** Document hosting, SSO, email, storage, AI, video, and monitoring providers. Confirm processing and support locations, subcontractors, permitted uses, training restrictions where relevant, deletion, incident cooperation, and exit/return arrangements. Canadian hosting alone does not establish compliance or ensure that every integration processes data in Canada.

The governing texts are [FIPPA](https://www.ontario.ca/laws/statute/90f31) and [MFIPPA](https://www.ontario.ca/laws/statute/90m56). The notice should accurately describe the approved practice, rather than expand permission through broad wording.

## Retention, rights, and incidents

Set schedules by record category and specify when each period starts. Under FIPPA's [Regulation 460, section 5](https://www.ontario.ca/laws/regulation/900460), personal information used by an institution generally must be retained for at least one year after use, subject to specified exceptions. School boards must assess the distinct rule in [Regulation 823, section 5](https://www.ontario.ca/laws/regulation/900823), including applicable institutional by-laws or resolutions. Do not apply a blanket short log or answer deletion period without checking whether information was used and must be preserved.

Account for grade appeals, access requests, investigations, legal holds, downloaded CSVs, archived discussions, AI outputs/logs, and backups. Test disposal and restoration procedures. Qlicker's chat archive setting and backup counts do not implement a complete records schedule.

Provide a practical access/correction process and route complaints to the privacy office. Explain the separate academic process for disputing grades; do not promise an unconditional right to erase assessment records. The IPC describes its [privacy complaints process](https://www.ipc.on.ca/en/resources/privacy-complaints-process).

Maintain an incident response process that assesses harm and handles notification, reporting, and records of breaches. FIPPA's new breach duties have applied since July 1, 2025; equivalent MFIPPA duties begin January 1, 2027. See the IPC's [current obligations and effective dates](https://www.ipc.on.ca/en/resources/fippa-mfippa-updates), including the real-risk-of-significant-harm threshold and other prescribed circumstances.

For schools, use age-appropriate explanations and review parent/guardian involvement and educational alternatives with the board. The IPC's [Digital Privacy Charter for Ontario Schools](https://www.ipc.on.ca/en/digital-privacy-charter-ontario-schools-pledge) offers relevant principles on necessity, providers, transparency, and children's interests. Research reuse and sensitive surveys require their own institutional assessment; enabling anonymous mode does not replace it.

## Recommended application changes

These are recommendations, not implemented controls. Existing app code is unchanged by this documentation.

| Priority | Recommendation | Acceptance evidence |
| --- | --- | --- |
| First | Decide whether response IPs are necessary; if retained, remove them from instructor-facing payloads and expose them only through an expressly authorized administrative path. | Permission tests across HTTP, WebSockets, exports, and AI paths; an IP hidden in the UI must not remain retrievable by instructors. Preserve the blank IP field for anonymous responses. |
| First | Add a public deployment privacy page or institutional notice link, short collection notices, effective date/version, and administrator configuration with a preview. | Accessible links before login/SSO/registration and guest participation, plus signed-in navigation; localized interface text; no fabricated institutional policy when unconfigured. |
| First | Establish category-specific retention and disposal, with legal holds, backup handling, and safe operator review. | Verified deletion/anonymization outcomes and restoration behavior; explicitly distinguish archive from erasure. |
| Next | Explain anonymous-mode limits where it is selected and where participants answer; review existing suggestions to use it for sensitive check-ins. | Copy matches pseudonym handling and release rules, without promising untraceability or irreversible anonymization. |
| Next | Make enabled providers and AI data flows visible and subject to institutional approval. | Notices cover instructor-triggered grading/analysis as well as student AI Chat; provider changes trigger review before use. |
| Next | Strengthen privileged-access accountability and access/correction workflows. | Restricted, retained audit events for sensitive administrative actions and verified exports that avoid disclosing other people's information. |

An initial implementation can link to an institution-hosted notice rather than build a policy editor. Avoid requiring blanket consent to ordinary authorized educational processing; use separate consent only where the institution determines it is the appropriate basis. Keep historical notice versions for accountability without treating a recorded acknowledgment as authorization for every future use.
