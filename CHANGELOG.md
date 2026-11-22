# pi-translator

## 0.1.6

### Patch Changes

- 42d7f81: Align page translations with the original text column where the layout permits.
  Keep the saved maximum width and update the alignment when the window resizes.
- e1b8ad1: Skip clipped screen-reader-only headings in page translation so they do not create narrow visible notes.
- 63bc9fc: Fix page translation on sites such as Slop Manifesto by excluding hidden article copies from root selection.
  Keep `display: contents` roots and roots with CSS visibility overrides eligible when their readable descendants are visible.

## 0.1.5

### Patch Changes

- 3cab8f9: Translate native X Article titles and Draft.js body paragraphs that were skipped while semantic blocks translated.

## 0.1.4

### Patch Changes

- bf7305b: Add Changesets versioning and automated Chrome ZIP releases with versioned Git tags on GitHub.
