# UI Finish Gate — Automation canvas

Reviewed against `docs/automation-canvas-design.md`. Every contrast figure below was
recomputed from `apps/web/src/app/globals.css` (oklch → sRGB, WCAG 2.x ratio, with CSS
`color-mix(in oklch)` hue interpolation modelled per CSS Color 5 — shorter arc, powerless
hue when C = 0). The spec's own §1.4 table reproduces to ±0.1; the spec's arithmetic is
sound. What follows is where the build does not land on it, and two places where the spec
itself is wrong.

## Decision: **HOLD**

Four defects are load-bearing: the rejoin edge does not render at all, node drags snap
back, the inspector cannot be opened from the keyboard, and the category glyph is painted
with `solid` — which the spec forbids in one sentence and which fails SC 1.4.11 in light
mode for six of nine categories. The information architecture underneath is good and
should not be rewritten.

---

## 1. Contract compliance

### 1.1 Status ledger

| Spec | Status | Note |
| --- | --- | --- |
| §1.2 hue table | ✅ verbatim | `step-meta.tsx:88-101` |
| §1.3 `stepColors()` incl. `line` | ✅ formula copied | `step-meta.tsx:126-136` |
| §1.3 "`solid` is never painted directly" | ❌ **violated** | `step-meta.tsx:443` — M1 |
| §1.4 contrast floors | ⚠️ met for `text`/`line`, failed for the glyph | M1 |
| §1.5 24 types / add-remove collapse | ❌ collapse not done | 26 types, 4 near-identical rows — S6 |
| §2.1 geometry | ⚠️ card 264 ✅, dagre constants 260/96 vs spec 264/124 | `graph.ts:68-69` — C2 |
| §2.2 rows 1–4, row 3 omitted when null | ✅ | `step-node-card.tsx:198-291` |
| §2.3 badges | ✅ + two the spec never asked for and should keep | availability badges, `step-node-card.tsx:233-252` |
| §2.4 rest / selected / disabled / invalid | ✅ | `step-node-card.tsx:64-91` |
| §2.4 hover / dragging / keyboard-focus / flash | ❌ none implemented | S3, M4, S8 |
| §2.5 trigger card | ⚠️ shape ✅, chip invisible | `step-node-card.tsx:114-123` — S9 |
| §3.1 handle geometry + 24px hit area | ✅ | `step-node-card.tsx:96` |
| §3.1 connecting `scale(1.25)` | ❌ | C5 |
| §3.2 smoothstep, stroke tokens, labels | ⚠️ ✅ except `markerEnd` and `pathOptions` | `automation-canvas.tsx:188-221` — S1 |
| §3.3a branch footer | ✅ and it works | `step-node-card.tsx:337-370` |
| §3.3b/c continue port + bypass path | ⚠️ ports exist, **edge never renders** | M1 → see below |
| §3.3d branch scope ribbon | ⏭️ skipped — correct call, see §1.3 |
| §3.3e "rejoins" chip | ✅ | `step-node-card.tsx:211-215` |
| §4.1 docked frame, `bg-popover border-l` | ✅ | `step-inspector.tsx:74-78` |
| §4.1 resize rail + localStorage + width transition | ❌ not implemented | S4 |
| §4.1 `setCenter` nudge, no `fitView` | ⚠️ implemented, hardcodes 400px | `automation-canvas.tsx:312` — C3 |
| §4.2 header rows A/B, reference name, slug on blur | ✅ | `step-inspector.tsx:81-120`, `305-368` |
| §4.2 "no raw `<select>`, use `components/ui/select.tsx`" | ❌ **violated** | `step-fields.tsx:32` — S2 |
| §4.2 Advanced accordion | ✅ (+ an "outputs" section the spec didn't ask for; keep it) | |
| §4.2 KV table incl. `focus-within` token button | ✅ | `token-field.tsx:449` |
| §4.3 scroll reset | ✅ via remount | `automation-canvas.tsx:336` |
| §4.3 focus to panel heading | ❌ | M4 |
| §4.4 breakpoints | ⚠️ one breakpoint, not two | S5 |
| §5.1 token trigger in label row | ✅ | `token-field.tsx:276-285` |
| §5.1 `Ctrl/Cmd+Space` | ❌ | C6 |
| §5.2 popover geometry, groups, search, "insert anyway" | ✅ | `token-field.tsx:122-198` |
| §5.2 keyboard (`↑↓`, `Home/End`, `aria-activedescendant`) | ❌ | M4 |
| §5.2 `<mark>` on matched substrings | ❌ | C7 |
| §5.3 mono-on-`{{`, spaced tokens, caret insert, count chip | ✅ | `token-field.tsx:244-268` |
| §5.3 preview strip shows **sample values** | ❌ impossible — see §1.3 | S7 |
| §6.1 empty state (drop target + 3 starters) | ❌ replaced with a pill | `automation-canvas.tsx:436-442` — S10 |
| §6.2 two-pane picker | ⚠️ panes ✅; no rail dots, no Recent, no keyboard, no tablist ARIA | S11 |
| §7.1 two-part focus ring | ❌ | M4 |
| §7.2 tab order = execution order | ✅ **and this one was easy to get wrong** | `automation-canvas.tsx:158-170` |
| §7.2 Enter/Space opens the inspector | ❌ | M3 |
| §7.3 ARIA structure | ❌ almost entirely | M4 |
| §7.6 reduced motion / zoom<0.5 row hiding | ❌ | C4, C8 |
| §8 item 7 — back-port `line` into flows | ❌ | `flow-canvas.tsx:158,160,226,244` still paint `c.solid` — S12 |

### 1.2 Must-fix

**M1 — The rejoin edge is never drawn. `graph.ts:413`**

`deriveEdges` emits the post-branch continuation with `sourceHandle: 'next'`:

```ts
edges.push({
  id: `${previous}->${step.key}`,
  source: previous,
  sourceHandle: 'next',
  dashed: previousIsBranching,
  label: previousIsBranching ? 'then' : undefined,
});
```

But a branching card renders no `next` handle — `step-node-card.tsx:294-316` renders
`yes`, `no` and `continue` instead. React Flow resolves the handle by id
(`@xyflow/system` `getHandle`, `index.js:1444`), gets `undefined`, `getEdgePosition`
returns `null` (`index.js:1378-1385`), and `EdgeWrapper` bails: `if (edge.hidden ||
sourceX === null …) return null;` (`@xyflow/react` `index.js:2915`). The edge is silently
dropped and error 008 is logged.

The visible result is worse than omitting the feature: the receiving card still renders
its dashed right-edge port and its `rejoins` chip (`automation-canvas.tsx:136-139` →
`step-node-card.tsx:211`, `317-325`), so the canvas shows an inbound port with nothing
arriving at it. Every condition still looks like the end of the automation — the exact
failure the derived-edge design existed to fix.

Fix is one line plus the type: `sourceHandle: previousIsBranching ? 'continue' : 'next'`,
and widen `CanvasEdge.sourceHandle` at `graph.ts:393`. `handleConnect` already refuses
`continue` (`automation-canvas.tsx:252`), so nothing downstream breaks.
`graph.test.ts:104-106` asserts `dashed: true` but never asserts the handle — extend it,
that omission is why this shipped.

**On §3.3d, since you asked:** the ribbon's absence does **not** hurt the rejoin reading —
*once M1 is fixed*. With the fix, smoothstep with `sourcePosition = Right` and
`targetPosition = Right` produces exactly the gutter §3.3c describes: exits right, runs
down outside the card column, re-enters from the right. Dashed stroke + a different card
edge + the `rejoins` chip are three redundant channels, which is one more than §7.5
requires. The ribbon was the weakest of the four devices (1.1–2.3:1, carrying no
information the edges don't) and skipping it is a good call. Do not add it. Do add the
standing `continues after` label from §3.3b — it is the cheapest of the four and the only
one that names the concept in words.

**M2 — Dragging a card snaps it back. `graph.ts:457-475`**

`derivePositions` is all-or-nothing: if *any* step lacks a numeric position, every node
gets a fresh dagre layout. `blankStep` (`graph.ts:140-151`) sets no position, and
`duplicateStep` propagates `null` (`graph.ts:369-370`). So on a graph where one step has
never been dragged, `handleNodeDragStop` writes the position → `steps` changes →
`derivePositions` still sees an unplaced node → dagre re-lays out everything → the card
returns to where it started. Since new steps arrive unpositioned, this is the default
state of every automation. The user drags, and nothing happens.

The all-or-nothing rule is right (the comment explains why). The bug is that "unplaced"
is the permanent condition. Assign a position at insert time (dagre once when the step is
added, or place it under the current tail), so `placed` becomes true and stays true.

**M3 — The inspector cannot be opened from the keyboard. `automation-canvas.tsx:388`**

Selection is opened only by `onNodeClick`. React Flow's keyboard path
(`NodeWrapper.onKeyDown` → `handleNodeClick`, `@xyflow/react` `index.js:2236-2248`,
`1631-1646`) updates the store's internal `selected` flag and **does not invoke
`onNodeClick`**. `Tab` reaches every card in execution order (that part is right), `Enter`
appears to do nothing, and there is no other route into the panel. The whole editor is
keyboard-unreachable past the node list.

Fix: `onSelectionChange` (or `onNodeFocus` + an explicit `onKeyDown` on the card) to
mirror React Flow's selection into `selectedKey`.

While you are there: selection is currently two independent facts. `selectedKey` drives
the inspector; React Flow's `node.selected` drives the card's ring. `derivedNodes`
(`automation-canvas.tsx:141-172`) carries no `selected` property, and the render-time
replacement at `automation-canvas.tsx:183-186` overwrites `rfNodes` on every `steps`
change — which is every keystroke in the inspector. **Typing one character into a message
field clears the selection ring on the card you are editing.** Same root cause makes the
diagnostics panel's jump-to-step (`diagnostics-panel.tsx:110`) open the inspector without
highlighting the card, which is what §2.4's Flash state existed to solve. Carry
`selected: step.key === selectedKey` into `derivedNodes` and make `selectedKey` the single
source.

**M4 — Accessibility: the §7 contract is essentially unimplemented.** Detailed in §3
below. Grouped here because it is one fix pass, not eight.

**M5 — The category glyph is painted `solid`. `step-meta.tsx:443`**

```tsx
style={{ width: size, height: size, background: c.soft, color: c.solid }}
```

§1.3 states the rule in five words — "`solid` is never painted directly" — and §2.2 row 1
specifies `fill soft, glyph line`. Measured, glyph-on-chip:

| Category | `solid` glyph (built) D / L | `line` glyph (spec) D / L |
| --- | --- | --- |
| trigger | 4.66 / **2.83** | 6.25 / 3.91 |
| messaging | 3.82 / **3.46** | 5.46 / 4.63 |
| contact | 4.53 / **2.92** | 6.11 / 4.07 |
| crm | 4.70 / **2.82** | 6.28 / 3.98 |
| conversation | 5.58 / **2.37** | 7.09 / 3.46 |
| logic | 5.97 / **2.21** | 7.44 / 3.33 |
| data | 5.10 / **2.59** | 6.66 / 3.70 |
| orchestration | 3.03 (chip) / **3.03** | 6.00 / 4.19 |
| neutral | 3.40 / 3.87 | 5.01 / 5.08 |

Six of nine categories fail the 3:1 floor in light mode; the worst (logic) is 2.21:1. The
icon is the channel that answers "which step is this" once you are past the category
label, so it is a graphical object required to understand the content. `StepIconChip` is
shared by the card, the inspector header (`step-inspector.tsx:83`) and the add menu
(`add-step-menu.tsx:156`), so the one-word fix (`color: c.line`) repairs three surfaces.

Note the spec's claimed floor for this cell is 3.49:1 and the true figure with `line` is
3.33:1 (logic, light). Still passing; the table is optimistic by 0.16.

### 1.3 Where the spec itself was wrong

**The `soft` formula destroys the hue it exists to carry.** §1.3 defines
`soft: color-mix(in oklch, ${solid} 16%, var(--card))`. `--card` is `oklch(0.18 0.01 260)`
/ `oklch(0.995 0.002 260)` — chroma is non-zero, so its hue **is not powerless** and it
participates in interpolation at 84% weight. Every chip fill lands between h 244 and h
286 regardless of category:

| Mode | trigger (h162) | logic (h65) | contact (h350) | crm (h20) |
| --- | --- | --- | --- | --- |
| built (`color-mix`) | `#15232f` h244 | `#242335` h286 | `#1e2233` h274 | `#202134` h279 |
| light | `#deecf8` h244 | `#ededff` h286 | `#e5eafd` h274 | `#e7eafe` h279 |
| flows' idiom (alpha) | `#14241c` green | `#2d2013` amber | `#2c1b23` pink | `#2e1b1b` coral |

In light mode every chip is the same pale blue. The "emerald trigger / amber branch /
pink tag" story in §1.1 is not on screen at all. Flows' `nodeColors().soft` used
`oklch(l c h / 0.14)` — alpha over the card, which preserves hue exactly — and §1.3
changed it to a mix without accounting for hue interpolation. `step-meta.tsx:132` copied
the spec faithfully; the spec is the bug. Revert `soft` to the alpha form.

The same mechanism drifts `line` in light mode only (dark `--foreground` is `oklch(0.985
0 0)`, chroma 0, so its hue is powerless and the source hue survives): logic 65° → 29°
(amber ports render orange), trigger 162° → 184°, crm 20° → 354°. Contrast is unaffected;
identity is. Acceptable at 22%, but it is why the light canvas will look "off" against the
dark one.

**§5.3's preview strip assumes sample values that nothing produces.** "It renders the same
string with each token replaced by its sample value" — `TokenOption` (`tokens.ts:24-32`)
has `path`, `label`, `hint`, `conditional`; there is no sample anywhere in the editor and
no source for one (samples would have to come from a real run). `TokenPreview`
(`token-field.tsx:320-343`) therefore re-renders the token path inside a chip: the strip
shows exactly what the input already shows. See S7.

---

## 2. Generic-UI check

Most of this build is not interchangeable, and the reasons are concrete — see "Keep"
below. Three places are.

**S10 — The empty state (`automation-canvas.tsx:436-442`) is filler.** A centred pill
reading "Add your first step — it runs as soon as the trigger fires" is the default any
canvas app ships. §6.1 specified the product-specific replacement and it is right: a
264×64 dashed drop target sitting where the first card will go, wired to the trigger by a
dashed edge, plus three ghost starters. Make the three starters name the jobs this product
actually does — `Reply with a message`, `Tag the contact`, `Wait, then follow up` — each
adding a pre-configured step and opening its panel. The current pill teaches nothing; the
drop target teaches the spine, and the starters teach that a step is a WhatsApp action.

**S7 — The "Preview" strip previews nothing.** `token-field.tsx:320-343` renders the same
string it is under, with `{{ }}` swapped for a tinted chip. A box labelled *Preview* that
repeats the field is decoration. Two honest options, pick one: (a) relabel it *Tokens in
this field* and list the resolved **labels** — "Contact → Name", "lookup_order → Response
body" — which is information the input genuinely does not carry and which the picker
already has; or (b) delete it and keep only the count chip, which already tells you how
many tokens are present. Option (a) is better: the thing an author cannot see in
`{{ steps.lookup_order.body.id }}` is *which card that is*, and you know.

**S11 — The add-step rail is a generic category list.** `add-step-menu.tsx:104-125`.
§6.2's 6px `stepColors(cat).line` dot on each rail item is the one thing that ties the
menu to the canvas — pick a colour in the rail, see that colour arrive as a card. Without
it the rail is seven grey words, and the colour system only exists after you have already
committed. Cheap, and it is the difference between "a menu" and "this product's menu".

Everything else earns its place. The availability badges, the diagnostics vocabulary and
the per-step blurbs are the opposite of generic — see Keep.

---

## 3. Accessibility

**M4a — No control in the ~79 `FieldBlock` call sites has a programmatic label.**
`FieldBlock` accepts `htmlFor` (`token-field.tsx:44,50,61`) and **no call site passes it**;
`grep -n 'id="' step-fields.tsx` returns nothing. Every one of the ~25 forms announces
"edit text, blank" in a screen reader. This is the single highest-volume defect in the
build.

Cheapest correct fix, in two parts because the blocks are not uniform:

1. In `FieldBlock`, `const id = useId()`, render `<label htmlFor={id}>`, and publish `id`
   through a one-line context (`FieldIdContext`). Have `TokenInput` (`token-field.tsx:288`,
   `298`) and the raw `<select>`/`<Input>` sites consume it. That covers the ~60 blocks
   that wrap exactly one control.
2. For the blocks wrapping a *set* — the `on_error` radios (`step-inspector.tsx:169-190`),
   the weekday pills (`step-fields.tsx:1027-1053`), the channel pills
   (`trigger-inspector.tsx:196-222`), the KV tables, the buttons/sections editors — a
   single `htmlFor` is wrong. Give the wrapper `role="group"` (or `role="radiogroup"` for
   the radios) and `aria-labelledby={labelId}`. Same `useId`, different attribute.

Both halves live in one file. Do not hand-write ids at 79 call sites.

**M4b — ARIA on the canvas/sidebar pair.**

- `role="application"` is supplied automatically by React Flow's wrapper
  (`@xyflow/react` `index.js:3670`) but with **no accessible name** — §7.3's
  `aria-label="Automation canvas"` is not passed. An unnamed `role="application"` is worse
  than none. `#canvas-help` is partly redundant (React Flow ships `A11yDescriptions` and
  wires `aria-describedby` on every node), so the label is the part that matters.
- Node cards carry `aria-selected` on a plain `<div>` with no role
  (`step-node-card.tsx:109`, `188`). `aria-selected` is only valid on roles that support
  it; on a bare div it is ignored, and React Flow has already given the wrapper
  `role="group"`. Move state onto the wrapper via the node object, or drop it and use a
  `data-` attribute for styling.
- No `aria-label` on any node, so React Flow passes `aria-label: undefined` and the group
  is unnamed. §7.2's composed label (`"${category} step, ${title}, ${summary ?? 'not
  configured'}${disabled ? ', paused' : ''}"`) is a two-line addition at
  `automation-canvas.tsx:158-170` and is the whole screen-reader experience of the canvas.
- No `aria-controls` / `aria-expanded` / `aria-invalid` on cards.
- `<aside id="step-inspector">` has `aria-label` ✅ but no `role="complementary"`
  (`step-inspector.tsx:74-78`). Minor — `<aside>` maps to it implicitly; fine as is.
- Panel heading is a plain `<h2>` (`step-inspector.tsx:91`): no `tabIndex={-1}`, never
  focused on open, no `aria-live`. Combined with the missing skip link, opening a step
  leaves focus on the card and the next `Tab` goes to the *next card*, not into the panel.
  §7.2's skip link is not optional given 30 nodes.

**M4c — Token picker keyboard.** `token-field.tsx:139-198`. Rows are `<button
role="option">` so they *are* Tab-reachable — the picker is not a dead end, which is
better than the spec feared. But: `↑`/`↓`/`Home`/`End` do nothing, `aria-activedescendant`
is absent, `aria-selected="false"` is hardcoded on every row (`:175`), and the group
headers are non-`option` children of a `role="listbox"`, which is an invalid listbox. With
a long upstream list that is 30 tab stops to reach the last token. The footer copy
("Click to insert at the cursor", `:196-198`) is at least honest about the current state —
do not change it to the `↑↓ move · ↵ insert` string until the keys work.

One thing to verify by hand: `insert()` restores the caret in a `requestAnimationFrame`
(`token-field.tsx:259-263`) while base-ui's popover returns focus to its trigger on close.
Those race. If the caret lands on the `Braces` button instead of the field, sequence the
focus restore after the close transition.

**M4d — Focus visibility.** §7.1's two-part indicator is nowhere. Node cards have no
`:focus-visible` style at all, so the only focus affordance on a focused card is React
Flow's default outline over a card that already paints its own ring — in practice
invisible on the selected card. Handles have none. The token trigger uses a single-part
`focus-visible:ring-2 ring-ring` (`token-field.tsx:116`), which is exactly the case §7.1
measured at 2.32:1 for the amber accent in light mode. The accent-independent outer
hairline is what makes the composite compliant; add it as one utility class and apply it
at all four sites.

**Contrast — what passes.** Verified in both modes at the app's five accents: category
label 5.15–10.62 ✅; `line` on card 3.81–9.13 ✅ (selected border); `line` on the stage
3.63+ ✅; `--muted-foreground` 5.51–5.82 ✅; success/warning/destructive on their surfaces
4.95 / 5.31 / 5.21 ✅. The resting hue-tinted border lands 1.96–3.09 exactly as §2.4
intended. The only contrast failure in the build is M5.

---

## 4. Interaction correctness

**Drag-to-connect ("A→B moves B after A") is correct but undiscoverable.** `graph.ts:286-322`
is the right model and the file's header argues it well — a derived edge cannot disagree
with the tree. But nothing in the UI says so. The user's mental model from every other
canvas tool is "I am adding a link"; here the card *teleports*, its subtree comes with it,
and if the target was an ancestor **nothing happens at all** (`graph.ts:297`) with no
feedback. Three cheap fixes, in order of value:

1. **S13 (should-fix)** — a connection-line label or a toast on drop: *"`send_receipt` now
   runs after `check_vip`."* One sentence, and the model is learned in one drag.
2. **S14 (should-fix)** — `isValidConnection` on `<ReactFlow>` so an ancestor target
   refuses visibly (React Flow paints the invalid state) instead of silently no-op-ing.
3. **C9** — highlight the moved card for ~1s after the drop; §2.4's Flash state, reused.

Also note `handleConnect`'s trigger branch (`automation-canvas.tsx:253-261`) moves the
target to root index 0 — correct, and worth the same toast treatment.

**Empty state** — see S10.

**30+ nodes.** Two problems compound. Layout: `NODE_HEIGHT = 96` (`graph.ts:69`) against a
real card of ~130px (four rows) or ~160px (branching, with footer), and `autoLayout`'s
default `rankSep` of 80 (`lib/flows/layout.ts:59`). Pitch is 176px, so a branching card
clears its successor by ~16px and a condition with a 2-line summary can touch it. The spec
said 124/64 for exactly this reason. Second: §7.6's `zoom < 0.5` rule (hide rows 3–4 via
`useStore(s => s.transform[2])`) is not implemented, so at the zoom you need for 30 nodes
every card renders four rows of 10.5–13px text as unreadable 5px smear rather than
degrading to a legible two-row chip. `minZoom={0.2}` is set (`automation-canvas.tsx:398`),
so this state is reachable.

Third, and worse at scale: `derivedNodes` recomputes on every keystroke (dep chain
`steps → flat → derivedNodes`, `automation-canvas.tsx:118-186`) and, while any step is
unpositioned (M2), that means **running dagre over the whole graph on every keystroke** in
the inspector. At 30+ nodes that is a typing-latency problem, not just a wasted render.
Fixing M2 fixes this too.

**Below 1024px.** `useIsNarrow` (`automation-canvas.tsx:469-479`) implements one breakpoint
where §4.4 specified two. At 768–1023px the spec wanted a full-width *wireable* canvas with
an overlay sheet; the build disables `nodesDraggable`/`nodesConnectable` from 1023px down,
applying the sub-768 read-only rule to tablets. Defensible (finger targets), but then
§4.4's forced auto-layout and `fitView` for the read-only case are missing, so a
narrow-screen user gets a non-wireable graph in whatever positions it had — including the
snap-back from M2. Decide which rule you want and implement it once.

**S15 (should-fix, mobile)** — `SheetContent` defaults `showCloseButton` to `true`
(`components/ui/sheet.tsx:41`), rendering an `absolute top-3 right-3` close button on top
of the inspector's own `X` at `step-inspector.tsx:105-112`. Two close buttons, overlapping,
at every viewport under 1024px. Pass `showCloseButton={false}` at
`automation-canvas.tsx:455`. The sheet also has no title, so the dialog is unnamed —
render a visually-hidden one.

**C10** — a branching step that is *also* a rejoin target (condition directly following a
condition) renders both the `continue` source handle and the `rejoin` target handle at
`Position.Right`, vertically centred, on top of each other
(`step-node-card.tsx:308-325`). Offset one.

---

## 5. Light theme specifically

Ranked by what a user would notice first:

1. **Every icon chip is the same pale blue** (§1.3 above). `#deecf8` … `#ededff` across
   all nine categories. In dark mode the drift exists too but the chips are dark enough
   that it reads as neutral tinting; in light mode the tint is the visible part of the
   chip, so the category colour system visibly does not exist. Spec bug; fix `soft`.
2. **Six of nine glyphs fail 3:1** (M5). Worst is logic at 2.21:1 — an amber `GitBranch`
   on a pale lavender chip on white.
3. **`line` hue drifts up to 36°** — amber ports and the amber selected border render
   orange (h 65 → 29); the emerald trigger's stroke goes teal (162 → 184). Contrast holds;
   the canvas simply is not the same palette it is in dark mode.
4. **Card shadows.** `0 4px 12px -6px oklch(0 0 0 / .25)` plus, on selection, `0 14px 36px
   -12px var(--nc-ring)` (`step-node-card.tsx:87-88`). Tuned for a `oklch(0.13)` stage;
   on `oklch(0.968)` the resting shadow is heavier than the 1.96–2.26:1 border it sits
   under, so cards read as floating rather than outlined. Halve the alpha in light mode
   via a token, or accept it — cosmetic.
5. **The add-step button's hardcoded `rgba(0,0,0,0.5)` shadow** (`add-step-menu.tsx:76`,
   copied from `flow-canvas.tsx:731`) is a 50%-black drop shadow on a near-white stage.
   Same call as (4).
