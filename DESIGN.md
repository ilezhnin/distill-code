---
name: Flock
description: A desktop agent workspace documented from the actual Flock design-system tokens.
colors:
  bg-primary: "#0f2230"
  text-primary-foreground: "#ffffff"
  bg-background: "#ffffff"
  text-foreground: "#0f2230"
  bg-canvas-base: "#eef7fd"
  bg-card: "#ffffff"
  bg-sidebar-accent: "#e5f1f9"
  bg-muted: "#e5f1f9"
  bg-surface-chat-composer: "color-mix(in srgb, #ffffff 90%, transparent)"
  text-muted-foreground: "#5f7482"
  text-placeholder: "#8097a5"
  border-border: "#dceaf3"
  border-input: "#bfd6e4"
  border-foreground: "#0f2230"
  bg-destructive: "#dc2626"
  bg-destructive-10: "color-mix(in oklab, #dc2626 10%, transparent)"
  text-destructive: "#dc2626"
  text-destructive-foreground: "#ffffff"
  text-success: "#16a34a"
  text-info: "#0b6fa8"
  text-warning: "#ca8a04"
  flock-lead: "#d63a0c"
typography:
  display:
    fontFamily: "font-display"
    fontSize: "text-6xl"
    fontWeight: "font-normal"
    lineHeight: "leading-none"
    letterSpacing: "tracking-tight"
  headline:
    fontFamily: "font-display"
    fontSize: "text-2xl"
    fontWeight: "font-normal"
    lineHeight: "leading-tight"
    letterSpacing: "tracking-tight"
  title:
    fontFamily: "font-display"
    fontSize: "text-lg"
    fontWeight: "font-semibold"
    lineHeight: "leading-none"
    letterSpacing: "tracking-tight"
  body:
    fontFamily: "font-sans"
    fontSize: "text-sm"
    fontWeight: "font-normal"
    lineHeight: "leading-relaxed"
  label:
    fontFamily: "font-sans"
    fontSize: "text-xs"
    fontWeight: "font-medium"
    lineHeight: "leading-none"
    letterSpacing: "tracking-wide"
rounded:
  rounded-xs: "8px"
  rounded-sm: "10px"
  rounded-md: "14px"
  rounded-lg: "20px"
  rounded-full: "999px"
  rounded-composer: "20px"
spacing:
  h-7: "1.75rem"
  h-8: "2rem"
  h-9: "2.25rem"
  h-10: "2.5rem"
  h-input: "3.25rem"
  h-input-sm: "2.75rem"
  h-button: "2.75rem"
  h-button-sm: "2rem"
  max-w-3xl: "48rem"
  max-w-5xl: "64rem"
  app-page-gutter: "1.5rem; 3rem from 64rem; 4.5rem from 80rem"
  px-6: "1.5rem"
  py-8: "2rem"
components:
  button-primary:
    backgroundColor: "{colors.bg-primary}"
    textColor: "{colors.text-primary-foreground}"
    rounded: "{rounded.rounded-xs}"
    height: "{spacing.h-9}"
    padding: "0 1rem"
  button-ghost-icon:
    backgroundColor: "transparent"
    textColor: "{colors.text-muted-foreground}"
    rounded: "{rounded.rounded-xs}"
    height: "{spacing.h-8}"
    width: "{spacing.h-8}"
  input-default:
    backgroundColor: "transparent"
    textColor: "{colors.text-foreground}"
    rounded: "{rounded.rounded-sm}"
    height: "2.25rem"
    padding: "0 0.75rem"
  chat-composer:
    backgroundColor: "{colors.bg-surface-chat-composer}"
    textColor: "{colors.text-foreground}"
    rounded: "{rounded.rounded-composer}"
    padding: "1rem"
  card-default:
    backgroundColor: "{colors.bg-card}"
    textColor: "{colors.text-foreground}"
    rounded: "{rounded.rounded-md}"
    padding: "1.5rem"
  nav-item-active:
    backgroundColor: "{colors.bg-sidebar-accent}"
    textColor: "{colors.text-foreground}"
    rounded: "{rounded.rounded-sm}"
    padding: "0.375rem 0.75rem"
  badge-secondary:
    backgroundColor: "{colors.bg-muted}"
    textColor: "{colors.text-foreground}"
    rounded: "{rounded.rounded-full}"
    padding: "0.125rem 0.5rem"
