# Automation canvas — visual design spec

Design language for the new React Flow automation editor that replaces
`apps/web/src/components/automations/automation-builder.tsx`.

**This spec is visual only.** Data model, engine semantics and persistence are out of
scope. Every token, class and helper named here already exists in the repo — nothing in
this document requires a new dependency.

## 0. What it inherits, and from where

| Thing | Source of truth | Rule |
| --- | --- | --- |
| Colour tokens | `apps/web/src/app/globals.css` | Mode blocks (`:root` / `html[data-mode="light"]`) define every neutral + status token. **No `dark:` utilities** — this app switches on `html[data-mode]` and never sets a `.dark` class, so `dark:` never fires (globals.css:30-43). |
| Per-node hue system | `apps/web/src/components/flows/shared.tsx:208-247` | `NODE_HUE` + `nodeColors()`. We extend the same idiom; see §1. |
| Icon chip | `flows/shared.tsx:257-284` (`NodeIconChip`) | Same geometry, same `soft`/`solid` pairing. Automations get its twin, `StepIconChip`. |
| Add-menu grouping | `flows/shared.tsx:186-194` (`groupNodeTypesByCategory`) | Same shape, more categories. |
| Canvas chrome (dots, `Controls`, `MiniMap`) | `flows/flow-canvas.tsx:546-566` | Copy verbatim. Consistency between the two graph editors is the point. |
| Stage container | `flows/flow-editor-shell.tsx:133` | `rounded-xl border border-border bg-card-2`, `mx-6`. |
| Field label / helper typography | `flows/forms/fields.tsx:45` and `automations/automation-builder.tsx:2027` (`FieldBlock`) | `text-xs text-muted-foreground`, `mb-1 block`. |
| Slug coercion | `flows/shared.tsx:296` (`slugify`) | Reference names go through it. Do not write a second one. |
| Viewport shim | `flows/flow-editor-shell.tsx:159` (`useMatchMedia`) | Reuse the pattern; do not add `react-responsive`. |

Deliberately **not** inherited from the old builder:

- `SELECT_CLASS` (`automation-builder.tsx:373`) — a raw `<select>` string. The new panel
  uses `components/ui/select.tsx` (base-ui) so focus, keyboard and popup styling match
  the rest of the app.
- `STEP_META.border` (`automation-builder.tsx:99-118`) — every action shared one
  `border-l-primary`, so 15 step types looked identical. Colour now means *category*.

---

## 1. Colour — one hue per category

### 1.1 Why category, not type

Flows has 11 node types and gives each its own hue. Automations has 24 step types; 24
hues is noise, not information. Colour answers **"what kind of thing is this step?"**;
the icon and title answer "which one".

### 1.2 The hue table

Same shape as `NODE_HUE` in `flows/shared.tsx:208`. Put this in a new
`apps/web/src/components/automations/canvas/shared.tsx`.

```ts
export type StepCategory =
  | 'trigger' | 'messaging' | 'contact' | 'crm'
  | 'conversation' | 'logic' | 'data' | 'orchestration';

const CATEGORY_HUE: Record<StepCategory | 'neutral', { l: number; c: number; h: number }> = {
  trigger:       { l: 0.62, c: 0.13, h: 162 }, // emerald  — = flows `start`
  messaging:     { l: 0.60, c: 0.18, h: 293 }, // violet   — = flows `send_message`
  contact:       { l: 0.65, c: 0.15, h: 350 }, // pink     — = flows `set_tag`
  crm:           { l: 0.66, c: 0.16, h:  20 }, // coral    — NEW (flows has no deals)
  conversation:  { l: 0.68, c: 0.13, h: 225 }, // azure    — = flows `set_segment`
  logic:         { l: 0.72, c: 0.15, h:  65 }, // amber    — = flows `condition`
  data:          { l: 0.65, c: 0.10, h: 185 }, // teal     — = flows `collect_input`
  orchestration: { l: 0.62, c: 0.16, h: 254 }, // cobalt   — = flows `send_buttons`
  neutral:       { l: 0.55, c: 0.01, h: 260 }, // grey     — = flows `end` (disabled state)
};
```

