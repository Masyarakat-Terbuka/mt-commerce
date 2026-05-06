# Security

mt-commerce handles payments, customer data, and orders. Security matters here in concrete ways: a vulnerability can affect real merchants and real shoppers. We take that seriously.

This document explains how to report a security issue, what happens after you report one, and what we ask of researchers acting in good faith.

---

## Reporting a vulnerability

**Please do not report security vulnerabilities through public GitHub issues, discussions, or pull requests.** Public reports give attackers a head start on running stores.

The preferred way to report a vulnerability is through GitHub's private vulnerability reporting feature, which keeps the discussion private until a fix is ready:

- Open the [Security tab](https://github.com/masyarakat-terbuka/mt-commerce/security) of the repository
- Click *Report a vulnerability*
- Fill in the form

If you cannot use GitHub's private reporting, send an email to:

**security@masyarakat-terbuka.org**

If the vulnerability is sensitive enough that you want to encrypt the report, mention this in your initial email and we will respond with a key.

---

## What to include

A useful report contains, at minimum:

- A clear description of the vulnerability
- The version, commit hash, or environment where you observed it
- Steps to reproduce, ideally as concrete as possible
- The impact — what an attacker could do with this
- Any suggested mitigation, if you have one

A proof-of-concept is helpful but not required. Please do not test the vulnerability against production deployments that you do not own.

---

## What you can expect from us

When you submit a report, we aim to:

- Acknowledge receipt within **three working days**
- Provide an initial assessment within **seven working days**
- Keep you informed as we investigate and develop a fix
- Credit you publicly when the fix is released, if you wish

If a report turns out not to be a security issue, we will say so and explain why. If we disagree about whether something is a vulnerability, we will discuss it openly with you.

---

## Disclosure timeline

We follow coordinated disclosure. The general shape:

1. You report the issue privately
2. We confirm and develop a fix
3. We release the fix in a new version
4. After a reasonable window for operators to upgrade, we publish a public advisory crediting you (unless you prefer to remain anonymous)

The window between the fix release and public disclosure depends on the severity of the issue and how widely deployed the affected versions are. For most issues, this is around two weeks.

If a vulnerability is being actively exploited, we may shorten this window.

---

## Scope

The following are in scope:

- The mt-commerce API (`apps/api`)
- The reference admin (`apps/admin`)
- The reference storefront (`apps/storefront`)
- The TypeScript SDK (`packages/sdk`)
- First-party plugins under `packages/plugins/`
- Documentation that, if incorrect, could lead operators to deploy insecurely

The following are out of scope:

- Vulnerabilities in third-party services (Midtrans, Biteship, the WhatsApp Business API, etc.) — please report those to the respective vendors
- Vulnerabilities that require a compromised operator account or stolen API key
- Issues that depend on outdated browsers, operating systems, or Bun versions outside the supported range
- Theoretical issues without a demonstrable impact
- Reports generated solely by automated scanners without manual analysis
- Social engineering of contributors or operators

---

## Safe harbor

We will not pursue legal action against researchers who:

- Make a good-faith effort to comply with this policy
- Avoid privacy violations, destruction of data, or interruption of service
- Do not exploit the vulnerability beyond what is necessary to demonstrate it
- Give us reasonable time to respond before any public disclosure
- Do not test against systems they do not own

We see security researchers as collaborators. The goal is fewer vulnerabilities in the wild, not legal posturing.

---

## Recognition

Researchers who report valid vulnerabilities will be credited in the security advisory and, if they wish, listed in a hall of thanks once one exists.

There is no monetary bug bounty at this time.

---

## Security practices in mt-commerce

For visibility, here is a summary of the security practices the project follows. Reports about gaps in any of these are welcome.

- Passwords are hashed with Argon2id
- Sessions use HTTP-only, secure cookies
- All API endpoints are rate-limited
- Payment operations are idempotent (Idempotency-Key header)
- Webhooks are signed with HMAC and verified
- Inputs are validated with Zod schemas at the API boundary
- Secrets are read from environment variables, never committed
- Dependencies are reviewed and updated regularly
- CI runs lint, typecheck, and tests on every change

The full architecture is described in [`ARCHITECTURE.md`](./ARCHITECTURE.md).

---

Thank you for helping keep mt-commerce and the merchants who use it safe.
