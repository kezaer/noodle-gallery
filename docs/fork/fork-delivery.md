# Build a fork server candidate

Use `.github/workflows/fork-rc.yml` to verify and build `kezaer/noodle-gallery`. The workflow runs only by manual dispatch. It checks out the dispatched commit SHA for both jobs and builds `server/Dockerfile` for `linux/amd64`. The image includes the server, web client, CLI, and bundled plugins. The workflow does not build ML images or deploy services.

## Register the workflow

Put the workflow on the fork's default branch before dispatch. GitHub requires this for [manual workflow runs](https://docs.github.com/en/actions/how-tos/manage-workflow-runs/manually-run-a-workflow).

Inspect registration first.

```sh
gh api repos/kezaer/noodle-gallery/actions/permissions
gh workflow list --repo kezaer/noodle-gallery --all
```

If the registered fork workflow is disabled, enable that workflow alone.

```sh
gh workflow enable fork-rc.yml --repo kezaer/noodle-gallery
```

If the API lists no workflows despite files on the default branch and `enabled=true`, inspect the fork's [Actions page](https://github.com/kezaer/noodle-gallery/actions). At fork setup, this page displayed "Workflows aren't being run on this forked repository" and offered "I understand my workflows, go ahead and enable them". This is a separate fork activation gate. The button enables inherited workflows as a group. Review that broader effect before using it. Do not toggle repository permissions or enable all inherited workflows as a workaround. After resolving activation, recheck registration and enable only `fork-rc.yml`. GitHub documents [workflow activation](https://docs.github.com/en/actions/how-tos/manage-workflow-runs/disable-and-enable-workflows).

The inherited Gallery release workflows target `ghcr.io/open-noodle`. Keep them disabled on this fork. Use the fork workflow for this candidate.

## Verify and build without publishing

Dispatch the reviewed branch or tag. Replace `reviewed-branch` with its actual name.

```sh
gh workflow run fork-rc.yml --repo kezaer/noodle-gallery \
	--ref reviewed-branch -f version=v5.8.0-fork.rc.0 -f publish=false
gh run list --repo kezaer/noodle-gallery --workflow fork-rc.yml --limit 5
gh run watch RUN_ID --repo kezaer/noodle-gallery --exit-status
```

The verification job uses the repository's pinned Mise tools, including Node `24.21.0` and pnpm `11.27.1`. It runs server checks, the web checklist, TypeScript API regeneration, and the Gallery migration manifest check. Existing Mise tasks keep the SDK build ahead of workspace injection. The build job applies branding in its disposable checkout and builds the same source SHA. It overrides the repository and server image branding fields for this fork.

With `publish=false`, the image exists only on the GitHub runner. The metadata artifact records a successful local image build, but has no pull reference. A source tag, GitHub source archive, or metadata JSON is not an executable container artifact.

## Verify and build locally

Use a detached worktree to run the same checks and build without GitHub Actions activation. Commit and review the candidate first. The commands below build that commit and leave the main checkout untouched.

Install Docker with Buildx, Bash 5, Mise, jq, and ImageMagick. On macOS, also install GNU sed and GNU coreutils. The repository's [developer setup](../docs/developer/setup.md) describes its development dependencies.

Run this recipe from the local fork. It builds the same `linux/amd64` target as the workflow, so an ARM host needs Docker's AMD64 emulation. The optional `GITHUB_TOKEN` environment variable supplies the Dockerfile's public-tool download token through a BuildKit secret. No production secret is required.

