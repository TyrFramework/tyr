# Contributing to Tyr

Thanks for considering a contribution. This document covers everything you need to get a
development environment running, submit a pull request, and write a command or a test that fits
the existing codebase.

Before touching any code, read [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) — it's a five-minute
read that explains the Kernel → Container → TyrContext → Commands pipeline every part of this
codebase is built around.

## Development setup

Requirements: Node 18+ and npm.

```bash
git clone https://github.com/orxataguy/TyrFramework.git
cd TyrFramework
npm install
```

That's it — there's no separate build step for development. Commands run directly from TypeScript
source via `tsx` (see `bin/tyr.js`).

To run the CLI against your local checkout instead of a globally installed copy, use `node
bin/tyr.js <command>` from the repo root, or `npm link` to make the `tyr` binary point at your
checkout globally.

A pre-commit hook (via husky) runs `npm test` automatically. If it's not installed for some reason,
run `npm run prepare` once after cloning.

## Running the test suite

```bash
npm test              # Run all tests once
npm run test:watch    # Watch mode
npm run test:coverage # Coverage report
npm run test:smoke    # Verifies every registered command loads and exports a default function
```

### Writing tests for a new command

Every command factory takes a `TyrContext` and returns an async handler. `tests/setup.ts` exports
`createMockContext()`, which builds a fully mocked `TyrContext` (every Manager method stubbed with
`vi.fn()`) so you can unit test a command without touching the real filesystem, shell, or network.

```typescript
import { createMockContext } from '../tests/setup';
import myCommand from '../src/core/sys/myCommand';

test('my command runs', async () => {
    const ctx = createMockContext();
    const handler = myCommand(ctx);
    await handler(['arg1']);
    expect(ctx.logger.success).toHaveBeenCalled();
});
```

If your command needs a mocked method or return value `createMockContext()` doesn't already
provide, extend the relevant section of `tests/setup.ts` rather than hand-rolling a one-off mock in
your test file — it keeps every test's context shape consistent.

## Code style

There's no linter configured (no ESLint/Prettier config in this repo yet), so consistency is by
convention. Match what's already there:

- 4-space indentation, semicolons, single quotes.
- Every exported class, method and function gets a JSDoc comment (`@class`/`@method`/
  `@description`/`@param`/`@returns`/`@example` — see any file in `src/lib/` for the pattern).
  `src/core/sys/doc.ts` actually parses these comments to build `tyr doc`'s live reference, so
  keeping the tags consistent isn't just style — it's functional.
- Comments and identifiers in English, even if you're more comfortable writing them in another
  language.
- Wrap risky operations in `context.task()` and use `context.fail()` for expected validation
  failures, rather than throwing a raw `Error` — see `src/core/TyrError.ts` and any built-in command
  under `src/core/sys/` for the pattern.
- Prefer explaining *why* a non-obvious decision was made over restating *what* the code does —
  the existing comments throughout `src/lib/` are a good reference for the tone to aim for.

## Pull request workflow

1. Fork the repository and create a branch off `main`.
2. Make your change, with tests for any new behavior.
3. Run `npm test` locally (the pre-commit hook does this too, but don't rely on it alone).
4. Open a PR against `main` with a clear description of what changed and why. Reference any issue
   it closes.
5. CI (`.github/workflows/ci.yml`) runs the test suite on Ubuntu, Windows and macOS. All three must
   pass before merge.
6. Keep PRs focused — one logical change per PR is much easier to review than a bundle of unrelated
   fixes.

## Finding something to work on

Issues labeled [`good first issue`](https://github.com/orxataguy/TyrFramework/labels/good%20first%20issue)
on GitHub are scoped for newcomers to the codebase. If nothing's labeled yet, `src/core/sys/` (the
built-in commands) and `src/lib/` (the Managers) are the most approachable starting points — each
file is self-contained and documented. If you want to add support for a new external tool or
service, a new `XyzManager` class in `src/lib/`, wired into `src/core/Container.ts` the same way
the existing Managers are, is usually the right shape.

If you're proposing something larger (a new built-in command, a change to the Kernel/Container
wiring, a new dependency), open an issue to discuss the approach before investing time in an
implementation — it's much easier to course-correct a proposal than a finished PR.

## Publishing your own fork

Tyr also supports a hybrid model where anyone can publish their own distribution under their own
npm scope without contributing back — see [`COMMUNITY.md`](COMMUNITY.md) and the README's "NPM &
Community" section if that's what you're looking for instead.
