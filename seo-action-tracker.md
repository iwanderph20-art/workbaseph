# WorkBase PH — SEO Action Tracker

Consolidated, prioritized next steps. Detailed how-tos live in the existing docs
(`gbp-setup-walkthrough.md`, `brand-citations.md`, `geo-ai-visibility.md`) — this file
is the single "do these next, in this order" list. Ordered by impact ÷ effort.

_Last updated: 2026-09-01_

---

## ✅ Done 2026-09-01 (on-page / content)

- **Content backlog cleared:** the two remaining items from the backlog list are done —
  `/hire/filipino-appointment-setter.html` (full Service + BreadcrumbList + FAQPage schema;
  cold calling, lead qualification, calendar booking, CRM updates) and
  `/blog/workbaseph-vs-fiverr.html` (Article + FAQPage schema; gig-based vs ongoing hiring,
  20% seller commission vs flat fee). Both wired into their hub/index (hire hub card +
  ItemList position 10; blog index card), sitemap, and llms.txt.
- **Cross-linking:** appointment-setter added to content-writer's and customer-support's
  "Related" lines; Fiverr comparison cross-linked with both the Upwork and OnlineJobs
  comparison posts (each now links to all two siblings).
- **Sitemap `lastmod`** bumped to 2026-09-01 for `/hire/`, `/blog/`, and the two new pages.

---

## ✅ Done 2026-08-26 (on-page / content)

- **3 new money pages** (full Service + BreadcrumbList + FAQPage schema):
  `/hire/filipino-data-entry-specialist.html`, `/hire/filipino-graphic-designer.html`,
  `/hire/filipino-content-writer.html`. Wired into hub (cards + ItemList), sitemap, llms.txt.
- **New comparison page:** `/blog/workbaseph-vs-upwork.html` — honest fees/commission/escrow
  breakdown, Article + FAQPage schema. Cross-linked with the OnlineJobs comparison; added to
  blog index, sitemap, llms.txt.
- **Structured-data bug fix:** JSON-LD `Offer` price on all 6 existing hire pages was stale
  `$18` while the visible copy said `$29` — a price mismatch Google can flag. Set all to `29`.
- **Homepage internal-linking gap fixed:** the "Hire by Role" footer was missing
  `filipino-virtual-assistant.html` (the #1 commercial term) and the social-media-manager
  page — added both (VA first) plus a "Browse all roles →" link. Homepage now passes link
  equity to every money page. Homepage `lastmod` bumped to 2026-08-26.

---

## ✅ Done 2026-08-23 (on-page / technical)

- **Twitter Cards + `og:image:alt`** added across all 26 public pages that were missing
  them (all 13 blog posts, blog index, hire hub/pages, faq, employer-landing, etc.). Links
  shared on X now render large-image cards instead of plain links.
- **New money page: `/hire/filipino-social-media-manager.html`** — targets "hire Filipino
  social media manager" (blog existed, no money page). Full Service + BreadcrumbList +
  FAQPage schema. Wired into the hire hub (card + ItemList), sitemap, and llms.txt.
- **Cache-Control fix (`server.js`):** homepage + `/hire/*` + static marketing pages now
  get the blog's `max-age=3600, stale-while-revalidate=86400` instead of `no-store` —
  faster repeat-visit loads (CWV) and lighter crawl. Auth/user/app pages still `no-store`.
- **Bug fix (`css/hire.css`):** `.hire-hero h1` had no color, so the first H1 line
  ("Hire a Filipino …") rendered navy-on-navy — invisible on every hire page. Set to white.
- **Sitemap `lastmod`** refreshed to 2026-08-23 (all pages genuinely changed this session).

---

## ✅ Done 2026-08-14 (on-page / technical)

- New money page: **`/hire/filipino-virtual-assistant.html`** — targets the #1 commercial
  term "hire Filipino virtual assistant" (previously had no dedicated page). Full Service +
  BreadcrumbList + FAQPage schema. Added to hub, sitemap, and llms.txt.
- **Internal linking:** 9 informational blog posts now link to the `/hire/` money pages from
  their "Related" line (previously most linked only to sibling posts). Passes link equity to
  commercial pages.
- **Hire hub schema:** added ItemList + BreadcrumbList to `/hire/` index.

---

## 🔜 Off-page — priority order

### P1 — Google Business Profile (biggest local/brand signal)
- [ ] Submit the service-area GBP per `gbp-setup-walkthrough.md` (~10 min + verification wait).
- [ ] After verification: fill description (kit section C), categories, services, social links.
- [ ] Add the GBP `maps.google.com/?cid=…` URL to the homepage Organization `sameAs` (already
      present — confirm the CID matches the verified profile).

### P2 — Foundational citations (NAP consistency)
- [ ] Set the LinkedIn vanity slug `/company/workbaseph`, then swap the numeric URL in the
      site's `sameAs` schema (see `brand-citations.md` §6).
- [ ] Submit to the priority directories in `brand-citations.md` §6 using the **exact** canonical
      NAP — name, URL, email, descriptions A–D. Consistency matters more than volume.

### P3 — AI answer-engine visibility (GEO) — you already rank technically; get *cited*
- [ ] Software directories (G2, Capterra, etc.) — highest leverage for "best platform to hire
      Filipino VA" LLM answers. See `geo-ai-visibility.md` §1.
- [ ] Seed authentic Reddit/Quora answers on the recurring questions (§2). These are heavily
      cited by ChatGPT / Perplexity / Google AI Overviews.
- [ ] Pitch to get added to existing "best platforms" listicles that already rank (§3).
- [ ] Product Hunt launch when ready (kit in `geo-ai-visibility.md`).

### P4 — Backlinks
- [ ] Guest posts / mentions from remote-work and small-business blogs pointing to the
      `/hire/` and `/blog/` pages.
- [ ] Reclaim unlinked brand mentions once directory/PR presence grows.

---

## 📈 Measurement (check monthly)

- **Google Search Console:** impressions/clicks for "hire filipino virtual assistant",
  "filipino VA", "[role] Philippines". Watch the new VA page's indexing + position.
- **Rich results:** validate FAQ + Breadcrumb rendering on hire pages
  (search.google.com/test/rich-results).
- **AI citations:** periodically ask ChatGPT/Perplexity "best platform to hire a Filipino VA"
  and note whether WorkBase PH is named.

---

## 💡 Content backlog (next new pages, by search intent)

Roles/queries with commercial intent but no dedicated `/hire/` page yet:
- [x] `/hire/filipino-social-media-manager.html` — done 2026-08-23
- [x] `/hire/filipino-data-entry-specialist.html` — done 2026-08-26
- [x] `/hire/filipino-graphic-designer.html` — done 2026-08-26
- [x] `/hire/filipino-content-writer.html` — done 2026-08-26
- [x] `/hire/filipino-appointment-setter.html` — done 2026-09-01
- [x] Comparison: WorkBase PH vs Upwork — done 2026-08-26
- [x] Comparison: WorkBase PH vs Fiverr — done 2026-09-01

All planned `/hire/` role pages and platform comparisons are now shipped. Next new-content
ideas should come from Search Console query data (see Measurement section) rather than this
pre-set backlog.