6. **`colorMode` is left at React Flow's default `'light'`**, so xyflow's own dark tokens
   (connection line, selection rect, resizer) never apply in dark mode — which is why
   `Controls` and `MiniMap` need the `!` overrides at `automation-canvas.tsx:408`,
   `425`. Not a light-mode bug, but wiring `colorMode` to the app's `data-mode` would let
   those overrides go. **C11.**

Nothing in light mode is *broken* in the sense of unreadable text — `text` and
`--muted-foreground` are solid in both modes. It is the hue system that does not survive
the trip.

---

## 6. Keep — these are right, do not rewrite them

- **Availability badges.** `step-node-card.tsx:233-252` + `lib/automations/availability.ts`.
  "Never runs", "Not on Instagram", with the reason in the inspector
  (`step-inspector.tsx:127-143`) and in the add menu (`add-step-menu.tsx:160-169`). The
  spec never asked for this. It is the most product-specific thing on the canvas: it turns
  a silent engine skip into a visible fact at the moment of choosing. Three surfaces, one
  source.
- **The diagnostics vocabulary.** `lib/automations/diagnostics.ts` — "Outside WhatsApp's
  24-hour window", "Sends after closing the conversation", "'March webinar' is a filter
  segment", "This automation runs itself", "Credentials are stored in this automation".
  Not one of these could belong to another product. The header placement before Save
  (`automation-builder.tsx:179-182`) is also right.
