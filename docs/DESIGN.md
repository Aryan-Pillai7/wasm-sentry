# The visual system

This file is the design half of `CONTEXT.md`: the decisions the interface is
built on, written down so the next person changing a colour or adding a panel
does not have to re-derive them, and so the answer to "why does it look like
this?" is a document rather than an argument.

The rule it exists to enforce is simple. **Every visual decision in this
project is made here, once.** A component that invents its own spacing, its own
grey or its own animation curve is a bug, even when it looks fine on its own,
because the thing that makes an interface feel built rather than assembled is
that nothing in it is arbitrary.

---

## 1. What this thing is, and what it must therefore look like

Wasm-Sentry watches WebAssembly execute inside pages you did not write and
tells you, with evidence, whether it is doing something you would object to.
The whole value of the project is that the reader can check its work: every
verdict shows the measurements that produced it, and the docs are unusually
insistent about what the tool does *not* know.

An interface for that has one job before any other: **look like an instrument,
not like an opinion.** A tool that reports a number it cannot justify is the
failure mode this project was written against, so the interface must never
borrow the visual language of products that ask to be trusted. It has to look
like something that measures.

That is the whole brief. It decides everything below.

### The chosen direction: instrument panel

Dense, monospaced, squared-off, quiet. The lineage is test equipment and
telemetry consoles — oscilloscope faceplates, aircraft instrument panels,
network analysers — filtered through Swiss typographic discipline so it stays
legible rather than becoming a costume.

Concretely that means:

- **Data is monospaced.** Every number, hash, size, duration and ratio is set
  in the mono stack with tabular figures. Digits line up in a column; a value
  that changes does not reflow the row it sits in.
- **Labels are small, uppercase, and tracked open.** They are legends on a
  panel, not headings in a document, and they read as legends because they are
  set like them.
- **Prose is a normal sans at a normal size.** Findings are meant to be read by
  a person deciding what to do. Setting them in mono to match the numbers would
  be a costume, and would cost real reading speed.
- **Corners are barely rounded.** 3px on a chip, 5px on a panel. Large radii
  read as consumer software; square corners read as a terminal emulator. The
  interesting place is between them.
- **Surfaces are separated by line and tone, not by shadow.** Shadows exist,
  but at the strength of a printed rule, not a floating card.
- **Texture is functional.** The faint horizontal ruling behind both surfaces
  is a chart-paper cue and the only ornament in the system. It also does real
  work: it gives the eye a horizontal rhythm to track values along.

### What is banned, and why

These are not matters of taste. Each one is a specific tell that would
undermine the brief above, and several are the recognisable defaults of
generated interfaces:

| Banned | Because |
| --- | --- |
| Violet/indigo→cyan gradients | The single most recognisable "AI product" signature. |
| Glassmorphism, backdrop blur | Decoration that costs legibility over dense data. |
| Gradient-filled numerals | A measurement must read as a measurement. |
| Bounce, elastic, spring overshoot | Instruments settle. They do not spring. |
| Emoji as iconography | Renders differently on every platform, and undercuts the register. |
| Cards nested inside cards | Border noise. Use tone and spacing to nest. |
| Inter, or any single trendy face | Named repeatedly as a generated-design tell. |
| A colour used once | Every colour in the system means something specific. |

### The typeface decision

There is no bundled webfont, and this is deliberate rather than an omission.

The strongest argument for bundling one — a distinctive face is the highest
-leverage tool in typography — is real. It loses to three things. The extension
ships to a browser where every byte is in the critical path of a popup that
must feel instant; a licence file and two binaries are a permanent maintenance
surface; and the native UI stacks on the platforms this actually runs on
(Segoe UI Variable, SF Pro, Cascadia Mono, SF Mono) are genuinely excellent and
carry no generated-design association at all.

So the character comes from the *type system* — the scale, the tracking, the
mono/sans split, the tabular figures — rather than from a purchased voice. This
is the harder way to do it and the more durable one.

If a bundled face is ever wanted, `--font-sans` and `--font-mono` in
`theme.css` are the only two places to change. IBM Plex Sans and IBM Plex Mono
are the recommended pairing: openly licensed, designed for exactly this kind of
technical density, and drawn as a matched family.

---

## 2. Tokens

Every token lives in `extension/src/ui/theme.css`, which both the popup and the
dashboard import before their own stylesheet. Before this file existed the two
surfaces each kept their own copy of the palette and had already drifted — the
same muted grey was `#8b93a1` in one and `#9aa1ab` in the other, and the same
role was called `--tag-bg` in one and `--tag` in the other. That is the failure
this layer prevents.

### Colour

Light is the default and dark is a full re-declaration rather than a filter,
because a security interface is read in both and neither may be the one that
merely works.

**Surfaces** — `--bg`, `--panel`, `--raised`, `--sunken`. Four steps, used in
that order as things come forward.

**Ink** — `--fg`, `--muted`, `--faint`. Primary text, secondary text, and text
that is present but not being offered for reading.

**Lines** — `--line`, `--line-strong`.

**Accent** — `--accent` alone. One accent, signal blue, and it means
*interactive or identifying* — never severity.

