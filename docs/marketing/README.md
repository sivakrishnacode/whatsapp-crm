# Marketing documentation

Customer-facing product documentation, written to be quoted on a website, in a
deck, or on a sales call.

| File | What it is | Rule |
| --- | --- | --- |
| [features.md](features.md) | Everything that **ships today**, benefit-led, organised by product area. Ends with positioning guidance and the honest limits | Every claim must be true in production. No "almost done" |
| [roadmap.md](roadmap.md) | Everything that **doesn't** — separated into ready-but-gated, in build, planned, considering, and deliberately-not-doing. Ends with a sales quick-reference | **Never give a customer a date** for anything in here |

## Keeping them honest

These two files are a pair. When a feature ships, it **moves** from
`roadmap.md` to `features.md` in the same change — a roadmap that still lists
shipped features makes the sales team under-sell the product, and a features
list carrying unshipped work turns a demo into a refund.

The technical source of truth is [`../../CLAUDE.md`](../../CLAUDE.md) and the
per-feature docs in [`../`](../). If those and these disagree, the code wins —
fix the marketing copy.

**Last full verification against the codebase: 12 August 2026.**
