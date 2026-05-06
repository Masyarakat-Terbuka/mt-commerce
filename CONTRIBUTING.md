# Contributing

Thank you for your interest in mt-commerce. This document explains how to participate in the project — whether you are fixing a typo, translating a page, building a feature, or proposing a change to the architecture.

The project is open to anyone, anywhere. Contributions in Bahasa Indonesia and English are equally welcome. There are many ways to help, and writing code is only one of them.

---

## Code of Conduct

Everyone participating in mt-commerce is expected to read and follow the [Code of Conduct](./CODE_OF_CONDUCT.md). The short version is: be kind, be patient, assume good faith, and disagree with reasoning rather than authority.

---

## Ways to contribute

Many forms of contribution are welcome:

- **Reporting bugs.** Clear bug reports with steps to reproduce are valuable.
- **Requesting features.** Open a discussion or an issue describing the problem and who it affects.
- **Writing code.** From small fixes to whole modules.
- **Improving documentation.** Better explanations, clearer examples, fixed typos.
- **Translating.** Bahasa Indonesia translations are part of the product, not an extra.
- **Designing.** Reviewing user flows, suggesting improvements to the admin and storefront.
- **Testing.** Trying releases, reporting issues, sharing experience.
- **Helping others.** Answering questions in discussions, reviewing pull requests, welcoming newcomers.