Seven of nine values are **literally lifted** from `NODE_HUE`, matched on meaning:
a message is violet in both editors, a branch is amber in both, a tag is pink in both.
Only `crm` is new, because flows has no concept of a deal. It sits at h 20, one step
warmer and lighter than flows' `handoff` (h 16) — the same warm family, which is
semantically right (both mean *this leaves the bot and becomes a human's problem*) and
never collides, because `handoff` cannot appear on an automation canvas.

Minimum hue separation between adjacent categories is 29° (`conversation` 225 ↔
`orchestration` 254), and every such pair also differs in lightness and chroma.

### 1.3 Derived variants — `stepColors()`

Flows' `nodeColors()` exposes `solid / soft / ring / text`. **We add a fifth, `line`,
and it is the one that gets painted.**

```ts
export interface StepColors {
  solid: string; // raw hue. Decorative only — minimap dots. Never a stroke, never a glyph.
  line:  string; // every stroke, port, glyph, selected border. ≥3:1 in BOTH modes.
  soft:  string; // icon-chip fill, branch-zone wash.
  ring:  string; // selection glow.
  text:  string; // the uppercase category label. ≥4.5:1 in BOTH modes.
}

export function stepColors(cat: StepCategory | 'neutral'): StepColors {
  const t = CATEGORY_HUE[cat];
  const solid = `oklch(${t.l} ${t.c} ${t.h})`;
  return {
    solid,
    line: `color-mix(in oklch, ${solid}, var(--foreground) 22%)`,
    soft: `color-mix(in oklch, ${solid} 16%, var(--card))`,
    ring: `oklch(${t.l} ${t.c} ${t.h} / 0.45)`,
    text: `color-mix(in oklch, ${solid}, var(--foreground) 38%)`,
  };
}
```

**How one value is correct in both themes.** `--foreground` is near-white in dark mode
and near-black in light mode, so `color-mix(… , var(--foreground) N%)` always moves the
hue *away from the card* — lighter on a dark card, darker on a white one. One
declaration, no `dark:` variant, no second palette. This is flows' trick
(`shared.tsx:240-246`); we apply it to strokes too, which flows does not.

**Why `line` is required — the light-mode bug this fixes.** `flow-canvas.tsx` paints
handles and selected borders with `c.solid` (lines 226, 243, 158). Measured against
`--card` in light mode that is **2.53:1** for the amber hue and **2.74:1** for azure —
both fail SC 1.4.11 (3:1 for non-text UI). `line` at a 22% mix lifts the worst case to
**3.81:1**. Rule: **`solid` is never painted directly.** Worth back-porting to flows.

### 1.4 Measured contrast — every value, both modes

Card is `--card` (`oklch(0.18 0.01 260)` dark / `oklch(0.995 0.002 260)` light). Stage
is `--card-2`. Chip is `soft` composited over `--card`.

| Category | `text` on card D / L | `line` on card D / L | `line` glyph on chip D / L | `line` on stage D / L |
| --- | --- | --- | --- | --- |
| trigger | 8.78 / 6.07 | 7.25 / 4.65 | 4.45 / 4.20 | 6.91 / 4.43 |
| messaging | 7.97 / 6.94 | 6.28 / 5.58 | 4.24 / 4.98 | 5.98 / 5.31 |
| contact | 8.92 / 6.15 | 7.27 / 4.80 | 4.50 / 4.32 | 6.92 / 4.57 |
| crm | 9.11 / 6.05 | 7.48 / 4.68 | 4.55 / 4.22 | 7.12 / 4.45 |
| conversation | 9.82 / 5.34 | 8.38 / 4.00 | 4.64 / 3.65 | 7.98 / 3.81 |
| logic | 10.48 / 5.15 | 9.03 / 3.81 | 4.79 / 3.49 | 8.60 / 3.63 |
| data | 9.35 / 5.72 | 7.85 / 4.35 | 4.58 / 3.94 | 7.48 / 4.14 |
| orchestration | 8.48 / 6.38 | 6.88 / 5.00 | 4.36 / 4.49 | 6.55 / 4.76 |
| neutral | 7.44 / 7.66 | 5.71 / 6.27 | 4.07 / 5.58 | 5.44 / 5.97 |

- **Worst text: 5.15:1** (logic, light) — passes AA 4.5:1 at any size. ✅
- **Worst stroke/glyph: 3.49:1** (logic glyph on chip, light) — passes 3:1. ✅

Supporting tokens, same method:

| Pair | Dark | Light |
| --- | --- | --- |
| `--muted-foreground` on `--card` | 5.82 | 5.79 |
| `--muted-foreground` on `--card-2` (edge strokes) | 5.54 | 5.51 |
| `--success` on `--card-2` (yes edge) | 8.29 | 5.23 |
| `--destructive` on `--card-2` (no edge) | 6.16 | 5.74 |
| `--success` on `--success-surface` (badge) | 7.06 | 4.95 |
| `--warning` on `--warning-surface` (badge) | 7.98 | 5.31 |
| `--destructive` on `--destructive-surface` (badge) | 5.32 | 5.21 |
| `--foreground` on `--card` | 18.01 | 15.32 |

The chip fill itself lands at 1.13–2.28:1 against the card and is **decorative** — the
glyph inside it carries the meaning at ≥3.49:1. Do not treat the chip as an information
channel.

### 1.5 Category → step type

24 step types. `blurb` is the one-line description shown in the add-step menu.

| Category | Step types (menu order) | lucide icon |
| --- | --- | --- |
| **Messaging** (7) | Send message · Send template · Send media · Send buttons · Send list · Send form · Send booking link | `MessageSquare` `FileText` `Paperclip` `ListChecks` `List` `ClipboardList` `CalendarClock` |
| **Contact** (4) | Tags · Segments · Contact field · Contact note | `Tag` `Layers` `PencilLine` `StickyNote` |
| **CRM** (2) | Create deal · Update deal | `Briefcase` `SquarePen` |
| **Conversation** (3) | Assign conversation · Set status · Close conversation | `UserCheck` `CircleDot` `CircleSlash` |
| **Logic** (4) | Condition · Random split · Wait · Wait until | `GitBranch` `Shuffle` `Hourglass` `Timer` |
| **Data** (2) | HTTP request · Set variable | `Webhook` `Variable` |
| **Orchestration** (2) | Start flow · Run automation | `Workflow` `Repeat2` |
| **Trigger** (1, fixed) | Trigger | `Zap` |

**Add/remove is a mode, not a type.** The old builder shipped `add_tag` / `remove_tag` /
`add_to_segment` / `remove_from_segment` as four separate entries
(`automation-builder.tsx:120-136`). The new menu shows **Tags** and **Segments** once
each, with the add/remove toggle as the first field in the panel. Four near-identical
rows sitting adjacent in a 24-row menu is the exact failure mode a grouped menu exists
to prevent. All four underlying types remain valid; only the *picker* collapses them.

All icons verified present in `lucide-react@1.22.0`.

---

## 2. Node card anatomy

### 2.1 Geometry

| Property | Value | Note |
| --- | --- | --- |
| Width | **264px fixed** | Not min/max like flows. A fixed width makes the TB spine read as a column and makes dagre spacing deterministic. |
| Width (condition / random split) | **264px** + branch footer | Same width; the footer splits inside it. Do not widen — an uneven column is the thing that makes a graph feel accidental. |
| Radius | `rounded-xl` (`--radius` × 1.4 = 14px) | Matches `flow-canvas.tsx:165`. |
| Padding | `px-3.5 py-3` | Matches flows. |
| Border | 1px, colour per state (§2.4) | |
| `NODE_WIDTH` / `NODE_HEIGHT` for dagre | `264` / `124` | Constants beside the ones at `flow-canvas.tsx:108-112`. |
| Layout direction | `autoLayout(…, { direction: 'TB' })` | `lib/flows/layout.ts`, same call as `flow-canvas.tsx:309`. |
| Rank separation | 64px vertical, 48px horizontal | Enough for a labelled edge to sit between two cards without overlap. |

### 2.2 Collapsed card content

```
┌────────────────────────────────────────────┐  ← 264px
│ ▣24  MESSAGING              ⏸ ⚠            │  row 1  h 24, gap 8
│ Send template                              │  row 2  mt-2
│ order_shipped · 3 variables                │  row 3  mt-1, clamp 2
│ ⟨steps.notify_customer⟩        on error →  │  row 4  mt-2
└────────────────────────────────────────────┘
```

| Row | Content | Class | Colour |
| --- | --- | --- | --- |
| 1 | `StepIconChip` 24px / glyph 14px, `rounded-md` | as `NodeIconChip` at `flow-canvas.tsx:184-189` | fill `soft`, glyph `line` |
| 1 | Category label | `truncate text-[10.5px] font-semibold tracking-wider uppercase` | `style={{ color: c.text }}` |
| 1 | Badge slot, right | `ml-auto flex items-center gap-1` | §2.3 |
| 2 | Step title | `truncate text-[13px] font-semibold leading-tight` | `text-foreground` |
| 3 | One-line summary | `line-clamp-2 text-[11.5px] leading-relaxed` | `text-muted-foreground` |
| 4 | Reference key | `truncate font-mono text-[10.5px]` | `text-muted-foreground` |

- Row 3 is the automations twin of `summarizeNode()` (`flows/shared.tsx:318`) — one
  `summarizeStep(step)` returning `string | null`. When it returns `null`, row 3 is
  **omitted** (not rendered empty) and the card is 20px shorter. A card that says
  nothing should be short, not blank.
- Row 4 renders the reference key alone, no `{{ }}` — braces at 10.5px are visual grit.
  The full token form appears in the panel header and in the token picker, where it is
  copyable.
- Nothing on the card is `title=`-tooltipped except row 3's truncated text (matching
  `flow-canvas.tsx:218`). The panel is one click away.

