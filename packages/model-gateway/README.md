# Model gateway tests

Run `pnpm --filter @sourceweft/model-gateway test` for the package suite.

The test command limits file concurrency to two. Turbo runs this suite alongside
other workspace packages; letting each Node test runner use nearly every CPU
causes competing SDK imports to delay actual HTTP dispatch past short deadlines.
This limit preserves the real timeout budgets, HTTP cancellation assertions, and
concurrency exercised within individual tests.
