# Product

This document describes what we are building, who it is for, and the principles that guide it.

It is a living document. Anyone is welcome to suggest changes through a pull request or discussion.

---

## In one sentence

An open-source commerce platform, built for Indonesia, free for anyone to run, fork, and own.

---

## Why this exists

Running an online store in Indonesia is harder than it should be.

The tools that work well are expensive, priced in foreign currency, and treat Indonesian payments, shipping, and language as afterthoughts. The tools that are affordable are often outdated, slow on mobile, or difficult to extend. The marketplaces are powerful but take the customer relationship with them.

For a small merchant in Bandung, a developer in Surabaya, or a brand in Jakarta, the choice today is usually a compromise.

We believe Indonesian merchants deserve commerce infrastructure that is modern, reliable, and theirs to keep. Not rented. Not locked. Not translated as an afterthought.

So we are building it, in the open, and giving it away.

---

## What we are building

A complete commerce platform with everything a merchant needs to sell online:

- A catalog for products, variants, and inventory
- A storefront that works well on slow connections and small screens
- A checkout that supports the payment methods Indonesians actually use
- An order and customer system that holds up to real volume
- An admin built for people who run shops, not engineers
- A foundation developers can extend without fighting the framework

The platform is local-first. Indonesian payments, shipping, addresses, tax, and language are part of the core, not optional add-ons.

The code is open. The license is permissive. The architecture is documented. Anyone can read it, run it, change it, and ship it.

---

## Who it is for

### Merchants who want to own their store

Sellers who have outgrown a marketplace listing or a basic site builder, and want their own brand, their own customers, and their own data. They are not technical, but they have someone who is — a friend, a freelancer, an agency.

### Developers and agencies serving Indonesian businesses

Engineers and studios who build commerce projects for clients and are tired of stitching together aging plugins or paying foreign platforms in dollars. They need a foundation they can trust, learn quickly, and deliver on.

### Builders, students, and contributors

Anyone curious about how commerce works, learning to build software, or wanting to contribute to something used by real businesses in their country.

---

## Principles

These are the commitments that shape every decision.

**Open, and staying open.**
The core is open-source under a permissive license, and it remains so. Anyone can read the code, run it, modify it, or build on top of it.

**Indonesian by default.**
Bahasa Indonesia, Rupiah, local payments, local couriers, local address structures, and local tax rules work without configuration. Operators outside Indonesia can adapt the platform; merchants inside Indonesia should not need to.

**Boring where it matters, modern where it counts.**
Commerce involves money, inventory, and orders. We choose proven, well-understood foundations for these. We invest in modern tooling, type safety, and developer experience for everything around them.

**Modular without being complicated.**
The platform is shaped into clear modules with clear boundaries. A developer should be able to read a single module and understand it without holding the whole system in their head.

**Built for the people who use it.**
Merchants, developers, and shoppers all have a seat at the table. The admin is usable by non-engineers. The API is pleasant for engineers. The storefront is fast for shoppers, especially on the connections most Indonesians actually have.

**Honest about money.**
Currency is handled as integers. Financial events are auditable. Payment operations are idempotent. Mistakes in this area cost real people real money, and we treat that seriously.

**Documentation is part of the product.**
A feature without documentation in Bahasa Indonesia and English is not finished.

**Community in the open.**
The roadmap, decisions, and discussions happen in public. People who contribute are credited. Disagreements are welcome and resolved with reasoning, not authority.

---

## What is in scope

### Core commerce

Products, categories, variants, inventory, customers, carts, checkout, orders, payments, shipping, promotions, notifications, and store settings.

### Indonesian essentials

Address handling down to the kelurahan level, Rupiah formatting, Bahasa Indonesia defaults, manual bank transfer, payment-gateway integration, courier integration, COD support, WhatsApp order notifications, and local invoice formatting.

### Admin

A clean, focused dashboard for managing products, orders, customers, inventory, payments, shipping, and store settings, with role-based access for teams.

### Storefront

A reference storefront that is mobile-first, fast on modest hardware, friendly to search engines, and straightforward to theme or replace.

### Developer platform

A documented HTTP API, webhooks, an event system, a plugin model, an SDK, a command-line tool, a one-command local setup, and example integrations.

---

## What is not in scope

To stay focused, the project is intentionally not trying to be:

- A multi-vendor marketplace platform
- A general-purpose content management system
- A point-of-sale system in its first releases
- A cross-border, multi-region commerce engine in its first releases
- A replacement for accounting or ERP software

These are valuable problems. They are not this project.

---

## Selling to consumers, and to businesses

The platform is built first for merchants who sell to consumers. This is where most Indonesian commerce lives today, and where the platform can be useful soonest.

The foundation, however, is shaped so that selling to other businesses can be added later without rewriting the core. Customers can be people or companies. Tax identifiers, company names, and multiple addresses are part of the data model from the beginning. Pricing is designed to allow more than a single price per product, even if early releases only use one.

Features specific to business-to-business commerce — customer-specific price lists, payment terms, purchase orders, approval workflows, account hierarchies — belong to a later stage. They will arrive when the consumer-facing platform is solid and a real need is in front of us.

---

## Direction

The project moves through clear stages. Each one is shipped before the next begins.

**Foundation.**
Core commerce engine, admin, reference storefront, one local payment integration, one local shipping integration, WhatsApp notifications, local-first deployment, and complete documentation. A small business can run a real store on it.

**Extensibility.**
Plugin SDK, theme system, additional payment and courier integrations, import and export tools, and a command-line tool suited to developers and operators.

**Operations.**
Marketplace synchronization, promotion engine, customer segmentation, basic analytics, and workflows for resellers and distributors.

**Intelligence.**
Smart inventory and demand insights, content assistance, and helpful automation in the admin.

**Maturity.**
Advanced roles and audit logging, multi-warehouse inventory, B2B pricing, and integration patterns for established businesses.

The project will not move to a new stage at the cost of stability in the previous one.

---

## Success, defined

We will know this project is succeeding when:

- Merchants in Indonesia run real stores on it, and stay
- Developers and agencies pick it because it is genuinely good, not only because it is free
- People who have never met the maintainers contribute meaningful improvements
- The documentation in Bahasa Indonesia is as complete as the documentation in English
- A merchant can leave the platform with their data intact, easily, at any time

We are not measuring success by lock-in, by reach into users' data, or by anything that conflicts with the principles above.

---

## A note on language

This document is written in English so it is approachable to international contributors. A Bahasa Indonesia version lives alongside it and is treated as equally important. If the two ever drift, that is a bug.

---

## Status

This document is a draft. The ideas in it are stable; the wording will improve as the project does.

Feedback and pull requests are welcome.
