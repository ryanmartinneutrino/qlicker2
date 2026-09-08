# Qlicker

Qlicker is an open-source classroom response system for higher education. Instructors can run live activities, schedule quizzes, organize reusable questions, discuss course material, review participation, and grade work. Students join from any modern browser without dedicated clicker hardware.

This repository contains the current React + Fastify application. The completed Meteor migration and legacy database contract are retained in `meteorjs_migration/` for compatibility work.

## Highlights

- Interactive instructor-paced sessions with live response counts, statistics, answer reveals, multiple attempts, and a presentation window
- Scheduled and practice quizzes with autosaved answers, submission tracking, and per-student extensions
- Multiple-choice, true/false, short-answer, numerical, multiple-select, and slide content
- Course and session chat, rich text, math, images, word clouds, histograms, and optional Jitsi video
- Question libraries, tags, session/question import and export, groups with CSV workflows, notifications, and AI-assisted workflows
- Automatic and manual grading, feedback, review controls, and CSV export
- Local login or SAML SSO, role-aware access, eight UI locales, responsive layouts, and accessibility coverage
- Production Docker deployment with Nginx, TLS, Redis fan-out, backups, restore, and migration tooling

## Documentation

| Audience | Start here |
| --- | --- |
| Students | [Student manual](docs/user-manual/student.md) |
| Professors and TAs | [Professor manual](docs/user-manual/professor.md) |
| Site administrators | [Admin manual](docs/user-manual/admin.md) |
| Developers | [Developer documentation](docs/developer/README.md) |
| Coding agents | [Repository agent guide](AGENTS.md) |
| Production operators | [Production deployment guide](production_setup/README.md) |

The complete documentation index is at [docs/README.md](docs/README.md). Signed-in users can also open a role-aware manual from the account menu.

## Repository layout

```text
client/               React/Vite web client and browser tests
server/               Fastify API, models, services, and server tests
docs/                 User, developer, grading, and API documentation
scripts/              Development setup, seeding, and service control
production_setup/     Production Docker Compose and operations tooling
load-testing/         k6 classroom-scale load tests
ssoserver/            Local SAML identity-provider test environment
meteorjs_migration/   Legacy schema and migration archive
```

## Requirements

- Node.js 22.13 or newer
- npm (lockfiles are committed separately under `client/` and `server/`)
- For native development: MongoDB; Redis is recommended for testing multi-instance/realtime behavior
- For container development: Docker Engine with Docker Compose v2
- OpenSSL for setup-generated JWT secrets

Do not reuse development secrets in production. Do not commit the generated `.env` file.

## Quick start

### Native development

From the repository root:

```bash
./scripts/setup-native.sh
./scripts/qlicker.sh start
./scripts/qlicker.sh status
```

The guided setup creates local configuration, installs the client/server dependencies, and checks MongoDB and Redis. The service helper starts both application processes and manages their PID/log files.

### Docker development

```bash
./scripts/setup-docker.sh
docker compose up -d
docker compose logs -f server client
```

The development stack contains MongoDB, Redis, the API, and the client. Stop it with `docker compose down`; named volumes retain development data unless explicitly removed.

### Local addresses

Default ports can be changed during setup.

| Service | Default address |
| --- | --- |
| Web app | `http://localhost:3000` |
| API | `http://localhost:3001/api/v1` |
| Health check | `http://localhost:3001/api/v1/health` |
| Admin-protected Swagger UI | `http://localhost:3001/docs` when API docs are enabled |

## First run

On an empty database, the first registered account becomes an administrator. After signing in:

1. Review global login, locale, date, and session settings.
2. Configure backups and verify their host storage.
3. Choose local, S3-compatible, or Azure image storage and test an upload.
4. Configure SAML, video, or AI only if the deployment will use them.
5. Create professor accounts or promote existing users, then create a test course and enroll a student.

See the [admin manual](docs/user-manual/admin.md) for the UI workflows and the [production guide](production_setup/README.md) for operational requirements.

## Development commands

```bash
# Unit and integration tests
npm test --prefix server
npm test --prefix client

# Production client build
npm run build --prefix client

# Browser workflows
./scripts/qlicker.sh e2e

# Install the Playwright browser on the first run when needed
./scripts/qlicker.sh e2e --install-browser
```

Run the two application halves directly when you do not need the service helper:

```bash
npm run dev --prefix server
npm run dev --prefix client
```

Development fixtures can be loaded with `./scripts/seed-db.sh` (native) or `./scripts/seed-db-docker.sh` (Docker). See the [development guide](docs/developer/development-guide.md) before making a change and [CODING_STANDARDS.md](CODING_STANDARDS.md) before submitting it.

## Common account-management tasks

For development, reset a local password with:

```bash
./scripts/changeuserpwd.sh --email user@example.com
./scripts/changeuserpwd.sh --email user@example.com --newpasswd 'a-new-password'
```

For production containers, use the supported management wrapper:

```bash
cd production_setup
./manage-user.sh list
./manage-user.sh create --email prof@example.com --firstname Jane --lastname Smith --role professor
./manage-user.sh promote --email prof@example.com --role admin
./manage-user.sh change-password --email user@example.com
./manage-user.sh set-email-login --email sso.user@example.com --disable-email-login
```

## Production and migration

Production is deployed from `production_setup/`, not the root development Compose file:

```bash
cd production_setup
./setup.sh
docker compose up -d
```

Before using a real database, read the [production deployment guide](production_setup/README.md), verify backups and restore on a non-production copy, and review the [legacy database reference](meteorjs_migration/LEGACY_DB.md) when upgrading an installation created by the Meteor app.

The canonical release label is the single line in `VERSION`. Setup and image tooling should source that value instead of duplicating a version in prose.

## Load testing

The k6 suite models a professor driving an interactive session while student clients authenticate, join, keep WebSockets open, respond, and use chat:

```bash
cd load-testing
./setup.sh
./run.sh --prepare
./run.sh
./run.sh --restore
./run.sh --clean
```

Always restore rate limits after a test. Full options and metrics are documented in [load-testing/README.md](load-testing/README.md).

## License

Qlicker is licensed under the [GNU Affero General Public License v3.0](LICENSE).
