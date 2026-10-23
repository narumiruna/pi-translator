# Release procedure

## Record a change

1. Run `npm run changeset`.
2. Select `pi-translator`, choose the version increment, and enter a user-visible summary.
3. Commit the generated `.changeset/*.md` file with the code change.

Use stable three-part versions.
Chrome version components must be integers from 0 to 65535, and the version must not be `0.0.0`.
Prerelease versions are not supported.

## Publish a release

1. Merge changes with their changesets into `main`.
2. Review the **chore(release): version extension** pull request from `.github/workflows/release.yml`.
   - `npm run version` consumes changesets and updates `CHANGELOG.md`, `package.json`, `package-lock.json`, and `manifest.json`.
   - The package stays private and is not published to npm.
3. Merge the version pull request.
4. Check the **Release** workflow result and the GitHub Release.
   - The workflow runs `npm run check` and `npm run pack`.
   - It checks ZIP integrity and uploads `dist/pi-translator-<version>-chrome.zip` as a workflow artifact.
   - It pushes the Git tag `v<version>` for the checked-out commit.
   - It creates a GitHub Release for that tag with generated release notes and the ZIP attached.

The first changeset after this setup produces version `0.1.4`.
Existing version tags are not changed.
The workflow does not publish to the Chrome Web Store or produce a signed CRX.

## Repository permissions

A repository administrator must enable **Allow GitHub Actions to create and approve pull requests** in **Settings → Actions → General**.
The workflow requests `contents: write` and `pull-requests: write` for `GITHUB_TOKEN`.
Repository rules must permit this token to push release tags and create releases.

Pull requests created with `GITHUB_TOKEN` do not trigger other GitHub Actions workflows.
If branch rules require CI on the version pull request, an administrator must configure a GitHub App token for the Changesets step or arrange an approved CI run before merging.
The release workflow runs repository checks again before publication.

## Recovery

Use **Actions → Release → Run workflow** on `main` to retry a failed release.
A published GitHub Release is skipped.
An incomplete draft release is reused; its ZIP is replaced before the release is published.
If a tag exists without a published release, the workflow resumes only when the tag points to the checked-out commit.
Retry the failed run for that commit if `main` has advanced.
Never move or delete a published tag to retry a release.
Use a new changeset and version for a correction.

Remote tag creation, GitHub Release publication, and repository permissions require verification on GitHub after these files are merged.
