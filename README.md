# Automatic Approve

Automatically approve workflow runs from first-time external contributors.

## Overview

When external contributors submit pull requests from public forks, GitHub Actions holds their workflows in an `action_required` state until a maintainer approves them to run.

This action automates that approval process for trusted or verified workflows while enforcing safety boundaries:

- **Scopes candidates to the triggering pull request:** Evaluates only workflow runs associated with the triggering pull request (and revision), ignoring stale runs from other pull requests.
- **Identifies API-approvable fork workflows:** GitHub's REST approval API (`POST /repos/{owner}/{repo}/actions/runs/{run_id}/approve`) is designed specifically for public-fork pull request holds. Same-repository holds (such as bot-created pull requests or manual security policies) cannot be approved via this endpoint and are safely skipped.
- **Guards against workflow tampering:** Pull requests that modify `.github/workflows` or files listed in `dangerous_files` are skipped and require manual maintainer review.
- **Separates skipped and failed runs:** Non-approvable holds or safe file exclusions are logged as skipped and do not cause the action to fail. Only actual API errors on eligible fork runs produce a failure.

## Operational Semantics

### Supported Approval Class

Only workflow runs that satisfy all of the following criteria are eligible for automatic API approval:

1. The workflow file matches the configured `workflows` allowlist.
2. The run belongs to the current pull request (when triggered by `pull_request_target` or when `pull-request-number` is provided).
3. The run corresponds to the current PR revision (when `head-sha` is provided or derived).
4. The pull request originates from a fork repository (`head_repository != base_repository`).
5. The pull request does not modify `.github/workflows` or any file specified in `dangerous_files`.
6. If `safe_files` is specified, all modified files match the safe patterns.

### Skipped Manual / Security Holds

GitHub now uses the `action_required` status for various workflow hold scenarios, including bot-created pull requests and repository security review policies. Same-repository `action_required` runs return HTTP 403 if sent to the fork approval API.

When such holds are encountered:
- The action does **not** call the approval endpoint.
- The action emits an informative diagnostic message (e.g. `Skipping workflow run ...: action_required run is not an API-approvable fork PR workflow; manual or security approval may be required`).
- The run is classified as `skipped` rather than `failed`.

### Failure Semantics

- **Zero eligible runs:** If no workflow runs require API approval (e.g. all runs were skipped or ignored), the action exits successfully.
- **Genuine API failures:** If an eligible fork workflow run fails to approve (e.g. GitHub returns HTTP 403 due to missing GitHub App `actions: write` permissions or token invalidity), the failure is reported and the action exits with a failing status.

## Usage

### Pull Request Target (Recommended)

```yaml
name: Automatic Approve Workflow

on:
  pull_request_target:
    types: [opened, synchronize, reopened]

jobs:
  automatic-approve:
    name: Approve Workflows
    runs-on: ubuntu-latest
    steps:
      - uses: actions/create-github-app-token@v1
        id: app-token
        with:
          app-id: ${{ secrets.APP_ID }}
          private-key: ${{ secrets.APP_PRIVATE_KEY }}

      - uses: skevetter/automatic-approve-action@v2
        with:
          token: ${{ steps.app-token.outputs.token }}
          workflows: "commit.yml,pr-ci.yml"
```

### Available Configuration

#### Inputs

| Name                  | Description                                                                                                          | Required | Default |
| --------------------- | -------------------------------------------------------------------------------------------------------------------- | -------- | ------- |
| `token`               | The GitHub Token to use. Must have `actions: write` permission.                                                      | true     | N/A     |
| `workflows`           | Comma-separated workflow filenames to automatically approve (e.g. `commit.yml,pr-ci.yml`)                           | true     | N/A     |
| `dangerous_files`     | Comma-separated list of filenames/paths that prevent the PR from being automatically approved                       | false    |         |
| `safe_files`          | Comma-separated list of filenames/paths. If provided, all modified files must match to allow approval               | false    |         |
| `pull-request-number` | Pull request number to scope approvals to. Defaults to `github.event.pull_request.number` when run on pull request. | false    |         |
| `head-sha`            | Head SHA to scope approvals to. Defaults to `github.event.pull_request.head.sha` when run on pull request.          | false    |         |