- **Tab order = execution order** (`automation-canvas.tsx:158-170` via `flattenSteps`).
  §7.2 called this "the single biggest determinant of whether keyboard use is coherent"
  and it is the one §7 item that landed.
- **The branch footer.** `step-node-card.tsx:337-370`. Word + wash + port as one object,
  and the random-split variant reusing the same footer to show `70% / 30%` is a better
  idea than the spec's.
- **Token scoping.** `tokens.ts:118-163` — a step in the `no` branch is not offered `yes`
  branch tokens, and conditional ones are labelled rather than hidden. This is the kind of
  correctness a picker is worth building for.
- **`connectSteps` as a move, and derived edges generally** (`graph.ts:23-27, 286-322`).
  The model is right; only its discoverability (S13/S14) and one handle id (M1) are wrong.
- **Inline delete confirmation** (`step-inspector.tsx:263-292`) and the remount-per-step
  strategy (`automation-canvas.tsx:336`, `step-inspector.tsx:68-71`).

---

## 7. Ranked index

**Must-fix**

| # | Finding | Where |
| --- | --- | --- |
| M1 | Rejoin edge never renders — `sourceHandle: 'next'` on a card with no `next` handle | `graph.ts:413` |
| M2 | Node drags snap back while any step is unpositioned; also causes dagre-per-keystroke | `graph.ts:457-475`, `graph.ts:140-151` |
| M3 | `Enter` on a focused node does not open the inspector; selection is two desynced facts | `automation-canvas.tsx:141-186, 388` |
| M4 | §7 accessibility: 79 unlabelled controls, no node `aria-label`, unnamed `role=application`, no focus ring, no skip link, no picker keyboard | `token-field.tsx:42-76`, `automation-canvas.tsx:379`, `step-inspector.tsx:91` |
| M5 | Icon glyph painted `solid`; 6/9 categories under 3:1 in light mode | `step-meta.tsx:443` |