**Status** — `--good`, `--warn`, `--bad`, `--crit`. Severity only. A green here
never means "on", it means "nothing found".

**Detection layers** — `--k-static`, `--k-runtime`, `--k-model`. Blue, teal,
amber. These pre-date this file and are kept exactly as they were: a reader
learns the mapping once and it must never move under them. Deliberately not
violet, which would read as branding rather than as a signal.

### Type

Two stacks, `--font-sans` and `--font-mono`, and an eight-step scale from
`--t-micro` (10px, uppercase legends) to `--t-display` (30px, the one number on
a screen that is meant to be read from across a room). Anything not on the
scale is wrong.

Two tracking tokens: `--track-caps` for uppercase legends, `--track-tight` for
display numerals.

### Space, radius, elevation

Space is a 4px grid, `--s-1` through `--s-10`. Radius is `--r-1` (3px, chips),
`--r-2` (5px, panels), `--r-full`. Elevation is three steps and all three are
deliberately weak.

### Motion

Four durations and two curves, and nothing else:

| Token | Value | For |
| --- | --- | --- |
| `--dur-1` | 120ms | Hover, focus, colour changes. |
| `--dur-2` | 220ms | A single element entering. |
| `--dur-3` | 380ms | A group entering, staggered. |
| `--dur-4` | 900ms | A value filling — gauges, bars, count-ups. |
| `--ease-out` | `cubic-bezier(.16,1,.3,1)` | Anything entering or settling. |
| `--ease-io` | `cubic-bezier(.65,0,.35,1)` | A state change on something already present. |

`--ease-out` is decisive and overshoots nothing: it covers most of its distance
immediately and then eases to a stop, which is what a needle does.

**The motion brief.** Animation here is not decoration and never signals
liveliness for its own sake. It does exactly three jobs:

1. **Show that a number was measured.** Gauges fill, bars grow and figures
   count up from zero, over `--dur-4`. A score that snaps into place looks
   asserted; a score that fills looks read off an instrument.
2. **Show what arrived.** New content rises 4px and fades in over `--dur-2`,
   staggered by 45ms when it arrives as a group, so the eye can follow the
   order rather than being handed a finished screen.
3. **Confirm a response.** Hovers and focus rings resolve in `--dur-1`.

The live pulse in each masthead is the one exception: a continuous 2.4s ping,
justified because "is this thing actually running?" is a real question about a
background extension and the honest answer is a heartbeat.

Nothing else moves. There are no parallax effects, no scroll-triggered
reveals, no decorative loops.

### Reduced motion

`prefers-reduced-motion: reduce` is honoured properly, not by globally
zeroing durations and hoping. Entrances resolve immediately at their final
state, the pulse stops, and — the part a blanket rule gets wrong — every
count-up and gauge **jumps straight to its true value** rather than freezing at
zero. `useCountUp` and the gauge check the query themselves for this reason.

---

## 3. The surfaces

### Popup — 380px, a verdict

Opened deliberately, read in a few seconds, closed. It answers one question:
*is this page doing something I should care about?* So it leads with the
scorecard, and the scorecard leads with the ring.

The ring is an SVG arc rather than a `conic-gradient`, which is what it was
before. The gradient could not have a rounded cap, could not draw a track
behind the unfilled portion, and animated only through a registered custom
property. The arc gets all three, and animates on `stroke-dashoffset`, which
compositors handle well.

Below it: the plain-language headline, then the findings that produced the
score. The score never appears without them.

### Dashboard — the room-scale view

Long, scrolled, and used both for settings and for demonstrating the thing.
Four additions carry that second job:

- **A masthead** stating what the extension is doing right now.
- **Four hero figures** — watched, flagged, highest score, uptime — set at
  `--t-display` and counting up. This is the top line a presenter needs.
- **An activity sparkline** over the last five minutes, drawn from the real
  event feed. It animates by drawing its own path, which is the one moment of
  visible craft the page allows itself, and it is showing real data while it
  does it.
- **Sticky section navigation** with scroll-spy, so a long page can be jumped
  around during a demo instead of scrolled through.

### Testbed — the page on the projector

`testbed/index.html` is what is actually on screen during a demo, so it is part
of the interface and is styled as such. It shares the palette and the type
system without importing anything: it is a plain static page with no build
step, deliberately, so it can be opened from disk. Duplicating a handful of
custom properties is the price of that and is worth paying.

---

## 4. Accessibility

Non-negotiable, and cheap to keep:

- Body text meets WCAG AA against its surface in both themes; `--muted` was
  darkened in light mode specifically to clear 4.5:1.
- Every interactive element has a visible `:focus-visible` ring in `--accent`,
  offset so it is never confused with a border.
- Colour is never the only carrier. Severity has a label, layers have a text
  badge beside the dot, sparkline values have a readable summary.
- The section nav is a real `<nav>` of anchors and works without JavaScript.
- `prefers-reduced-motion` as described above.
- Live regions are not used: the polling updates are ambient, and announcing
  every one of them would be hostile.

---

## 5. Changing this

Add a token before adding a rule. If a component needs a value that is not in
`theme.css`, either it belongs in `theme.css` for everyone, or the component is
doing something the system has not agreed to — and that is worth a minute's
thought before it becomes a fourth grey.