```sh
bash <<'SH'
set -euo pipefail
cd /Users/kezaer/Git/noodle-gallery
candidate_sha=$(git rev-parse HEAD)
build_dir=$(mktemp -d "${TMPDIR:-/tmp}/noodle-fork-rc.XXXXXX")
git worktree add --detach "$build_dir/checkout" "$candidate_sha"
cd "$build_dir/checkout"
mise trust
mise install --locked
mise run //server:ci-unit
mise run //web:checklist
mise run //server:build
mise run //server:sync-open-api
mise run open-api-typescript
git diff --exit-code -- open-api/immich-openapi-specs.json packages/sdk
pnpm --filter immich migrations:verify-order:gallery

repository=kezaer/noodle-gallery
image=ghcr.io/kezaer/noodle-gallery-server
version=v5.8.0-fork.rc.0
tag="local-rc-$candidate_sha"
jq --arg repository "$repository" '
  .repository.name = $repository |
  .repository.url = ("https://github.com/" + $repository) |
  .repository.issues_url = ("https://github.com/" + $repository + "/issues/new") |
  .repository.releases_url = ("https://github.com/" + $repository + "/releases") |
  .docker.registry = "ghcr.io/kezaer" |
  .docker.server_image = "noodle-gallery-server"
' branding/config.json > "$build_dir/fork-branding.json"
mv "$build_dir/fork-branding.json" branding/config.json
if [[ "$(uname -s)" == Darwin ]]; then
  export PATH="/opt/homebrew/opt/gnu-sed/libexec/gnubin:/opt/homebrew/opt/coreutils/libexec/gnubin:$PATH"
fi
FORK_VERSION="$version" ./branding/scripts/apply-branding.sh
./branding/scripts/verify-branding.sh
secret_args=()
if [[ -n "${GITHUB_TOKEN:-}" ]]; then
  secret_args=(--secret id=github_token,env=GITHUB_TOKEN)
fi
docker buildx build --platform linux/amd64 --load \
  --file server/Dockerfile --tag "$image:$tag" \
  --label "org.opencontainers.image.source=https://github.com/$repository" \
  --label "org.opencontainers.image.revision=$candidate_sha" \
  --label "org.opencontainers.image.version=$version" \
  --build-arg BUILD_ID=local --build-arg "BUILD_IMAGE=$image" \
  --build-arg "BUILD_SOURCE_REF=$candidate_sha" \
  --build-arg "BUILD_SOURCE_COMMIT=$candidate_sha" \
  "${secret_args[@]}" .
docker image inspect --format '{{.Id}}' "$image:$tag"
docker image save --output "$build_dir/fork-server.tar" "$image:$tag"
printf 'Image archive: %s\nBuild checkout: %s\n' "$build_dir/fork-server.tar" "$build_dir/checkout"
SH
```

After these commands succeed, `fork-server.tar` is a local executable image archive. Another Docker host can load it with `docker image load --input /path/to/fork-server.tar`. The printed image ID identifies the local image configuration. It is not a published GHCR manifest digest. This recipe does not publish or deploy, and image construction alone does not prove container startup or the transfer acceptance scenarios.

## Publish a pinned candidate

After reviewing the verification result, dispatch with publication enabled.

```sh
gh workflow run fork-rc.yml --repo kezaer/noodle-gallery \
	--ref reviewed-branch -f version=v5.8.0-fork.rc.0 -f publish=true
gh run list --repo kezaer/noodle-gallery --workflow fork-rc.yml --limit 5
gh run watch RUN_ID --repo kezaer/noodle-gallery --exit-status
gh run download RUN_ID --repo kezaer/noodle-gallery --pattern 'fork-rc-*'
```

The publishing run repeats verification before building. It uses the run's `GITHUB_TOKEN` and grants package writes only to the build job. It needs no production secrets. It publishes only `ghcr.io/kezaer/noodle-gallery-server`, with a tag that includes the full source SHA, run ID, and run attempt. It does not move `latest`, `release`, or version tags and creates no Git tag or GitHub Release.

Copy the `pull_reference` from `fork-rc.json` or the run summary. Deploy and retain that digest reference, such as `ghcr.io/kezaer/noodle-gallery-server@sha256:<digest>`. The digest identifies immutable content. Tag uniqueness alone does not prevent a registry actor from moving a tag. Preserve this metadata with the candidate's test evidence and release notes. Check package visibility and access before relying on anonymous pulls.

## Validate migration and rollback before deployment

Run the candidate against a disposable copy of the previous database and media layout. The server applies migrations on startup. A migration manifest check proves file ordering, not upgrade or rollback behavior. Verify the stock upload path, new opt-in paths, worker recovery, and storage cleanup against the accepted transfer architecture before calling this a feature release.

Before any deployment, retain the previous server digest, matching ML and database image digests, environment configuration, database backup, and media snapshot. Test restoration on disposable data. Pin every service image in the deployment manifest.

For an application fallback, disable the new feature switches and keep the current candidate while outstanding work drains. Confirm that behavior in the candidate first. Do not switch an older binary onto a migrated database unless compatibility has passed a restore test. If the schema is incompatible, restore the matching pre-upgrade database and media snapshot with the previous pinned images. Do not run an untested chain of down migrations or delete committed assets to force a rollback.

This workflow proves only the checks it executes and image construction. It does not run database integration, browser resume, B2 compatibility, one-GET accounting, stage crash recovery, Range behavior, cache authorization, or a VPS performance trial. Record those results separately before accepting the transfer release.
