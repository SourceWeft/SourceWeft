# Node runtime policy

Source development, CI checks and Docker builds default to **Node 22.23.2**.
The repository's `.node-version` records that default. **Node 24 is supported
too**: root/backend `engines` are `^22.13.0 || ^24.0.0`.

Node 24 entered LTS on 2025-10-28. Node 22 is in maintenance through 2027-04-30;
Node 24 is scheduled through 2028-04-30. Node 20 ended maintenance on 2026-04-30.
These dates follow the [official Node release schedule](https://github.com/nodejs/Release/blob/main/schedule.json).

The Node 22 minimum comes from the installed dependencies: the auth CLI needs
22.12 or newer, and PDF.js requires at least 22.13 on that line. A Node 20 build
passing TypeScript does not make those runtime and migration dependencies
supported. This update keeps the original migration tools and locked libraries.

CI runs database migrations and workspace tests on both **22.23.2** and
**24.18.0**. Turbo cache keys include the Node version, and tests use `--force`
so one runtime cannot inherit another runtime's test result. Local complete
workspace migration/test runs passed on both versions. The root test command
limits Turbo to two concurrent package tasks. Backend/Web Vitest and the model
gateway's Node test runner also cap file workers at two, so package and file
parallelism do not multiply SDK/DOM imports beyond the shared machine's capacity;
their timeouts and explicit two-connection race tests are unchanged. Earlier patch versions
accepted by engines were not all tested individually.

The Dockerfile's `NODE_VERSION` build argument defaults to 22.23.2 and remains
overridable. Its official Alpine image was checked for amd64 and arm64 support.
The backend's `tsup` syntax target remains `node20`; that controls emitted
JavaScript syntax, while engines and deployment configuration define the
supported application runtime. Independent sandbox runtimes are unchanged.

Compose invokes pnpm for migrations, API, worker and scheduler startup. Docker
prepares the pinned pnpm version in the shared `COREPACK_HOME=/pnpm/corepack`
directory and makes it readable by the non-root `sourceweft` user. These commands
must use that prepared version without downloading a package manager at startup.
This does not guarantee that every application feature can operate offline.