**Should-fix**

S1 no `markerEnd` arrows or `pathOptions.borderRadius` on any edge (`automation-canvas.tsx:197-218`) ·
S2 raw `<select>` + `SELECT_CLASS` throughout, the one thing §0 said not to inherit (`step-fields.tsx:32`, 20 sites; `trigger-inspector.tsx:168` etc.) ·
S3 no hover state on cards despite the declared transition (`step-node-card.tsx:185`) ·
S4 no resize rail, no persisted width, no width transition (`automation-canvas.tsx:447-449`) ·
S5 one breakpoint where §4.4 specified two; no read-only `fitView` (`automation-canvas.tsx:469-479`) ·
S6 add/remove not collapsed to a mode — four near-identical rows, and `Tag`/`TagIcon` are the *same* lucide glyph, as are both segment entries (`step-meta.tsx:221-244`) ·
S7 "Preview" strip previews nothing (`token-field.tsx:320-343`) ·
S8 no Flash state, so diagnostics jump-to-step doesn't mark the card (`diagnostics-panel.tsx:110`) ·
S9 trigger chip is `soft` on a `soft` strip — 1.00:1, invisible (`step-node-card.tsx:116-123`) ·
S10 generic empty state (`automation-canvas.tsx:436-442`) ·
S11 add menu: no rail colour dots, no Recent, no keyboard, no tablist ARIA (`add-step-menu.tsx:103-125`) ·
S12 §8 item 7 not done — flows still paints `c.solid` on handles and selected borders (`flow-canvas.tsx:158,160,226,244`) ·
S13 no feedback that a connection moved a step ·
S14 no `isValidConnection`, so an ancestor drop silently no-ops (`graph.ts:297`) ·
S15 duplicate close buttons in the mobile sheet (`automation-canvas.tsx:455`) ·
S16 `notify_team` uses `Zap`, the trigger's glyph (`step-meta.tsx:279`)

