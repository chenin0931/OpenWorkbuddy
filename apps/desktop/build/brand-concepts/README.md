# Quiet Workbench brand concepts

These two raster concepts were generated with Codex built-in image generation on
2026-07-12 to explore the `OpenWorkbuddy` app-icon direction. They are design
references, not small UI glyphs.

## Concept prompts

### `quiet-workbench-light.png`

> Create a premium macOS productivity app icon for “OpenWorkbuddy”. Use an
> abstract folded work surface that clearly forms a W, with deep cobalt blue,
> graphite and warm ivory surfaces plus one small amber control node representing
> human approval. Quiet, precise, trustworthy and tactile; restrained depth and
> subtle material lighting. Centered 1:1 app-icon composition. No text, robot,
> chat bubble, sparkle, neon glow, purple gradient or generic AI imagery.

### `quiet-workbench-dark.png`

> Create a flatter alternate premium macOS app icon for “OpenWorkbuddy”. A
> folded ribbon/workbench surface forms a clear W on a graphite field, using
> ivory and deep cobalt planes with one warm amber control node. Mature,
> geometric, highly legible at Dock size, restrained depth, no text and no AI
> clichés such as robots, chat bubbles, sparkles, magic wands, neon or gradients.

## Finalization

The final shipping mark was redrawn as deterministic vector geometry in
`../icon.svg`, then rendered to `../icon.png` and the Chrome extension sizes. It
keeps the folded W and amber human-control node while avoiding generative detail
at small sizes. Functional 16–24 px interface icons remain in the Phosphor-based
`AppIcon` system and do not use these raster concepts.
