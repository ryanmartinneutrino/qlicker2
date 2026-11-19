# Privacy in Qlicker deployments

Qlicker is self-hosted software. The university, school, or other organization operating a deployment must publish a privacy notice describing that deployment. This repository provides the technical reference and a template; it does not establish a single privacy policy on behalf of every operator.

If you use Qlicker, consult the notice supplied by your institution for its privacy contact, service providers, retention periods, and procedures for requesting your information. Installing Qlicker does not itself give the project maintainers access to an institution's database. Any hosting or support access must be separately arranged and disclosed by the operator.

## For deployment operators

1. Review [Qlicker's data handling](docs/privacy/data-handling.md) against your installed version and configuration.
2. Complete the [deployment privacy notice template](docs/privacy/notice-template.md). Replace every bracketed instruction and have your privacy office review it before publication.
3. For Ontario institutions, use the [Ontario deployment guidance](docs/privacy/ontario-deployment.md) to prepare the institutional review and operational controls.
4. Publish the completed notice at a stable, publicly accessible institutional URL and provide it before account creation, SSO onboarding, and participation, including to activity-code guests. Include it in course onboarding materials and keep prior versions.

The current app does not provide a dedicated deployment privacy-notice configuration or page. These documents do not add one. Until that capability exists, publish through institutional channels and arrange for notice at the relevant collection points; a repository link alone is insufficient student onboarding.

## Responsibility for the notice

The shared technical reference explains what the software records and exposes. The deployment notice identifies the accountable institution and its actual practices: purposes and legal authority, authorized staff, providers and locations, retention and disposal, access and correction, and privacy contacts. Institutional contracts and internal procedures govern privileged access and service providers.

Do not promise restrictions that the installed software or operating procedures do not enforce. In particular, the current named-session results API exposes response IP addresses to authorized instructors, anonymous activities use pseudonyms that the server can recompute, and course-chat expiry archives posts without deleting them. See the technical reference before adopting the template.

The Ontario guidance supports review; it is not a legal opinion or certification of compliance. An institution's privacy office should approve its legal authority, notice, privacy assessment, and operating arrangements.
