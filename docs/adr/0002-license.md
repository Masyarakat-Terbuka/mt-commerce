# ADR-0002: License

- **Status:** Accepted
- **Date:** 2026-05-07
- **Deciders:** mt-commerce maintainers

---

## Context

mt-commerce is open-source, and the license is one of the most consequential choices the project will make. The license affects who can use the software, how it can be combined with other software, and how easy it is for businesses, agencies, and individuals to adopt it.

A few common options were considered:

- **MIT License** — short, permissive, one of the most common open-source licenses
- **Apache License 2.0** — permissive, similar to MIT, with explicit patent grant and stronger protection against patent claims
- **GNU General Public License v3 (GPL)** — copyleft, requires derivative works to be open-source under the same terms
- **GNU Affero General Public License v3 (AGPL)** — copyleft that also covers software offered as a network service
- **Source-available licenses** (BSL, Elastic License, Functional Source License) — restrict commercial use or competition

The project values widespread adoption, fork-friendliness, and a simple legal story. It does not need to extract revenue from license terms.

---

## Decision

mt-commerce is licensed under the **MIT License**.

The license text is in [`LICENSE`](../../LICENSE) at the root of the repository.

---

## Consequences

### Positive

The license is short, well-known, and understood by developers, businesses, and legal teams worldwide. There is almost no friction for adoption.

Anyone can use mt-commerce for any purpose, including commercial work, without complex obligations.

The MIT license is compatible with virtually all other open-source licenses, including GPL family licenses. Plugins and integrations from other ecosystems can be combined with mt-commerce without legal complications.

The license aligns with the JavaScript and TypeScript ecosystem. Most npm packages are MIT-licensed, which keeps the dependency story simple.

The license matches the licenses of similar projects (Medusa, Saleor, Vendure, Strapi), which is what most contributors and users in this space expect.

### Negative

MIT does not include an explicit patent grant. Apache 2.0 does. In theory, a contributor could later assert patent claims against users of their own contribution. In practice, this risk is widely considered low for the kinds of code that go into a commerce platform, but it exists.

MIT permits anyone to fork the project, change the name, and offer a competing product or service. This is a feature of permissive licensing, not a bug, but it is worth naming honestly.

MIT does not require derivative works to be open-source. A fork could be made closed-source. This is consistent with the project's values — we prioritize freedom of use over enforced openness — but it differs from the GPL philosophy.

---

## Alternatives considered

### Apache License 2.0

Apache 2.0 was the strongest alternative. It is permissive like MIT, but adds:

- An explicit patent grant from contributors
- A clearer notice file convention
- Slightly more legal protection in some jurisdictions

It was not chosen because:

- The patent risk for a TypeScript commerce platform is low. The major patent risks in commerce software involve payments, cryptography, and authentication — areas where mt-commerce is integrating with established providers (Midtrans, Better Auth) rather than inventing novel patentable techniques.
- MIT is more familiar in the Node.js and TypeScript ecosystems, reducing friction for new contributors.
- The simplicity of MIT makes it easier for non-technical readers (merchants, agency owners, executives evaluating the project) to understand what they are getting.
- Similar projects (Medusa, Saleor, Vendure, Strapi) all chose MIT, and the lack of a patent grant has not caused problems for them.

The patent argument is real but, in this specific context, not strong enough to justify the slightly higher friction of Apache 2.0.

### GPL v3 or AGPL v3

GPL family licenses were considered briefly. They were rejected because:

- The project's goal is the widest possible adoption, including by businesses that have policies against incorporating GPL code into commercial products.
- AGPL in particular is sometimes flagged by enterprise legal teams as a license to avoid, regardless of the actual obligations.
- The project does not intend to use the license as a defensive tool against forks or commercial use.

A compelling argument exists for AGPL on the grounds that it would prevent closed-source forks from offering the platform as a service without contributing back. The trade-off — losing some adoption to gain some defensive copyleft — was deemed not worth it given the project's mission of broad accessibility.

### Source-available licenses (BSL, Elastic License, Functional Source License)

These licenses were considered and rejected. They are not open-source by the OSI definition, would prevent listing on most open-source directories, and would conflict with the project's stated principle that the core remains open-source under a permissive license forever.

---

## Implementation notes

- The license file is named `LICENSE` (no extension) so GitHub's license detector recognizes it.
- The copyright holder is "Masyarakat Terbuka."
- The copyright year reflects the year the file is committed; updating it annually is not required by the license.
- All source files do not require individual license headers, though contributors are welcome to add them.
- Third-party code incorporated into the project must be compatible with MIT (which includes nearly all permissive licenses and most copyleft licenses where the third-party code is a separate work).

---

## Related

- [`LICENSE`](../../LICENSE) — the license text
- [`PRODUCT.md`](../../PRODUCT.md) — the principles that informed this choice