### 2.3 Badges

Fixed order, right-aligned in row 1. Never more than three.

| Badge | Trigger condition | Treatment | Contrast |
| --- | --- | --- | --- |
| **Paused** | step disabled | `Pause` 11px + `PAUSED`, `text-[8.5px] font-bold tracking-[0.1em] uppercase`, `border border-border rounded px-1.5 py-0.5`, `text-muted-foreground` | 5.82 / 5.79 |
| **Invalid** | required field empty / dangling reference | `CircleAlert` 12px `text-destructive`, plus `bg-destructive-surface text-destructive` pill | 5.32 / 5.21 |
| **Continue on error** | `on_error = 'continue'` | row 4 right side, `text-[9.5px] uppercase tracking-wide text-warning` + `bg-warning-surface` pill reading `on error → continue` | 7.98 / 5.31 |
| **Saves output** | `save_as` set | row 4 right side, mono `→ vars.x`, `text-muted-foreground` | 5.82 / 5.79 |

Every badge carries a **word or a glyph**, never colour alone.

### 2.4 States

CSS custom properties are set on the card root exactly as `flow-canvas.tsx:152-162`
does: `--nc-line`, `--nc-soft`, `--nc-ring`, `--nc-text`.

| State | Border | Shadow | Other |
| --- | --- | --- | --- |
| **Rest** | `1px solid color-mix(in oklch, var(--border), var(--nc-line) 45%)` | `0 1px 2px oklch(0 0 0 / .12), 0 4px 12px -6px oklch(0 0 0 / .25)` | — |
| **Hover** | `color-mix(in oklch, var(--border), var(--nc-line) 70%)` | `+ 0 8px 22px -10px oklch(0 0 0 / .35)` | `cursor-pointer`; transition `box-shadow, border-color` 150ms |
| **Selected** | `1px solid var(--nc-line)` + `box-shadow: 0 0 0 1px var(--nc-line)` | `0 14px 36px -12px var(--nc-ring)` | `aria-selected="true"` |
| **Keyboard focus** | as Selected | + focus ring, §7.1 | outline sits *outside* the selection ring |
| **Disabled** | `1px dashed var(--border)` | none | `opacity: .55; filter: saturate(.35)` — the card loses its hue, which is the point |
| **Invalid** | `1px solid var(--destructive)` + `box-shadow: 0 0 0 1px var(--destructive)` | as Rest | badge + icon, §2.3 |
| **Dragging** | as Selected | `0 20px 40px -16px oklch(0 0 0 / .5)` | `opacity: .85` |
| **Flash** (validator "look here") | `!border-warning ring-2 ring-warning/60` | — | 1.6s, then back. Uses the token, not `amber-400` as `flow-canvas.tsx:172` hard-codes. |

**Why the resting border is hue-tinted.** `--card` on `--card-2` measures **1.05:1** in
both modes — the card body is invisible against the stage on its own, and plain
`--border` only reaches 1.23–1.26:1. The 45% hue mix lifts the resting edge to ~2.0:1
(visible), while full `line` at ≥3.63:1 stays reserved for the *selected* state, which
is what SC 1.4.11 actually governs.

### 2.5 The trigger card

One per automation, always rank 0, never deletable, no target handle.

