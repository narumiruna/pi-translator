# Changesets

Run `npm run changeset` for each user-visible change.
Select `pi-translator`, choose the version increment, and describe the change.
Commit the generated Markdown file with the change.
Use a patch for fixes, a minor version for compatible features, and a major version for breaking changes.

The release workflow opens a version pull request on `main`.
It consumes pending changesets, updates `CHANGELOG.md`, and synchronizes `package.json`, `package-lock.json`, and `manifest.json`.
Do not edit these version fields separately.

See [Release procedure](../docs/RELEASING.md) for packaging, tags, permissions, and recovery.
