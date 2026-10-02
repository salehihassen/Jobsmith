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
| `fix/manual-applied-pipeline` | Make manually applied jobs appear in Applied, with regression tests. Prepared from an older upstream revision. | [Open comparison](https://github.com/TheDevRo/Jobsmith/compare/main...salehihassen:Jobsmith:fix/manual-applied-pipeline?expand=1) |
| `fix/pipeline-live-refresh` | Keep pipeline content stable while polling; preserve unchanged cards, focus, scroll, and selected documents. | [Open PR form](https://github.com/TheDevRo/Jobsmith/compare/main...salehihassen:Jobsmith:fix/pipeline-live-refresh?expand=1) |
| `feat/edit-job-details` | Edit posting details through the web UI while retaining identity, pipeline stage, and application documents. | [Open PR form](https://github.com/TheDevRo/Jobsmith/compare/main...salehihassen:Jobsmith:feat/edit-job-details?expand=1) |
| `feat/application-progress-pipeline` | Keep Shortlisted → Tailoring → Ready to Review visible before Applied → Interviewing → Offer. Submission issues and rejected / turned-down history stay in expandable sections. Preserve existing outcome history and application records. | [Open PR form](https://github.com/TheDevRo/Jobsmith/compare/main...salehihassen:Jobsmith:feat/application-progress-pipeline?expand=1) |

The last three branches start at upstream `14c7046`. Their implementation and
tests are also merged into `saleh-changes`. As of October 1, 2026, the GitHub
connector rejected PR creation with HTTP 403, so these are pushed branches,
not opened pull requests.

The original snapshot on `saleh` also retains remote dashboard / extension
support and posting phrase exclusions. Those changes still need independent
contribution branches; the extension support currently includes a personal host.

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

`/opt/docker-compose.yaml` builds Jobsmith from `/opt/jobsmith/source`, a
separate detached Git worktree pinned to the verified combined revision.
Runtime data and configuration remain in their existing `/opt/jobsmith`
directories. Update that checkout deliberately before building, tag the image
with its Git revision, and recreate only the Jobsmith service with `--no-deps`.

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