- `rounded-2xl`, **2px** border in `trigger.line`, not 1px.
- A full-width header strip: `bg-[var(--nc-soft)] rounded-t-[calc(var(--radius)*1.8-2px)] px-3.5 py-2`, containing the 24px chip and the word `TRIGGER` in `trigger.text`.
- Body below the strip on plain `bg-card`: trigger title (13px semibold), then the
  matched-channel chips reusing the pill styling at `automation-builder.tsx:1406-1411`.
- Bottom source handle only.

The shape difference (2px border, header strip, larger radius) is what tells you at a
glance where the graph starts — it does not depend on reading the label or on being
green.

---

## 3. Handles and edges

### 3.1 Handle geometry

| Property | Value |
| --- | --- |
| Visual size | 11×11px, `rounded-full`, `border-2`, fill `var(--card)` |
| Hit area | **24×24px** via `::after { content:''; position:absolute; inset:-7px; }` — flows' bare 10px handles (`flow-canvas.tsx:179`) are under the 24px minimum |
| Source (sequence) | bottom centre, border `var(--nc-line)` |
| Target (sequence) | top centre, border `var(--nc-line)` |
| Target (rejoin) | **right** edge, vertically centred, `border-dashed`, `border-muted-foreground`; rendered only when something is wired to it |
| Connecting | `scale(1.25)`, fill `var(--nc-line)` |

### 3.2 Edge kinds

All edges: `type="smoothstep"`, `pathOptions={{ borderRadius: 12 }}`, `strokeWidth: 1.5`,
`markerEnd` arrow in the same colour.

| Edge | Stroke | Dash | Label | Contrast on stage D / L |
| --- | --- | --- | --- | --- |
| Sequence | `var(--muted-foreground)` | solid | none | 5.54 / 5.51 |
| **Yes** / positive | `var(--success)` | solid | `Yes` | 8.29 / 5.23 |
| **No** / negative | `var(--destructive)` | solid | `No` | 6.16 / 5.74 |
| Split branch (random) | `var(--nc-line)` of `logic` | solid | `50%` (the weight) | 8.60 / 3.63 |
| **Continue** (rejoin) | `var(--muted-foreground)` | `strokeDasharray: '2 6'`, `strokeLinecap: 'round'` | `continues` | 5.54 / 5.51 |

Flows strokes edges with `var(--border)` (`flow-canvas.tsx:373`), which measures 1.23:1
against the stage — effectively invisible. Use `--muted-foreground`.

Edge labels: `labelStyle: { fill: 'var(--muted-foreground)', fontSize: 10.5, fontWeight: 600 }`,
`labelBgStyle: { fill: 'var(--card)' }`, `labelBgPadding: [5, 2]`, `labelBgBorderRadius: 4`.
Yes/No labels override `fill` to their own stroke colour. **Plain sequence edges get no
label** — labelling every arrow "next" is chrome.

### 3.3 Making the rejoin read as intentional

This is the one genuinely novel shape in the editor: a condition emits **yes**, **no**,
*and* a **continue** where execution rejoins the parent sequence. Three outputs from one
card looks like a mistake unless the third one is visibly a different *kind* of thing.
Four devices, all required together:

**a. Branch footer — yes/no live inside the card, not beside it.**
A full-width strip at the bottom of the condition card, `border-t border-border mt-2.5 pt-2`,
split `grid grid-cols-2`. Left half: `YES` in `text-[10px] font-bold uppercase tracking-wider text-success`
on `bg-success-surface`, `rounded-bl-[10px]`. Right half: `NO` / `text-destructive` /
`bg-destructive-surface` / `rounded-br-[10px]`. A 1px `border-border` divider between
them. Each half owns a source handle at its own bottom edge, horizontally centred in
*its half*. The word, the wash and the port are one object, so a branch is never
mis-wired by aiming at the wrong dot.

**b. Continue leaves from a different edge.**
The continue handle is on the card's **right edge**, vertically centred — never the
bottom. It is a dashed **ring** (`border-dashed`, `bg-transparent`), not a filled dot.
A persistent 10.5px `text-muted-foreground` label `continues after` sits to its right,
outside the card. Different edge + different fill + a standing label = a different kind
of output, decided before the user has read anything.

**c. The path is unmistakably a bypass.**
It leaves right, runs down a gutter at `x = cardRight + 32px`, and enters the rejoin
node's **right** target handle. A path that leaves the right and arrives at the right,
dashed, while the spine runs top-to-bottom solid, cannot be misread as a third branch.

**d. Branch scope ribbon.**
Behind the branch subtrees, a rounded rect from the condition card's bottom to the
rejoin node's top: `fill: var(--nc-soft)` of `logic`, `stroke: color-mix(in oklch, var(--nc-line) 30%, transparent)`,
`1px dashed`, `rx: 16`, inset 12px around the subtree bounds. Implement as a React Flow
node `type: 'branchScope'` with `draggable: false`, `selectable: false`, `focusable: false`,
`zIndex: -1`, `aria-hidden`. Contrast is 1.1–2.3:1 — it is a *region*, deliberately below
the threshold of a foreground object, and it carries no information the edges do not.

**e. Copy on the receiving card.**
The rejoin target shows a `CornerDownRight` 11px + `rejoins here` chip in row 1's badge
slot, `text-muted-foreground`, `border-dashed border-border`.

---

## 4. Right sidebar — docked step inspector

Not a modal. Not `sheet.tsx` at desktop widths. A sibling flex child that the canvas
shrinks beside.

### 4.1 Frame

```
<div class="flex h-full min-h-0">
  <div class="relative min-w-0 flex-1">   ← React Flow
  <ResizeRail />                          ← 1px visual / 6px hit
  <aside id="step-inspector" ...>         ← the panel
</div>
```

