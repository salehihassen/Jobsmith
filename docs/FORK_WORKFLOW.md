# Fork and contribution workflow

`origin` points to `TheDevRo/Jobsmith` (upstream). `fork` points to
`salehihassen/Jobsmith`. Local `main` tracks `origin/main` and stays free of
personal changes. Local `saleh` tracks `fork/saleh-changes` and combines the
changes used by the hosted instance.

Build each contribution on its own branch from current upstream `main`.
Merge that branch into `saleh` for deployment; keep the contribution branch
independent so its upstream PR contains only that change.

## Prepared contributions

| Branch | Scope | Upstream submission |
| --- | --- | --- |
| `fix/manual-applied-pipeline-current` | Make manually applied jobs appear in Applied, with regression tests. | Merged upstream in `14c0745` (#33, from #23), including follow-up safeguards. |
| `fix/pipeline-live-refresh` | Keep pipeline content stable while polling; preserve unchanged cards, focus, scroll, and selected documents. | [Open PR form](https://github.com/TheDevRo/Jobsmith/compare/main...salehihassen:Jobsmith:fix/pipeline-live-refresh?expand=1) |
| `feat/edit-job-details` | Edit posting details through the web UI while retaining identity, pipeline stage, and application documents. | [Open PR form](https://github.com/TheDevRo/Jobsmith/compare/main...salehihassen:Jobsmith:feat/edit-job-details?expand=1) |
| `feat/application-progress-pipeline` | Keep Shortlisted → Tailoring → Ready to Review visible before Applied → Interviewing → Offer. Submission issues and rejected / turned-down history stay in expandable sections. Preserve existing outcome history and application records. | [Open PR form](https://github.com/TheDevRo/Jobsmith/compare/main...salehihassen:Jobsmith:feat/application-progress-pipeline?expand=1) |
| `fix/remote-apply-assist` | Bind pairing credentials to their exact origin; support explicitly configured HTTPS backends without personal hostnames or broad HTTPS content scripts. | [Open PR form](https://github.com/TheDevRo/Jobsmith/compare/main...salehihassen:Jobsmith:fix/remote-apply-assist?expand=1) |
| `fix/workday-host-validation` | Require HTTPS and a genuine Workday domain before saved credentials can be filled or submitted; keep the iOS helper consistent. | [Open PR form](https://github.com/TheDevRo/Jobsmith/compare/main...salehihassen:Jobsmith:fix/workday-host-validation?expand=1) |

The last three branches start at upstream `14c7046`. Their implementation and
tests are also merged into `saleh-changes`. As of October 1, 2026, the GitHub
connector rejected PR creation with HTTP 403, so these are pushed branches,
not opened pull requests.

The original snapshot on `saleh` retains posting phrase exclusions, which still
need an independent contribution branch. Its earlier hostname-specific extension
support has been replaced by the generic `fix/remote-apply-assist` implementation.

## Refresh upstream and start a contribution

```sh
git fetch origin
git switch main
git merge --ff-only origin/main
git switch -c fix/one-focused-change main
# Implement and verify the change, then commit it.
git push -u fork HEAD
```

Open the PR against upstream `main`. Integrate it into the hosted branch:

```sh
git switch saleh
git merge --no-edit fix/one-focused-change
# Run npm test and the non-integration backend test suite.
git push fork HEAD:saleh-changes
```

## Hosted Docker instance

The live Compose project is defined by
`~/repos/homelab-infra/hosts/server-1/compose.yaml`, which includes
`jobsmith/compose.yaml`. Its environment files are symlinks to
`/opt/jobsmith/compose.env` and `/opt/jobsmith/routing.env`. The service uses the
`JOBSMITH_IMAGE` image pin; pushes to `fork/saleh-changes` publish commit-tagged
GHCR images through `.github/workflows/docker-publish.yml`.

Runtime data and configuration remain under `/opt/jobsmith`. The detached
`/opt/jobsmith/source` worktree is retained from the earlier local-build workflow;
it is not the source of the live image. On October 9 the container's revision was
`bdac6ac`, while that worktree remained at `ee530be`.

Update the image pin deliberately and recreate only Jobsmith with `--no-deps`.
The root Compose project contains other services; do not recreate the entire
stack to update this application.

Before an update, take an online SQLite backup and copy the configuration and
Compose file. The October 1 update saved its database and configuration under
`/opt/jobsmith/data/backups/pre-pipeline-editor-20261001/`, and its Compose file
at `/opt/jobsmith/compose-pre-pipeline-editor-20261001.yaml`.

The hiring-pipeline update also backed up the database and configuration in
`/opt/jobsmith/data/backups/pre-hiring-pipeline-20261001/` and Compose in
`/opt/jobsmith/compose-pre-hiring-pipeline-20261001.yaml`.

The visible-shortlist revision backed up the database and configuration in
`/opt/jobsmith/data/backups/pre-visible-shortlist-20261002T002602Z/` and Compose
in `/opt/jobsmith/compose-pre-visible-shortlist-20261002T002602Z.yaml`.

## October 9 upstream rebase

`backup/saleh-pre-rebase-20261009` preserves the combined branch at `bdac6ac`.
The local `saleh` branch was rebased onto upstream `14c0745`, replaying the
remaining personal commits as a linear history. The contribution branches and
other worktrees retain their original histories. Conflicts were resolved by
keeping upstream's manual-Applied safeguards (non-null sync fields, duplicate
prevention, and in-flight auto-apply protection) together with the posting editor,
board layout, live-refresh behavior, and posting phrase exclusions.

Because rebasing rewrites the combined branch, updating `fork/saleh-changes`
requires a deliberate `--force-with-lease` push. Check the remote has not gained
someone else's changes first. Rebasing locally does not publish or deploy it.

The board now supports dragging Applied, Interviewing, or Offer into closed
history to record `outcome: rejected`, including via the collapsed history
summary. Turn down / withdraw remains an explicit menu action. Rejection does
not change submission status or delete the saved application documents.

The posting editor includes a Job state selector. Submitted applications can
record awaiting response, no response, screening, interview, offer, rejected,
and withdrawn outcomes. Unsent roles can be marked Applied manually first;
active tailoring/submission work locks the state selector until it finishes.
The opened job card also offers Update state and a direct Mark rejected action
for submitted applications, and displays the saved outcome alongside Applied.

## October 9 extension security contributions

Two separate worktrees start at clean upstream `14c0745`:
`~/repos/services/Jobsmith-remote-assist` and
`~/repos/services/Jobsmith-workday-security`. Neither contribution includes the
personal pipeline, posting editor, filter, or image-publishing changes.

The remote branch contains `a1bc095` (origin-bound token reuse and check-in
redirect rejection) followed by `88075e2` (configured HTTPS backend support).
The maintainer can take the first security commit independently if they prefer
to review remote support later. The Workday branch contains `08efba1`.

Both branches passed full Node and non-integration backend suites. Isolated
Chromium tests with dummy credentials confirmed the localhost token leak is
blocked and remote HTTPS pairing works; the remote browser fixture emulated an
already-granted host permission, while Node tests exercised the popup's request
and denial behavior. The Workday tests cover lookalike domains, HTTP rejection,
and valid tenants. iOS's shared Workday script was updated too; Xcode tests were
not run on c3.

Both contribution branches are pushed. Upstream PR creation was attempted for
each and rejected with GitHub HTTP 403, `Resource not accessible by integration`.
The links above open the PR forms; no upstream pull requests were created.

The fixes are merged into `saleh`, preserving all personal frontend tests and
replacing the old hard-coded hostname permission and handoff exception. For a
new remote extension install, enter the backend's HTTPS origin in the popup and
click Save to grant its host permission, then launch Apply Assist from the
authenticated dashboard. Changing the backend URL clears an unchanged token
from the previous instance.

Merging and publishing the combined branch does not change `JOBSMITH_IMAGE` or
recreate the running container. The live instance and its served extension
require a separate deliberate image update before these fixes are available
through its download links.