---

# Design System: Flock

## 1. Overview

**Creative North Star: "The Grounded Workbench"**

This file documents the actual Flock design-system source in [globals.css](src/shared/styles/globals.css), especially the `:root` semantic tokens and the Tailwind `@theme inline` aliases. The frontmatter lists the Tailwind-facing tokens agents should use in component code, such as `text-foreground`, `bg-card`, `border-border`, and `text-muted-foreground`. The prose explains the lower-level CSS variable chain behind them.

The current implementation provides useful product bones: semantic color tokens, shared UI primitives, a persistent sidebar, compact top bar, and a strong chat composer pattern. This document is not a blanket endorsement of every current surface.

**One product with its page.** Flock shares its visual language with [levocat.com/flock](https://www.levocat.com/flock/): the sky-and-ink palette, Geologica and JetBrains Mono, 8px controls and 14px cards drawn with hairlines instead of shadows, pills for chips and statuses, and the flock itself — five birds, the lead one red — as the sign of work in flight. When the page and the app disagree, fix the token here rather than a component. The site has no dark theme of its own design beyond a palette; the app's dark theme is that palette (ink page, deep-navy cards, the same red lead a step brighter) worked out for a product.

The product should reject the PRODUCT.md anti-references directly: not a generic chatbot wrapper, not a dark terminal skin, not a dashboard stuffed with metrics, not a marketing site wearing product chrome, not novelty-first AI visuals, not oversized decorative cards, not vague "assistant magic" copy, and not a pile of disconnected settings pages.

**Key Characteristics:**

- Use Tailwind-facing design tokens in component code, then trace back to CSS variables only when changing the system itself.
- Keep product chrome quiet, dense, and legible.
- Treat the chat composer, sidebar, settings, projects, skills, extensions, agents, and onboarding as the canonical surfaces.
- Improve `src/shared/styles/globals.css` and `src/shared/ui/` when the design system needs to evolve.

## 2. Colors

The source palette is a semantic token system backed by the site's sky-and-ink neutrals and a small state-color set. The neutral primitives keep the names `gray-*`, but none is a true gray: the light half is tinted toward the site's sky band (`#eef7fd`), the dark half toward its ink (`#0f2230`). In React code, use the Tailwind-facing utility names. In `globals.css`, those utilities map through public aliases to lower-level semantic variables.

The page is the sky band (`--canvas-base`); cards and panels are white paper on it, separated by a hairline (`--border`, the site's `line`) rather than a shadow. Controls that can be pressed or typed into take the stronger hairline (`--input`, the site's `line-strong`).

### Primary

- **`--primary`**: Primary action, selected context, and accent source. In light mode it resolves to `--color-gray-900` (ink); in dark mode it resolves to `--color-gray-25` (the site's dark-theme ink, a sky-tinted white).
- **`--primary-foreground`**: Foreground color on `--primary`.
- **`--foreground`**: Public foreground alias used by Tailwind class `text-foreground`; it resolves to `--foreground`.
- **`--accent`, `--accent-foreground`**: Hover and low-emphasis interactive fill tokens.

### Secondary

- **`--background`**: Paper paint for controls and blend-with-card fills; an alias of `--card` in both themes. Not a container surface and not the window backdrop — containers use `--card`/`--card-glass`, and the backdrop is `--canvas-base`.
- **`--card`**: Card and panel surface.
- **`--muted`**: Muted surface for badges, tabs, queued rows, and low-emphasis controls.
- **`--secondary`**: Stronger neutral fill used sparingly.
- **`--popover-inverse`**: Inverse menu surface for narrow cases, not a license to make the product feel like a terminal.

### Tertiary

- **`--destructive`, `--destructive-foreground`**: Danger, failure boundaries, and filled destructive action states.
- **`--success / 10%`, `--success`, `--success`**: Success and ready states.
- **`--info / 10%`, `--info`, `--info`**: Informational state and system feedback. The site's link blue.
- **`--flock-lead`**: The lead bird's red. It marks the head of the flock and work in flight: the lead bird of the loader, the breathing dot of a running agent, the elapsed time of a working turn, the bird beside a thought in progress. Raw CSS only (see the Raw-CSS Token Rule): it is drawn by a few shared components and is not a utility color for feature code.
- **`--warning / 10%`, `--warning`, `--warning`**: Warning state.

### Neutral

- **`--border`, `--border / 80%`**: General structure, dividers, and low-emphasis separation.
- **`--input`**: Form and control boundaries.
- **`--foreground`, `--card-foreground`, `--popover-foreground`, `--primary-foreground`, `--secondary-foreground`, `--muted-foreground`, `--text-placeholder`**: Lower-level semantic text values.
- **`--sidebar-accent`, `--sidebar-accent-foreground`**: Left navigation row states. Hover and selected change only the fill; text and icons keep the same foreground.
- **`--foreground`, `--muted-foreground`, `--card-foreground`, `--popover-foreground`, `--primary-foreground`, `--secondary-foreground`**: Source text inputs that semantic text tokens consume.
- **`--ring`**: Focus border/ring color. Keep it a quiet neutral gray so focus is visible without becoming a black outline.

### Named Rules

**The Token Contract Rule.** Use the existing CSS variables and Tailwind aliases. In feature code, prefer classes like `text-foreground`, `text-muted-foreground`, `bg-card`, and `border-border`; in token work, understand that these map back to variables such as `--foreground`, `--muted-foreground`, `--card`, and `--border`, which in turn resolve to semantic values like `--foreground`.

**The Theme Provider Rule.** `ThemeProvider` may apply light/dark mode, density, and the explicit primary color override. It should not generate or overwrite the full shadcn token palette at runtime.

**The Raw-CSS Token Rule.** Some surfaces cannot be styled with a utility class on an element: pseudo-elements (`::selection`, `::-webkit-scrollbar-thumb`), the CSS Custom Highlight API, filters, and opacities. These keep a `:root`/dark semantic token (with both light and dark values) and are consumed with `var(...)` directly in `globals.css`. Do not bridge them into `@theme inline`, because no utility class could use the generated color. See [Tokens Consumed In Raw CSS](docs/color-token-mapping.md#tokens-consumed-in-raw-css).

**The State Color Rule.** Red, green, blue, and yellow are for state, not decoration. If a color does not communicate status or selected context, remove it.

**The Lead Bird Rule.** The site keeps its red for the leading bird only. In the app that red means one thing: this is in flight right now. Do not use it for emphasis, links, selection, or failure — failure is `destructive`.

**The Neutral Rule.** The neutrals are tinted, and a true gray reads as a foreign object beside them. New surfaces should not introduce raw gray, white, or black outside the token layer; shadows are cast in ink (`rgba(15, 34, 48, …)`), never in gray or black.

## 3. Typography

**Display Font:** `font-display`.
**Body Font:** `font-sans`.
**Label/Mono Font:** `font-sans` for labels, `font-mono` for code, paths, terminal output, and identifiers.

The app font is **Geologica**, the typeface of levocat.com, self-hosted as one variable font (weight and slant axes) in `src/app/assets/fonts/` under the SIL Open Font License 1.1. `globals.css` maps `--font-sans` and `--font-display` to `"Geologica"` with a system-font fallback stack; italic is the font's own slant axis, so there is no separate italic file. Geologica is drawn wide for reading, so the body carries one global tracking trim; do not add letter-spacing compensation in component code. The mono font is **JetBrains Mono** (upright and italic), self-hosted the same way and mapped through `--font-mono`. Cash Sans is not used or bundled anywhere — it is proprietary and must not be added to this externally distributed product.

Light text on a dark ground looks heavier than the same weight in ink on paper. The dark theme therefore draws `font-normal` and `font-medium` a little lighter (`--font-weight-normal`, `--font-weight-medium`); component code keeps using the weight utilities and gets the correction for free.

### Hierarchy

- **Display** (`font-display text-6xl font-normal tracking-tight`): Home clock and rare first-run moments. Avoid display scale in settings, sidebars, lists, cards, or dense product panels.
- **Headline** (`font-display text-2xl font-normal tracking-tight`): Page and onboarding titles.
- **Title** (`font-display text-lg font-semibold tracking-tight`): Section headers and ordinary product page titles.
- **Body** (`font-sans text-sm font-normal leading-relaxed`): Default UI copy, descriptions, menus, and form help. Keep prose lines around 65 to 75 characters.
- **Label** (`font-sans text-xs font-medium tracking-wide`): Compact metadata, badges, uppercase group labels, and secondary controls.
- **Mono** (`font-mono`): Code, file paths, terminal output, stack traces, and technical identifiers — and, as on the site, the small technical labels around the work: badges and tags, a step's class and model, counts and timings, the line that says what a turn is doing. Never running prose.

### Named Rules

**The Source Font Rule.** Component code should use `font-sans`, `font-display`, and `font-mono`. If a new typeface is required, install and map it in `globals.css` instead of hardcoding it in feature code.

**The Calm Scale Rule.** Product hierarchy should be tight. If text needs more importance, try placement, grouping, or weight before jumping to hero-scale type.

## 4. Elevation

Flock uses semantic shadow tokens plus borders and tonal layering. The site is flat, and so is the app at rest: a hairline separates a card from the page. Shadows appear on hover, popovers, dialogs, and overlays where depth clarifies stacking; they are cast in ink and kept light.

### Shadow Vocabulary

- **`--shadow-mini`** (`0 2px 8px rgba(15, 34, 48, 0.08)`): Small control affordance, badges, and lightweight raised feedback.
- **`--shadow-mini-inset`** (`0 1px 4px rgba(15, 34, 48, 0.08) inset`): Subtle inset treatment.
- **`--shadow-btn`** (`0 2px 8px rgba(15, 34, 48, 0.08)`): Button elevation when a variant explicitly needs it.
- **`--shadow-card`** (`0 2px 8px rgba(15, 34, 48, 0.08)`): Hover elevation for interactive cards.
- **`--shadow-elevated`** (`0 3px 12px rgba(15, 34, 48, 0.12)`): Raised surfaces that need more separation than a card.
- **`--shadow-popover`** (a 1px ink hairline plus `0 6px 18px rgba(15, 34, 48, 0.08)`): Menus, dropdowns, command-like overlays, and transient panels.
- **`--shadow-modal`** (`0 20px 60px rgba(15, 34, 48, 0.2)`): Dialogs that block or redirect the current task.
- **`--shadow-kbd`** and **`--shadow-date-field-focus`**: Specialized component shadows.

### Named Rules

**The Flat First Rule.** Surfaces are flat unless the user is interacting with them or z-order would otherwise be unclear.

**The No Glass Rule.** Blur and translucent glass are not default elevation. Chrome that floats over the canvas — the top bar, the navigation panes, the right rail, and the global composer pill — uses the `card-glass` surface paired with the `--backdrop-panel` blur so the dot grid reads through it. Contained product panels and cards stay on solid tokenized surfaces (see `docs/color-token-mapping.md`).

## 5. Shape

Corner radii use a 5-step scale built on Tailwind's standard utility names: `rounded-xs`, `rounded-sm`, `rounded-md`, `rounded-lg`, and `rounded-full`. The values are the site's shapes: 8px controls, 14px cards, and pills for chips.

| Token | Value | Tailwind class |
| --- | --- | --- |
| `--radius-xs` | 8px | `rounded-xs` |
| `--radius-sm` | 10px | `rounded-sm` |
| `--radius-md` | 14px | `rounded-md` |
| `--radius-lg` | 20px | `rounded-lg` |
| (built-in) | 999px | `rounded-full` |

**The Nesting Rule.** When one rounded surface sits inside another, drop one step on the scale and use about 4px (`p-1`) of padding between them, so the inner corner stays close to concentric with the outer one. Cards inside modals nest as `md → sm`; sub-cards inside cards nest as `sm → xs`.

**Composer Exception.** `rounded-composer` (20px) is a deliberate one-off for the chat composer surface. Do not reuse it elsewhere; the composer is the app's signature component and earns its own token.

**Picking a Token.**

- `rounded-full` — chips, badges, status pills, avatars, dots, switches: things that label or mark, not things that are pressed to act.
- `rounded-lg` (20px) — the largest scale container; outer cards or panels that dominate a region.
- `rounded-md` (14px) — default for cards, modals, dropdowns, popovers, tiles, and most non-pill surfaces.
- `rounded-sm` (10px) — surfaces nested inside `md` containers: fields, menu rows, small cards, sidebar nav items, message bubbles.
- `rounded-xs` (8px) — buttons, and surfaces nested inside `sm` containers.

**Authoring rule.** Always use Tailwind's standard radius utility names. Do not invent new class names like `rounded-m` or `rounded-pill`; override values in `@theme inline` instead.

## 5a. Page Layout

**The Page Gutter Rule.** Every top-level page keeps its content the same distance from the sidebar and from the window's right edge: the page gutter, `--app-page-gutter`. It steps on the 24px dot grid — 24px in a narrow window, 48px from a 1024px window, 72px from 1280px — and is the same on every page at a given window size.

- `PageShell` applies it. A page that builds its own frame uses `PAGE_SCROLL_CLASS` with `PAGE_GUTTER_CLASS` and `PAGE_TOP_CLASS` from `src/shared/ui/page-shell.tsx`; the scroller always reserves its scrollbar track, and the trailing padding gives that width back, so both gutters read the same.
- Content between the gutters uses the available width. A page does not center itself in a fixed `max-w-*` column; a reading width (`PageShell` `contentWidth`, a text column) caps the column but starts at the gutter, never re-centered. Card grids keep fixed card sizes and put spare width between the columns (`justify-between`), so the outer columns stay on the gutters.
- A page's first row starts on the gutter, and so does a back button's box: an icon-only one (`size="icon-sm"`, the agent profile and editor) starts on the line, with no negative margin hanging into the gutter.
- A detail page opened from a section the sidebar names (the benchmark model page) has no back row and no copy of the section's page actions: the sidebar item and the top bar's back arrow lead back, and the actions belong to the section.
- Settings and the full-page agent editor are panel cards: the card sits in the 12px panel gutter like the chat panel, and its content uses `PANEL_PAGE_GUTTER_CLASS`, which puts it on the page gutter line. Settings rows have no inline padding of their own, so labels start and controls end on the gutters.
- A rail beside the content (the chat history date scrubber) is a column of the page: its right edge sits on the right gutter like any page's last box, and the list beside it ends short of the rail and its labels, so a label never lies over content.
- Home stays a centered invitation; the page gutter is its minimum side inset. The chat transcript keeps its own reading column.

## 6. Components

### Buttons

Use [Button](src/shared/ui/button.tsx) and its variants before adding feature-level styling.

- **Shape:** `rounded-xs` (8px) for all buttons — text and icon-only alike, as on the site. The base `Button` applies this automatically; feature code should not override the radius.
- **Primary:** `bg-primary text-primary-foreground`, mapping through semantic primary surface and readable-on-primary text tokens: ink on a light page, the site's `btn-dark`.
- **Outline:** paper with the stronger hairline (`border-input`), the site's `btn-line`.
- **Sizing:** Use the `Button` `size` prop. Current variants map to `h-7`, `h-8`, `h-9`, and `h-10`.
- **Ghost icon buttons:** No hover fill for `variant="ghost"` plus icon sizes; they shift from muted text to foreground text.
- **Rule:** Add variants to `Button` when a reusable button treatment is missing.

### Chips

Use [Badge](src/shared/ui/badge.tsx), composer chips, or a shared variant.

- **Shape:** `rounded-full`. Badges and status chips deliberately differ from buttons in shape because they differ in semantic purpose — buttons are interactive controls and use the 8px corner to read as "press me"; badges are labels conveying state and use the pill so they read as "tag" rather than "control." This affordance separation reduces the chance of users attempting to click a static status indicator.
- **Type:** `font-mono` at 11px, as the site sets its tags and pills.
- **Color:** `bg-muted`, `text-foreground`, `text-muted`, and state tokens when the chip communicates state. A chip that can be opened (an agent under a message) is paper with the stronger hairline, and takes the ink on hover.
- **Status dots:** a run in flight is a dot in the lead bird's red that breathes (`ActiveChatPulseDot`); a step not started is a hollow dot; finished states keep their state color.
- **State:** Removable context chips should stay compact and should not compete with the composer text field.

### Cards / Containers

Use [Card](src/shared/ui/card.tsx) only when a meaningful object boundary exists.

- **Shape:** `rounded-md` (14px) on the base `Card` primitive, matching the sidenav panel. Use `rounded-lg` (20px) for the largest framing cards and `rounded-sm` (10px) for sub-cards nested inside another card.
- **Color:** `bg-card text-card-foreground`, mapping through `--card` and `--card-foreground` to semantic card surface and text tokens.
- **Border:** `border-border`, mapping to `--border`.
- **Shadow:** `hover:shadow-card` only when the card is interactive.
- **Rule:** Do not use cards as the default page layout, and never nest cards.

### Inputs / Fields

Use [Input](src/shared/ui/input.tsx), shared textareas, or shared selector components.

- **Shape:** `rounded-input` for default inputs.
- **Color:** `border-input`, `hover:border-foreground/20`, `text-foreground`, and `placeholder:text-placeholder`.
- **Focus:** `focus-visible:border-ring` and `focus-visible:ring-ring`, using semantic focus tokens.
- **Error / Disabled:** `aria-invalid:border-destructive`; disabled controls reduce opacity and preserve layout.

### Navigation

Use the shared sidebar and nav item patterns as the baseline.

- **Sidebar items:** `bg-sidebar-nav-bg-hover` for hover/focus, `bg-sidebar-nav-bg-selected` for active/menu-open, stable nav foreground text, compact padding, `rounded-md`, and regular-weight labels via `--sidebar-nav-font-weight` / `SIDEBAR_NAV_TEXT_CLASS` (`text-sm font-normal`).
- **Top bar:** compact icon-only actions using `Button` ghost icon variants.
- **State:** Active state should be visible without relying on color alone.
- **Behavior:** Collapsed labels may fade and width-collapse, but navigation must remain keyboard and screen-reader legible.

### Chat Composer

The composer is the signature component and should receive the most craft.

- **Surface:** `bg-surface-chat-composer` — paper, a touch translucent for the `--backdrop-composer-glass` blur — outlined with the stronger hairline (`ring-input`, darkening to `ring-ring` while focus is inside), and `rounded-composer`, in the current implementation.
- **Layout:** Max width `max-w-3xl`, centered, with internal structure for attachments, selected persona/skills, text entry, toolbar controls, voice, send, stop, and context usage.
- **Behavior:** File drop state uses tokenized muted surfaces and dashed border. Queued messages stay inline above the text area.
- **Rule:** The composer should show active agent, model, project, skills, attachments, voice state, send state, and context usage without feeling like a control panel.

### Overlays

Use Radix-backed shared primitives for dialogs, sheets, drawers, dropdowns, popovers, and tooltips.

- **Shape:** `rounded-overlay` for popovers and dropdowns, `rounded-modal` for dialogs.
- **Color:** `bg-popover text-popover-foreground`.
- **Motion:** Use existing open/close animations and durations (`--duration-fast`, `--duration-normal`, `--duration-slow`).
- **Modal Use:** Dialogs are for blocking decisions, destructive confirmation, or workflows that cannot remain inline.

## 6a. Work In Flight

Loading and thinking are shown with the flock, in the spirit of the site's hero: birds that move together, one of them leading.

- **Flock mark** ([FlockLoader](src/shared/ui/flock-loader.tsx), `FlockLoaderInline`): five birds, the lead one in `--flock-lead`, the rest in the text color of their surface. In flight each bird surges along the flock's heading and falls back, starting a beat after the bird ahead, so the motion runs from the lead to the tail. On the startup screen the birds fly in one after another first. Standing still it is the logo.
- **Working line** ([LoadingFlock](src/features/chat/ui/LoadingFlock.tsx)): what the turn is doing, in mono, with the elapsed time in the lead's red — the readout under the site's flock. The flock mark sits beside it.
- **Thought** ([Reasoning](src/shared/ui/ai-elements/reasoning.tsx)): one bird ([FlockDart](src/shared/ui/flock-dart.tsx)) beside the label; red and nudging forward while the thought streams, quiet once it is finished. The shimmer on the label sweeps in the text color — never in the paper's color, which erases the word as it passes.
- **Running dot** (`ActiveChatPulseDot`): the site's breathing dot, for a run that is live.
- **Spinner** ([Spinner](src/shared/ui/spinner.tsx)): one bird circling a faint ring, for a short wait inside a control.

All of it stands still under `prefers-reduced-motion`, and the sidebar's working indicators also follow the "Animate sidebar working indicators" setting.

## 7. Do's and Don'ts

### Do:

- **Do** use `src/shared/styles/globals.css` semantic tokens and `src/shared/ui/` primitives before writing feature-level visual classes.
- **Do** use existing authored token and utility names exactly: `text-foreground`, `text-muted-foreground`, `bg-background`, `border-border`, `font-sans`, `font-display`, `font-mono`, `rounded-card`, `rounded-input`, `rounded-full`, `shadow-card`, and the shared component props that wrap them.
- **Do** preserve context legibility: project, files, agent, model, provider, session state, and loading state should stay visible where they affect the user's next action.
- **Do** keep color restrained. Use semantic state color only when it communicates state.
- **Do** treat settings, providers, extensions, skills, agents, projects, and onboarding as first-class workflow surfaces.
- **Do** change the design system first when a new token, font, radius, component variant, or motion pattern is needed.

### Don't:

- **Don't** invent friendly alias tokens like "ink" or "paper" in docs, components, or feature code.
- **Don't** make Flock feel like a generic chatbot wrapper.
- **Don't** make it feel like a dark terminal skin.
- **Don't** create a dashboard stuffed with metrics.
- **Don't** create a marketing site wearing product chrome.
- **Don't** use novelty-first AI visuals, oversized decorative cards, or vague "assistant magic" copy.
- **Don't** let settings become a pile of disconnected pages.
- **Don't** introduce new raw `#ffffff` or `#000000` values outside the current token layer.
- **Don't** use side-stripe borders, gradient text, decorative glassmorphism, hero-metric templates, identical card grids, or modal-first UX.