| Property | Value |
| --- | --- |
| Width | `clamp(360px, 30vw, 460px)`; default **400px** at ≥1280px, **360px** at 1024–1279px |
| Persisted | `localStorage["converse360.automationEditor.panelWidth"]` — same convention as `flow-editor-shell.tsx:50` |
| Surface | `bg-popover border-l border-border` (matches `flow-canvas.tsx:625`) |
| Resize rail | 1px `bg-border`, 6px hit area, `cursor-col-resize`, `hover:bg-[var(--nc-line)]`; `role="separator" aria-orientation="vertical" aria-label="Resize step settings" tabindex="0"` with ←/→ moving 16px and Home/End snapping to min/max |
| Enter / exit | `width` transition 180ms `ease-out`; skipped under `prefers-reduced-motion` |
| Canvas response | On open, **do not `fitView`** — it re-frames the whole graph and loses the user's place. Instead: if the selected node's screen-x exceeds `canvasWidth − panelWidth − 40`, `setCenter` by the *minimum* delta that clears it, `duration: 200` (0 under reduced motion). |

### 4.2 Section order and rhythm

Base unit 4px. Three flex children; **only the middle one scrolls**.

**Header** — `flex-none border-b border-border px-4 pt-3.5 pb-3`

| Row | Content | Spec |
| --- | --- | --- |
| A | `StepIconChip` 32px / glyph 16px · category label + title stacked · `Switch` · close `X` | chip `rounded-lg`; label `text-[10.5px] uppercase tracking-wider font-semibold` in `c.text`; title `text-sm font-semibold text-foreground truncate`; `Switch` from `components/ui/switch.tsx` with a 10.5px `text-muted-foreground` caption reading `Enabled` / `Paused`; close is a 28px ghost icon button |
| B | `mt-2.5` · reference name | mono prefix chip `steps.` (`bg-muted text-muted-foreground rounded-l px-1.5 py-1 font-mono text-[11px]`) fused to a borderless mono input (`bg-transparent hover:bg-muted focus:bg-muted rounded-r px-1.5 py-1 font-mono text-[12px] text-foreground w-full`), then a 24px `Copy` ghost button that copies `{{ steps.<key> }}` and fires a `sonner` toast |

Reference-name rules:
- Coerced through `slugify(value, fallback)` (`flows/shared.tsx:296`) **on blur**, not on
  keystroke — rewriting under the caret is hostile.
- Duplicate → `aria-invalid="true"`, 1px `--destructive` underline, a 11px
  `text-destructive` line reading `Another step already uses lookup_order.`, and an
  auto `_2` suffix applied on blur.
- Empty → falls back to `step_<n>`.

**Body** — `flex-1 overflow-y-auto overscroll-contain px-4 py-4 space-y-5`

1. **Config fields** — no visible section heading; the header already says what this is.
2. `<Separator />` (`components/ui/separator.tsx`)
3. **Advanced** — closed by default.

Field block (the automations successor to `FieldBlock` at `automation-builder.tsx:2018`):

```
label row  ── label 12px medium text-muted-foreground | right: [token btn] [counter]
  mb-1.5
control    ── Input / Textarea / Select / KV table
  mt-1
helper     ── 11px text-muted-foreground, or the token preview strip (§5.3)
```

- Fields inside a block: `gap-1.5`. Between blocks: `space-y-4`. Between sections: `space-y-5`.
- Controls: `components/ui/{input,textarea,select,switch,radio-group}.tsx`, all with
  `className="bg-muted"` to match `flows/forms/fields.tsx:50`.
- **Key/value tables** (HTTP headers, JSON body fields):
  `grid grid-cols-[1fr_1fr_28px] gap-1.5`, rows 32px, header row `text-[10px] uppercase tracking-wider text-muted-foreground`,
  a trailing ghost `+ Add header` row. Each value cell carries its own 16px token button
  that appears on `:hover` **and `:focus-within`** — the focus-within half is not
  optional; without it the buttons are keyboard-unreachable.

**Advanced disclosure** — `components/ui/accordion.tsx`, `type="single" collapsible`,
trigger `text-xs font-medium text-muted-foreground` + `ChevronDown` 14px:

| Field | Control | Default |
| --- | --- | --- |
| If this step fails | `RadioGroup`: `Stop the run` / `Carry on to the next step` | Stop |
| Save the result as | mono `Input`, prefixed `vars.`, slugified on blur | empty |
| Note for your team | `Textarea` rows 3, 240-char counter | empty |

Choosing `Carry on` puts the `on error → continue` badge on the card (§2.3) — a setting
with no canvas consequence is a setting people forget they set.

**Footer** — `flex-none border-t border-border px-4 py-3 flex items-center justify-between`

- Left: `Duplicate` (ghost, `Copy` 14px).
- Right: `Delete` (ghost, `text-destructive hover:bg-destructive/10`, matching
  `flow-canvas.tsx:668`).
- Delete confirms **inline**, not in a dialog: the button swaps to
  `Delete step?` · `Cancel` · `Delete`, reverting after 4s. Focus moves to `Cancel`.
- The trigger node's panel has **no footer** — there is exactly one and it cannot be
  removed or copied.

### 4.3 Scroll behaviour

- Header and footer are flex siblings, **not** `position: sticky`. Sticky inside a
  scroller fights base-ui's portalled popovers at the edges.
- Body: `overscroll-contain`, so scrolling past the end does not start panning the canvas.
- On step change: reset `scrollTop` to 0, and move focus to the panel heading
  (`tabindex="-1"`), so the next Tab starts inside the panel.
- Long selects and the token popover are portalled (`popover.tsx:29` uses
  `PopoverPrimitive.Portal`) and therefore escape the scroll container correctly.

### 4.4 Below 1024px

| Viewport | Canvas | Panel |
| --- | --- | --- |
| ≥1280px | docked, `flex-1` | docked, 400px |
| 1024–1279px | docked, `flex-1` | docked, 360px |
| 768–1023px | full width | **overlay** — `components/ui/sheet.tsx`, `side="right"`, `w-full sm:max-w-[420px]`, modal, `Esc` closes |
| <768px | full width, **read-only graph**: `nodesDraggable={false}`, `nodesConnectable={false}`, forced auto-layout, `fitView` | overlay sheet, as above |