If you are not sure where to start, [look at issues labeled `good first issue`](https://github.com/masyarakat-terbuka/mt-commerce/issues?q=label%3A%22good+first+issue%22) or open a discussion to introduce yourself.

---

## Languages

You are welcome to write issues, pull requests, comments, and discussions in **Bahasa Indonesia or English**. Maintainers respond in the language you write in. Documentation lives in both languages and is treated as equally important.

If you write a feature, a translation contribution that adds the same content in the other language is helpful but not required. Someone else can complete the pair.

---

## Setting up

mt-commerce is a TypeScript monorepo managed with [pnpm](https://pnpm.io/). You will need:

- [Node.js](https://nodejs.org/) (version specified in `.nvmrc`)
- [pnpm](https://pnpm.io/installation)
- [Docker](https://www.docker.com/) and Docker Compose

To get the project running locally:

```bash
git clone https://github.com/masyarakat-terbuka/mt-commerce.git
cd mt-commerce

pnpm install
cp .env.example .env

docker compose up -d
pnpm dev
```

The full local development guide, including troubleshooting, is in [`docs/development/getting-started.md`](./docs/development/getting-started.md).

---

## Finding something to work on

The work happens on [GitHub Issues](https://github.com/masyarakat-terbuka/mt-commerce/issues) and the [project board](https://github.com/masyarakat-terbuka/mt-commerce/projects).

A few labels to know:

- `good first issue` — a small, well-scoped task suitable for someone new to the project
- `help wanted` — an issue where outside contribution would be especially useful
- `area: ...` — which part of the codebase the issue concerns
- `type: bug` / `type: feature` / `type: docs` — what kind of work it is

Before starting on something larger than a small fix:

1. Check if an issue already exists. If so, leave a comment that you are interested in working on it.
2. If no issue exists, open one to describe the problem and your proposed approach. This avoids duplicate work and gives others a chance to weigh in early.
3. Wait for a brief acknowledgment from a maintainer before investing significant time. We try to respond within a few days.

This step protects your time. It is uncomfortable to write a large pull request only to learn that the design needs to be different.

---

## Making changes

### Branches

Create a branch from `main` with a descriptive name:

```
feat/add-midtrans-plugin
fix/cart-total-rounding
docs/clarify-quickstart
```

The prefix matches the type of change and follows the same vocabulary as our commit messages.

### Commits

Commits follow the [Conventional Commits](https://www.conventionalcommits.org/) specification:

```
type(scope): short description

Longer explanation if needed, wrapped at around 72 characters.

Closes #123
```

Common types: `feat`, `fix`, `docs`, `refactor`, `test`, `chore`, `perf`, `build`, `ci`.

Common scopes: `api`, `admin`, `storefront`, `sdk`, `plugins`, `docs`.

A few examples:

```
feat(api): add midtrans payment provider
fix(admin): correct currency formatting in order detail
docs(plugins): clarify the payment provider interface
```

Small, focused commits are preferred over large ones. If your branch ends up with many small commits, that is fine — pull requests are squashed when merged.

### Code style

Code is automatically formatted by Prettier and checked by ESLint. The pre-commit hook runs both. In practice, you should not need to think about formatting — the tools handle it.

Beyond formatting, we ask for:

- TypeScript with strict mode enabled
- Explicit types at module boundaries (function signatures, exported APIs)
- Avoid `any`. Use `unknown` and narrow with care.
- Small, focused functions. If a function is hard to name, it is probably doing too much.
- Comments explain *why*, not *what*. The code shows what; the comment explains the reason.

### Tests

Changes to production code should come with tests where appropriate:

- Pure logic and helpers — unit tests
- Module behavior with the database — integration tests
- User-visible flows in the admin or storefront — end-to-end tests when the change is significant

We do not chase coverage numbers. We do care that financial paths (pricing, tax, payments, refunds) are well-tested.

### Documentation

If your change affects users, document it:

- A new feature or option in the admin or storefront — update the user-facing docs
- A new public API endpoint — the OpenAPI document is the source of truth, so keep schemas accurate
- A new plugin extension point or internal pattern — update the developer docs
- A breaking change — note it clearly in the pull request and in the release notes

User-facing documentation should be updated in both Bahasa Indonesia and English when possible. If you can only do one, that is a useful contribution and a translation pair can follow later.

---

## Submitting a pull request

When your change is ready:

1. Make sure the tests pass locally: `pnpm test`
2. Make sure linting passes: `pnpm lint`
3. Make sure types check: `pnpm typecheck`
4. Push your branch and open a pull request against `main`
5. Fill in the pull request template
6. Link the issue your change addresses with `Closes #123` in the description

The pull request title follows the same Conventional Commits format as commit messages — it becomes the squash-merge commit.

A small pull request is easier to review than a large one. If your change is large, consider whether it can be split into a series of smaller, independently-reviewable pull requests.

### Draft pull requests

If you want feedback before the change is finished, open the pull request as a **draft**. This signals that the work is in progress and welcomes early input.

---

## The review process

A maintainer will review your pull request. We aim to respond within a few days, though it can take longer for larger changes or during quieter periods.

Reviews focus on:

- Whether the change does what the issue describes
- Whether the approach fits the architecture
- Whether the code is clear and tested
- Whether documentation is updated
- Whether the change is safe (financial correctness, security, backward compatibility)

A reviewer may ask questions, request changes, or suggest a different approach. None of this is personal. Reviewers are trying to help your contribution land well, and to keep the project coherent for the people who will read the code after you.

If you disagree with feedback, say so. Reasoning is welcome. Decisions get better when more than one person thinks them through.

Once the change is approved and CI passes, a maintainer will merge it.

---

## After merging

Your contribution becomes part of mt-commerce, with your name in the commit history. Significant contributions are also acknowledged in release notes.

If your change affects users, it will appear in the changelog when the next version is released.

---

## Getting help

If you are stuck, you can:

- Open a discussion in [GitHub Discussions](https://github.com/masyarakat-terbuka/mt-commerce/discussions)
- Comment on the issue you are working on
- Open a draft pull request and ask for guidance there

Asking is welcome. The project benefits when contributors get unblocked quickly.

---

## A note on disagreement

People will sometimes disagree about how something should work. That is healthy. We try to:

- Treat each other with respect
- Share reasoning rather than asserting authority
- Look for the best argument, not the loudest voice
- Move forward when consensus is reached, and revisit when new information appears

Architecture Decision Records in [`docs/adr`](./docs/adr) document the more significant disagreements and how they were resolved. Reading them is a good way to understand how the project thinks.

---

Thank you for being here. Whatever shape your contribution takes, it is appreciated.
