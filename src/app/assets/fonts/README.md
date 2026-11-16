## Geologica

`Geologica[CRSV,SHRP,slnt,wght].ttf` is the variable font (weight 100–900,
slant, and the cursive and sharpness axes the app leaves at their defaults)
from the Google Fonts repository at
https://github.com/google/fonts/tree/main/ofl/geologica.

Geologica is the app's `font-sans` and `font-display` typeface, the same one
levocat.com is set in, so the app and its page read as one product. It is
self-hosted so the desktop app has no runtime font dependency and renders
identically offline. Italic text uses the font's slant axis; there is no
separate italic file.

Licensed under the SIL Open Font License 1.1 — see `GEOLOGICA_OFL.txt`.

## JetBrains Mono

`JetBrainsMono[wght].ttf` and `JetBrainsMono-Italic[wght].ttf` are the
variable fonts (weight axis 100–800) from the Google Fonts repository at
https://github.com/google/fonts/tree/main/ofl/jetbrainsmono.

JetBrains Mono backs the `--font-mono` token (code, paths, terminal output),
the digital clock face, and the small technical labels the site also sets in
mono: tags, statuses, counts and timings.

Licensed under the SIL Open Font License 1.1 — see `JETBRAINS_MONO_OFL.txt`.

## Nerd Fonts Symbols

`nerd-font-symbols.woff2` is the symbols-only Nerd Fonts webfont from
https://www.nerdfonts.com/assets/css/webfont.css, version 3.4.0.

It is used as a terminal-only fallback so shell prompts can render Nerd Font
icon glyphs without replacing the app's normal monospace font stack.

See `NERD_FONTS_LICENSE.md` for the upstream license text.