A 400px panel next to a 624px canvas is two unusable things, so at `lg` and below the
panel stops stealing width and becomes an overlay. Below `md` the graph stays *readable*
but stops being *wireable* — 11px handles and finger drags do not combine, the same call
`flow-editor-shell.tsx:40-46` makes. Editing still works everywhere: tap a node, the
sheet opens. Detect with the `useMatchMedia` shim at `flow-editor-shell.tsx:159`; do not
add a dependency.

---

## 5. Token picker

### 5.1 The trigger

A 20×20 ghost icon button in the field's **label row, far right** — never inside the
input, where it would overlap text and shrink the typing area.

- Icon `Braces` 13px, `text-muted-foreground hover:text-foreground`.
- `aria-label="Insert data from an earlier step"`, `aria-haspopup="dialog"`.
- Appears always on single fields; on KV-table cells, on `:hover` / `:focus-within`.
- Keyboard shortcut inside a token-capable field: `Ctrl/Cmd + Space`.

### 5.2 The popover

`components/ui/popover.tsx` with `align="end" side="bottom" sideOffset={6}`. Note the
component defaults to `w-72` (`popover.tsx:39`) — override.

| Property | Value |
| --- | --- |
| Width | `w-80` (320px), `p-0` (override the default `p-2.5`) |
| Max height | 380px total: 40px search + 300px scroll + 40px footer |
| Search | `flex-none border-b border-border px-3 py-2`, `Search` 13px + borderless input, autofocused, placeholder `Search data…` |
| List | `max-h-[300px] overflow-y-auto overscroll-contain py-1` |
| Group header | `sticky top-0 bg-popover px-3 py-1.5 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground` |
| Row | `px-3 py-1.5 min-h-[38px]`, two lines: label `text-[12.5px] text-popover-foreground`, path `font-mono text-[10.5px] text-muted-foreground truncate`; right-aligned sample value `text-[10.5px] text-muted-foreground truncate max-w-[96px]` when known |
| Row hover / active | `bg-muted` |
| Footer | `flex-none border-t border-border px-3 py-1.5 text-[10.5px] text-muted-foreground`, showing `↑↓ move · ↵ insert · esc close` |

**Group order — nearest-first, deliberately:**

1. `Trigger` — what fired the run
2. `Contact` — the person
3. `Variables` — everything a `Set variable` or `Save the result as` has produced
4. …then **one group per preceding step, nearest first**, headed by its reference name
   and its 16px category chip, so the group header is colour-coded to the card upstream.

Only steps that actually run *before* this one appear. A step inside the `no` branch is
not upstream of a step inside `yes`; the picker must not offer it. Downstream and
sibling-branch steps are **omitted, not disabled** — a disabled row invites the question
"why", and there are potentially twenty of them.

**Search:** case-insensitive substring across label + path + group name. No fuzzy
matching — there is no `cmdk` in this repo (`components/ui/` has no `command.tsx`) and
adding one for substring search is not worth a dependency. Matched substrings get a
`<mark class="bg-primary-soft-2 text-foreground rounded-[2px]">` — legal here because a
popover row is a `<div>`, not an `<input>`.

**Empty states:**

| Case | Copy | Affordance |
| --- | --- | --- |
| No search match | `No data called "ordr".` | Ghost row: `Insert {{ ordr }} anyway` — power users know paths we have not indexed |
| No preceding steps | `Nothing upstream yet.` / `Only the trigger and contact fields are available until you add a step above this one.` | Trigger + Contact groups still render below |
| Step has no known outputs | `Send message doesn't produce data.` under that group header | — |

**Keyboard:** `↑`/`↓` move across group boundaries, `Home`/`End` jump, `Enter` inserts and
closes, `Esc` closes and **restores the caret to its pre-open position**. The active row
is tracked with `aria-activedescendant` on the search input; the list is
`role="listbox"`, rows `role="option"`.

### 5.3 Rendering a token legibly inside a plain `<input>`

We cannot style a substring inside an `<input>`. Five things make the plain field
readable anyway:

1. **The field switches to mono the moment it contains `{{`.**
   `className={cn('bg-muted', value.includes('{{') && 'font-mono text-[12px]')}`, using
   `--font-mono` (`globals.css:11` → `var(--font-geist-mono)`). Braces, dots and
   underscores are what a token is made of, and a proportional face mushes all three.
2. **Inserted tokens always carry inner spaces:** `{{ steps.lookup_order.body.id }}`,
   never `{{steps.lookup_order.body.id}}`. Normalise on insert. The spaces are most of
   the scannability at 12px. Insert with a leading space when the caret is mid-word so a
   token never abuts prose.
3. **A preview strip does the syntax highlighting**, directly under the field, in the
   helper slot: `rounded-md border border-border bg-card px-2 py-1.5 font-mono text-[11px] leading-relaxed`.
   It renders the same string with each token replaced by its sample value, and wraps
   each substitution in `<span class="rounded-[3px] bg-primary-soft px-1 text-primary">`.
   This is a `<div>`, so highlighting is free. Prefixed `Preview` in
   `text-[10px] uppercase tracking-wider text-muted-foreground`. It is the field's real
   answer to "what did I just write" — the input shows *syntax*, the preview shows
   *meaning*.
4. **Broken tokens surface in the preview, not the input.** A token pointing at a deleted
   or downstream step renders as `<span class="bg-destructive-surface text-destructive">`
   with the raw path preserved, the field gets `aria-invalid="true"` and a 1px
   `--destructive` underline, and the card gets the Invalid badge (§2.3). Three places,
   one fact.
