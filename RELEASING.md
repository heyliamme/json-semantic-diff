# Releasing

Releases are published by the **Release** workflow when a version tag is pushed. It
runs the tests, packages the `.vsix`, publishes to the VS Code Marketplace and Open VSX,
and attaches the `.vsix` to a GitHub release.

## Cutting a release

1. Bump `version` in `package.json` (semver) and add a section to `CHANGELOG.md`.
2. Commit, then tag with the same version and push the tag:

   ```bash
   git tag v0.2.0
   git push origin v0.2.0
   ```

The workflow refuses to publish if the tag and `package.json` disagree.

## One-time setup

0. **Public repository.** Create `heyliamme/json-semdiff` as a **public** repository and push `main`.
   The store pages load README images from it, and CI and the release workflow run there.
   Then Settings → Code security → enable **Private vulnerability reporting** (SECURITY.md and
   the issue templates link to its form).
1. **Environment.** Settings → Environments → New environment `release`. Add yourself as a
   required reviewer, so pushing a tag waits for your approval before anything is published.
   The store tokens below go in this environment, not in repository secrets.
2. **Open VSX namespace.** After creating the token, once: `npx ovsx create-namespace heyliam -p <token>`.
   Without it the first Open VSX publish fails.
3. **Marketplace publisher** `heyliam` at https://marketplace.visualstudio.com/manage.

## Store credentials

The publish job signs in to each store on its own; a store with no credential is skipped,
so either can be set up later.

**VS Code Marketplace: Microsoft Entra ID (recommended).** No stored token: the workflow
signs in with GitHub's OIDC identity.

1. In the Azure portal, create an app registration (Microsoft Entra ID → App
   registrations → New). Under *Certificates & secrets → Federated credentials*, add a
   *GitHub Actions* credential for this repository, entity type *Environment*, name
   `release`.
2. Add the app's service principal as a member of the `heyliam` publisher on
   https://marketplace.visualstudio.com/manage (Members → Add, by its object id).
3. In the `release` environment, add the **variables** `AZURE_CLIENT_ID` and
   `AZURE_TENANT_ID` (from the app's overview page).

**VS Code Marketplace: personal access token (fallback).** Secret `VSCE_PAT`, from Azure
DevOps → User settings → Personal access tokens, organization *All accessible
organizations*, scope *Marketplace → Manage*. Azure DevOps retires these global tokens on
1 December 2026, after which only the Entra ID route works. It is used only when
`AZURE_CLIENT_ID` is not set.

**Open VSX.** Secret `OVSX_PAT`, from open-vsx.org → Settings → Access Tokens (after
signing the Eclipse Publisher Agreement).

Tokens expire; when a publish step fails with 401, renew the token and update the secret.

If one store published and the other failed, re-run the workflow: both publish steps use
`--skip-duplicate`.

## Publishing by hand

```bash
npm ci && npm test
npm run package                                   # json-semantic-diff-<version>.vsix
npx vsce publish --packagePath json-semantic-diff-<version>.vsix -p "$VSCE_PAT"
npx ovsx publish json-semantic-diff-<version>.vsix -p "$OVSX_PAT"
```

## Notes

- The README on the store pages loads its images from this GitHub repository, so the
  repository must be public.
- The publisher ID (`heyliam`) is part of the extension's identity. Changing it means a
  new extension listing, so it never changes.
