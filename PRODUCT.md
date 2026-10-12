# Product

## Purpose

Distill is a Windows desktop workspace for getting work done with AI agents.
Users connect their favorite providers, work directly with an agent or delegate
a larger task to a coordinated team, and keep the work in one place.

The product brings together projects, reusable roles and skills, memory, and
benchmarks. It helps users plan, execute, and review work, compare models and
workflows, and resume a project with its context intact.

## Users

Distill is for engineers, designers, and other builders who move between
planning and implementation. They need clear context, visible progress, and
results they can inspect and use.

Success means users can complete and resume work without reconstructing its
history or losing track of which agent is doing what.

## Core experience

- **Direct work and delegation.** Start a conversation or let a conductor divide
  work into steps, delegate to agents, and review the results.
- **Context that lasts.** Projects, history, editable memory, and project
  knowledge support continuity across sessions. Roles and skills are reusable;
  role images are optional.
- **Informed model choice.** Pin a model or use routing informed by benchmarks.
  Compare models and workflows on tasks using quality, execution time, and
  reported usage and cost.
- **A workspace users control.** Chats, settings, and project records live
  locally. Users choose the providers their agents work with.

## Personality

Calm, focused, and capable, with enough warmth to make daily use comfortable.
Use plain language and respect experienced users without making the product
cryptic for someone getting started.

Avoid decorative AI effects, oversized cards, vague promises, and screens
crowded with metrics or settings. Visuals should support the work.

## Design principles

- **Make context clear.** Show the active project, agent, model, and relevant
  workspace context where they affect the task.
- **Make collaboration visible.** Users should be able to follow delegated
  work, open an agent's conversation, and inspect its results.
- **Keep the work surface quiet.** Prioritize the conversation, active tools,
  and useful artifacts. Reveal configuration when it is relevant.
- **Show the actual state.** Distinguish progress, completion, failure, and
  unavailable capabilities. Give a clear next action when work cannot proceed.
- **Show evidence honestly.** Present measured results and their limits.
  Missing measurements are unknown; benchmark claims need supporting evidence.
- **Design for continuity.** Preserve context, drafts, history, and navigation
  so users can move between tasks and return without unnecessary setup.

## Accessibility

Use semantic controls, labels for icon-only actions, keyboard navigation,
visible focus, localized text, and reduced-motion support. Keep light and dark
themes readable, never rely on color alone to convey state, and make compact
layouts usable with assistive technology.

For onboarding, see [README.md](README.md). Development guidance lives in
[AGENTS.md](AGENTS.md); required product behavior is defined in
[LAWS/](LAWS/README.md).
