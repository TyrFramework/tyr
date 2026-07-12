# Tyr Community

This is the directory of community-published distributions and modules.
Nothing here is officially maintained by the Tyr core team — each entry is
maintained independently by its author.

## Naming convention

- **Official package:** `@tyrframework/cli` — published from this
  repository, maintained by the core team.
- **Forks / distributions:** published under the author's own npm scope,
  e.g. `@johndoe/tyr`. Never under `@tyrframework/*` — that scope is
  reserved for the official package.
- **Modules:** not published to npm at all — installed via
  `tyr --add <manifest-url>` from a `manifest.json` hosted anywhere on
  `raw.githubusercontent.com`.

## How to get listed

Don't open a PR editing this file directly — submit an issue instead, so
listings go through one consistent review step:

- **Distribution (a fork published to npm):** open a
  [Submit a distribution](../../issues/new?template=distribution.yml) issue.
- **Module (a set of commands via `tyr --add`):** open a
  [Submit a module](../../issues/new?template=module.yml) issue.

Once reviewed, it gets added to the tables below and the issue is closed.

---

## Distributions

Forks published under their own npm scope.

| Package | Maintainer | What's different | Repo |
| --- | --- | --- | --- |
| `@tyrframework/cli` | Tyr core team | Official release | [TyrFramework/tyr](https://github.com/TyrFramework/tyr) |

*(Community entries go here as they're approved.)*

---

## Modules

Command collections installable via `tyr --add`.

| Manifest | Maintainer | Commands added | Repo |
| --- | --- | --- | --- |
| _none yet — be the first!_ | | | |

---

## Guidelines for listed entries

- Listings are removed if the package/manifest becomes unreachable or
  unmaintained for an extended period — you'll get a heads-up issue first.
- The core team doesn't vet distributions or modules for security or
  correctness beyond the basic checklist in the submission form. Install
  third-party distributions and modules at your own judgment, same as any
  other open-source package.
- If two modules define colliding command names, that's between their
  maintainers to sort out — Tyr resolves collisions locally by
  last-imported-wins (see the main README), so document that clearly if
  it applies to yours.