5. **A count chip** sits in the label row next to the token button: `2 tokens`,
   `text-[10px] text-muted-foreground`. Zero → hidden.

**Explicitly rejected: the mirrored-overlay highlight** (transparent-text input over an
absolutely-positioned `<div>` painting `<mark>` spans). It needs pixel-identical
typography, per-frame scroll sync and `caret-color` juggling; it breaks IME composition,
native find-in-page and text selection colour; and when the mirror desynchronises the
user sees highlighting over the *wrong* characters, which is strictly worse than no
highlighting. The preview strip gets 90% of the value at 5% of the risk. For multi-line
`Textarea` fields the preview strip simply grows — same component, `max-h-32 overflow-y-auto`.

---

## 6. Empty state and the add-step menu

### 6.1 Empty automation

There is always exactly one trigger, so the canvas is never truly blank. Render the
trigger card at the top and, 64px below it, a dashed drop target:

- `264 × 64px`, `rounded-xl border border-dashed border-border bg-card/40`,
  centred `Plus` 16px + `Add your first step` in `text-[12.5px] text-muted-foreground`.
- Hover / focus: `border-[var(--nc-line)]` of `messaging` (the most likely first step),
  `bg-muted`.
- Connected to the trigger by a dashed sequence edge in `--muted-foreground`.

Below the fold, a centred non-blocking hint panel, `max-w-[420px] text-center`:

> **Nothing happens yet.**
> Add a step and it will run every time this trigger fires.
> `[Send a message]` `[Add a tag]` `[Wait, then follow up]`

Three ghost buttons that add a pre-configured step and open its panel. Three is the cap;
a wall of templates on an empty canvas is a second decision before the first one.

### 6.2 Add-step menu — keeping 24 entries scannable

The old flat `DropdownMenu` (`automation-builder.tsx:1773-1791`) is a `max-h-80` scroll
of 15 identical rows. At 24 it stops working. Flows' grouped dropdown
(`flow-canvas.tsx:737-780`) works at 11 but would be ~700px tall at 24.

**Use `Popover` + a hand-rolled two-pane picker.** (No `command.tsx` in this repo; a
search-filtered list is ~40 lines.)

```
┌─ 380 × 420 ────────────────────────────────┐
│ 🔍 Search steps…                            │  40px, autofocus
├───────────┬─────────────────────────────────┤
│ Recent    │  ▣  Send message                │
│ ─────     │     Sends a WhatsApp text       │  44px rows
│ All       │  ▣  Send template               │
│ Messaging │     Sends an approved template  │
│ Contact   │  …                              │
│ CRM       │                                 │
│ Convers…  │                                 │
│ Logic     │                                 │
│ Data      │                                 │
│ Orchestr… │                                 │
└───────────┴─────────────────────────────────┘
   132px         scroll, 248px
```

| Element | Spec |
| --- | --- |
| Rail item | `px-2.5 py-1.5 text-[12px] rounded-md`; active `bg-muted text-foreground`; rest `text-muted-foreground`; a 6px dot in `stepColors(cat).line` on its left |
| List row | `gap-3 px-3 py-2 min-h-[44px]`; 28px chip / 16px glyph (`flow-canvas.tsx:760-765`); title `text-[13px] font-semibold text-popover-foreground`; blurb `text-[11.5px] text-muted-foreground` |
| Group header | shown only in `All` and in search results: `text-[10px] uppercase tracking-wider text-muted-foreground px-3 py-1.5 sticky top-0 bg-popover` |
| Search | filters across all categories, auto-switches the rail to `All`, highlights matches with `bg-primary-soft-2` |
| Recent | last 5 used, `localStorage["converse360.automationEditor.recentSteps"]`; hidden until there are ≥3 |
| Keyboard | type-to-search on open · `↑`/`↓` list · `←`/`→` rail ↔ list · `Enter` add · `Esc` close |
| Default view | `Recent` if populated, else `All` |

The rail costs 132px and removes the scroll from the decision: pick a *kind* (7 targets,
colour-coded, always visible), then a *thing* (2–7 targets). Search short-circuits both
for anyone who already knows the name.

**Where it opens from** — three entry points, one component:
1. The `+ Add step` `Panel` button at `top-left` of the canvas (`flow-canvas.tsx:567`).
2. A `+` hover affordance on the midpoint of any sequence edge — inserts *there*.
3. The dashed drop target at the end of any branch.

---

## 7. Accessibility

### 7.1 Focus rings

`--ring` follows the accent theme (`globals.css:214-282`). Measured against `--card`,
the amber accent's ring is **2.32:1 in light mode** — a fail. So the indicator is
**two-part**, and the compliant half is accent-independent:

```css
outline: 2px solid var(--ring);
outline-offset: 2px;
box-shadow: 0 0 0 4px color-mix(in oklch, var(--foreground) 70%, transparent);
```

The outer hairline measures **8.25:1 dark / 6.43:1 light** against `--card`, so the
composite indicator clears SC 1.4.11 under every accent. Apply to node cards, handles,
the resize rail, and anything the repo's `focus-visible:ring-primary` default covers
(e.g. `switch.tsx:19`) that sits on a canvas card.

`:focus-visible` only — never `:focus` — so a mouse click on a node does not paint a ring.

### 7.2 Keyboard on the canvas

| Key | Action |
| --- | --- |
| `Tab` | next node. **`rfNodes` must be sorted in execution order before being passed to `<ReactFlow>`** — DOM order is tab order, and dagre's output array is not execution order. Easy to miss, and the single biggest determinant of whether keyboard use is coherent. |
| `Enter` / `Space` | open the step in the sidebar |
| `Backspace` / `Delete` | delete the selected node — `deleteKeyCode={['Backspace','Delete']}`, matching `flow-canvas.tsx:535` |
| `Esc` | close the sidebar, return focus to the node that opened it |
| `↑` `↓` `←` `→` | pan the viewport 40px (React Flow default when the pane has focus) |
| `+` / `−` | zoom |