**Consider**

C1 no stage container — the automations canvas is edge-to-edge on `--background` while flows is an inset `rounded-xl border bg-card-2` (`flow-editor-shell.tsx:133`); §0 wanted them to match ·
C2 dagre constants 260/96 vs real 264/~130–160; rankSep 80 leaves ~16px under a branching card ·
C3 the panel-clearing nudge hardcodes 400px against a `clamp(360,30vw,460)` panel (`automation-canvas.tsx:312`) ·
C4 no `prefers-reduced-motion` handling (`setCenter` duration 200, card transitions) ·
C5 no `scale(1.25)` connecting state on handles ·
C6 no `Ctrl/Cmd+Space` token shortcut ·
C7 no `<mark>` highlight on search matches in either popover ·
C8 no `zoom < 0.5` row hiding ·
C9 no post-move flash ·
C10 `continue` and `rejoin` handles overlap on a condition-after-condition ·
C11 wire `colorMode` to the app's `data-mode` and drop the `!` overrides ·
C12 no 240-char counter on the team note; delete confirmation never auto-reverts after 4s

---

## PASS criteria

1. The dashed continue edge renders from the right-edge port to the rejoin port on a
   condition with a following step, with an arrowhead, and `graph.test.ts` asserts
   `sourceHandle: 'continue'`.
2. Dragging any card on a freshly-created automation keeps its position across a save and
   a reload.
3. Keyboard only, from page load: reach a node, open its inspector, edit a field, reach the
   token picker, insert a token, close the panel, return to the canvas. Focus is visible at
   every step.
4. Every control in the ~25 forms has an accessible name; every node announces its
   category, title and summary.
5. `soft` and the glyph colour fixed: at 1440px and 390px, in **light** mode, the nine
   category chips are nine distinguishable hues and every glyph measures ≥3:1.
6. Screenshot the empty state, a 30-node graph at fit-zoom, and the 390px sheet. None
   shows placeholder filler, unreadable text, or two close buttons.
7. The condition card's three outputs remain distinguishable in a greyscale screenshot —
   they currently would be, once (1) lands.