Set `nodesFocusable` and `edgesFocusable` (both default `true` in `@xyflow/react@12`).
Give each node an `aria-label` composed as
`` `${categoryLabel} step, ${title}, ${summary ?? 'not configured'}${disabled ? ', paused' : ''}` ``.

**Skip link.** A visually-hidden-until-focused link immediately before the canvas:
`Skip the canvas` → moves focus to the sidebar (or to the `+ Add step` button when the
sidebar is closed). Tabbing through 24 node cards to reach the panel is otherwise the
only route.

### 7.3 ARIA structure

| Element | Roles / attributes |
| --- | --- |
| Canvas wrapper | `role="application"` `aria-label="Automation canvas"` `aria-describedby="canvas-help"` |
| `#canvas-help` | `class="sr-only"` — *"Use Tab to move between steps, Enter to edit the focused step, Delete to remove it."* |
| Node card | `role="button"` `tabindex="0"` `aria-selected` `aria-controls="step-inspector"` `aria-expanded={isOpen}`; add `aria-invalid="true"` when the step is invalid |
| Sidebar (docked, ≥1024px) | `<aside id="step-inspector" role="complementary" aria-label="Step settings">` — **not** `role="dialog"`: it is not modal and must not trap focus |
| Sidebar (overlay, <1024px) | `sheet.tsx` supplies `role="dialog" aria-modal="true"` and focus trapping. The role genuinely changes with the breakpoint, because the behaviour does. |
| Panel heading | `<h2 tabindex="-1">`, focused on open; wrapped in `aria-live="polite"` so the step name is announced |
| Branch scope ribbon | `aria-hidden="true"` — purely decorative |
| Token popover | `role="dialog"`; list `role="listbox"`, rows `role="option"`, `aria-activedescendant` on the search input |
| Add-step popover | same pattern; the rail is `role="tablist"`, items `role="tab"`, list `role="tabpanel"` |

### 7.4 Contrast summary

Full per-hue table in §1.4. Floors:

| Requirement | Threshold | Worst measured | Where |
| --- | --- | --- | --- |
| Category label on card | 4.5:1 | **5.15:1** | logic, light |
| Title / body text | 4.5:1 | 15.32:1 (`--foreground`) | any |
| Secondary text | 4.5:1 | 5.79:1 (`--muted-foreground`) | any |
| Strokes, ports, glyphs | 3:1 | **3.49:1** | logic glyph on chip, light |
| Edges on stage | 3:1 | **3.63:1** | logic split edge, light |
| Selected-state border | 3:1 | **3.63:1** | logic, light |
| Focus indicator | 3:1 | **6.43:1** (outer hairline) | light |
| Status badges on their surfaces | 4.5:1 | **4.95:1** | success, light |

### 7.5 Non-colour redundancy

| Meaning | Colour | Second channel |
| --- | --- | --- |
| Yes branch | `--success` | the word `YES` in the branch footer + the edge label |
| No branch | `--destructive` | the word `NO` + the edge label |
| Continue / rejoin | muted | **dashed** stroke, a different card edge, the standing label `continues after` |
| Disabled | desaturated | `PAUSED` badge + dashed border + the panel's Switch |
| Invalid | `--destructive` | `CircleAlert` glyph + badge text + `aria-invalid` |
| Category | hue | the uppercase category word + a distinct icon per type |

### 7.6 Motion, targets, density

- `prefers-reduced-motion: reduce` → `setCenter` duration `0` (flows uses `400`,
  `flow-canvas.tsx:412`), no panel width transition, no card `transition`, no popover
  zoom/slide (override `tw-animate-css` classes in `popover.tsx:40`).
- Interactive targets ≥24×24px (SC 2.5.8): handles get the `::after` inset expansion
  (§3.1); the close `X`, `Copy` and KV delete buttons are 28px; the token button is 20px
  visual with `::after { inset: -4px }`.
- The card is legible down to `zoom 0.6`. Below that, React Flow's `minZoom={0.2}`
  (`flow-canvas.tsx:542`) still applies — specify that rows 3 and 4 are hidden under
  `zoom < 0.5` via a `useStore(s => s.transform[2])` class toggle rather than being
  rendered as unreadable 5px text.

---

## 8. Build order

| # | Deliverable | New file |
| --- | --- | --- |
| 1 | `CATEGORY_HUE`, `stepColors()`, `STEP_META`, `groupStepTypesByCategory()`, `StepIconChip`, `summarizeStep()` | `components/automations/canvas/shared.tsx` |
| 2 | `StepNodeCard`, `TriggerNodeCard`, `BranchScopeNode` | `components/automations/canvas/nodes/` |
| 3 | Canvas shell — chrome copied from `flows/flow-canvas.tsx:546-566`, TB auto-layout, execution-order node sort | `components/automations/canvas/automation-canvas.tsx` |
| 4 | Docked inspector + resize rail + breakpoint degradation | `components/automations/canvas/inspector/` |
| 5 | `TokenField`, `TokenPickerPopover`, `TokenPreview` | `components/automations/canvas/tokens/` |
| 6 | Two-pane add-step picker | `components/automations/canvas/add-step-picker.tsx` |
| 7 | Back-port `line` (§1.3) into `flows/shared.tsx` `nodeColors()` and swap the four `c.solid` stroke uses in `flow-canvas.tsx` | — |

**Design QA gate.** Ship blocked until: every category label measures ≥4.5:1 and every
stroke ≥3:1 in *both* modes at the app's five accents; `Tab` reaches every node in
execution order; the sidebar degrades to a sheet at 1023px; and the condition card's three
outputs are distinguishable in a greyscale screenshot.
