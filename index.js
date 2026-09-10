const core = require("@actions/core");
const github = require("@actions/github");
const yaml = require("js-yaml");

async function action() {
  try {
    const owner = github.context.repo.owner;
    const repo = github.context.repo.repo;

    const octokit = github.getOctokit(
      core.getInput("token", { required: true })
    );
    const allowedWorkflows = core
      .getInput("workflows", { required: true })
      .split(",")
      .map((w) => {
        return `.github/workflows/${w}`;
      });

    const dangerousFiles = core
      .getInput("dangerous_files")
      .split(",")
      .filter((r) => r);
    dangerousFiles.push(".github/workflows");

    const safeFiles = core
    .getInput("safe_files")
    .split(",")
    .filter((r) => r);
    const pullRequestNumberInput =
      core.getInput("pull-request-number") ||
      core.getInput("pull_request_number");
    const headShaInput =
      core.getInput("head-sha") || core.getInput("head_sha");

    const eventPullRequest =
      github.context.payload && github.context.payload.pull_request;

    const targetPrNumber = pullRequestNumberInput
      ? parseInt(pullRequestNumberInput, 10)
      : eventPullRequest
      ? eventPullRequest.number
      : null;

    const targetHeadSha =
      headShaInput ||
      (eventPullRequest && eventPullRequest.head
        ? eventPullRequest.head.sha
        : null);


    // Fetch runs that require action
    let { data: runs } = await octokit.rest.actions.listWorkflowRunsForRepo({
      owner,
      repo,
      status: "action_required",
    });

    // If there are no runs, return early
    if (runs.total_count == 0) {
      console.log("No runs found with status 'action_required'");
      return;
    }

    // Load the provided workflows so that we can map the workflow
    // name (available in the runs API) to the workflow file
    const nameToWorkflow = {};
    for (let w of allowedWorkflows) {
      const { data: file } = await octokit.rest.repos.getContent({
        owner,
        repo,
        path: w,
      });
      const workflow = yaml.load(Buffer.from(file.content, "base64"));
      if (workflow.name) {
        nameToWorkflow[workflow.name] = w;
      }
    }

    // Filter only to workflows that are in the allow list
    runs = runs.workflow_runs.filter((run) => {
      let name;
      if (nameToWorkflow[run.name]) {
        name = nameToWorkflow[run.name];
      } else {
        name = run.name;
      }
      return allowedWorkflows.includes(name);
    });

    if (runs.length == 0) {
      console.log(
        `No runs found for the following workflows: ${allowedWorkflows.join(
          ", "
        )}`
      );
      return;
    }

    console.log("Automatic workflow approval");
    if (targetPrNumber) {
      console.log(`PR: #${targetPrNumber}`);
    }
    if (targetHeadSha) {
      console.log(`Head SHA: ${targetHeadSha}`);
    }

    // Classify candidates
    const candidates = [];
    for (const run of runs) {
      const workflowPath =
        nameToWorkflow[run.name] || run.path || run.name;
      const baseRepoFullName = `${owner}/${repo}`.toLowerCase();
      const headRepoFullName = (
        run.head_repository?.full_name ||
        (run.head_repository?.owner
          ? `${run.head_repository.owner.login}/${repo}`
          : "")
      ).toLowerCase();

      const candidate = {
        runId: run.id,
        workflowPath,
        run,
        headSha: run.head_sha,
        actor: run.actor ? run.actor.login : undefined,
        headRepository:
          run.head_repository?.full_name ||
          (run.head_repository?.owner
            ? run.head_repository.owner.login
            : undefined),
        baseRepository: `${owner}/${repo}`,
        pullRequestNumber: undefined,
        disposition: "eligible",
        reason: undefined,
      };

      // 1. Check PR identity scoping if PRs known on run
      if (targetPrNumber && run.pull_requests && run.pull_requests.length > 0) {
        const runPrNumbers = run.pull_requests.map((p) => p.number);
        candidate.pullRequestNumber = runPrNumbers[0];
        if (!runPrNumbers.includes(targetPrNumber)) {
          candidate.disposition = "unrelated";
          candidate.reason = `belongs to PR #${runPrNumbers.join(", #")}, not current PR #${targetPrNumber}`;
          candidates.push(candidate);
          console.log(
            `Ignoring workflow run ${run.id}: belongs to PR #${runPrNumbers.join(", #")}, not current PR #${targetPrNumber}`
          );
          continue;
        }
      }

      // 2. Check head SHA
      if (targetHeadSha && run.head_sha && run.head_sha !== targetHeadSha) {
        candidate.disposition = "unrelated";
        candidate.reason = `head SHA ${run.head_sha} does not match current PR head SHA ${targetHeadSha}`;
        candidates.push(candidate);
        console.log(
          `Ignoring workflow run ${run.id}: head SHA ${run.head_sha} does not match current PR head SHA ${targetHeadSha}`
        );
        continue;
      }

      // 3. Check head_repository existence
      if (!run.head_repository) {
        candidate.disposition = "manual_required";
        candidate.reason = `No head_repository found for '${run.html_url}'. Must be manually approved`;
        candidates.push(candidate);
        console.log(
          `No head_repository found for '${run.html_url}'. Must be manually approved`
        );
        continue;
      }

      // 4. Check repository relationship (same repo vs fork)
      const isSameRepo =
        headRepoFullName === baseRepoFullName ||
        (run.head_repository.owner &&
          run.head_repository.owner.login.toLowerCase() ===
            owner.toLowerCase());

      if (isSameRepo) {
        candidate.disposition = "manual_required";
        candidate.reason =
          "action_required run is not an API-approvable fork PR workflow; manual or security approval may be required";
        candidates.push(candidate);
        console.log(
          `Skipping workflow run ${run.id}: action_required run is not an API-approvable fork PR workflow; manual or security approval may be required`
        );
        continue;
      }

      // 5. Look up PR if not yet resolved
      const { data: pulls } = await octokit.rest.pulls.list({
        owner,
        repo,
        state: "all",
        head: `${run.head_repository.owner.login}:${run.head_branch}`,
      });

      if (pulls.length === 0) {
        candidate.disposition = "unrelated";
        candidate.reason = `No pull request found for '${run.head_repository.owner.login}:${run.head_branch}'`;
        candidates.push(candidate);
        console.log(
          `No pull request found for '${run.head_repository.owner.login}:${run.head_branch}'`
        );
        continue;
      }

      const pullNumbers = pulls.map((p) => p.number);
      if (targetPrNumber && !pullNumbers.includes(targetPrNumber)) {
        candidate.disposition = "unrelated";
        candidate.reason = `PR #${pullNumbers.join(", #") || "unknown"} does not match current PR #${targetPrNumber}`;
        candidates.push(candidate);
        console.log(
          `Ignoring workflow run ${run.id}: PR #${pullNumbers.join(", #") || "unknown"} does not match current PR #${targetPrNumber}`
        );
        continue;
      }

      const targetPull = targetPrNumber
        ? pulls.find((p) => p.number === targetPrNumber) || pulls[0]
        : pulls[0];

      candidate.pullRequestNumber = targetPull.number;

      if (
        targetPull.head &&
        targetPull.head.repo &&
        targetPull.base &&
        targetPull.base.repo &&
        targetPull.head.repo.full_name &&
        targetPull.base.repo.full_name &&
        targetPull.head.repo.full_name.toLowerCase() ===
          targetPull.base.repo.full_name.toLowerCase()
      ) {
        candidate.disposition = "manual_required";
        candidate.reason =
          "action_required run is not an API-approvable fork PR workflow; manual or security approval may be required";
        candidates.push(candidate);
        console.log(
          `Skipping workflow run ${run.id}: action_required run is not an API-approvable fork PR workflow; manual or security approval may be required`
        );
        continue;
      }

      // 6. Check modified files
      const { data: files } = await octokit.rest.pulls.listFiles({
        owner,
        repo,
        pull_number: targetPull.number,
      });

      const matching_danger = files.filter((f) => {
        for (let d of dangerousFiles) {
          if (f.filename.includes(d)) {
            return true;
          }
        }
      });

      const matching_unsafe = files.filter((f) => {
        if (!safeFiles.length) {
          return false;
        }
        for (let s of safeFiles) {
          if (f.filename.includes(s)) {
            return false;
          }
        }
        return true;
      });

      const matching = [].concat(matching_danger, matching_unsafe);

      if (matching.length > 0) {
        candidate.disposition = "manual_required";
        candidate.reason = "PR modifies dangerous or non-safe files";
        candidates.push(candidate);
        console.log(`Skipped dangerous run '${run.id}'`);
        continue;
      }

      // Passed all checks: eligible
      candidate.disposition = "eligible";
      candidate.reason = "API-approvable fork PR workflow";
      candidates.push(candidate);
    }

    const eligibleCandidates = candidates.filter(
      (c) => c.disposition === "eligible"
    );
    const skippedCandidates = candidates.filter(
      (c) => c.disposition === "manual_required"
    );
    const ignoredCandidates = candidates.filter(
      (c) => c.disposition === "unrelated"
    );

    // Loop through eligible runs and approve all, continuing on individual failures
    const results = await Promise.allSettled(
      eligibleCandidates.map(async (candidate) => {
        await octokit.request(
          "POST /repos/{owner}/{repo}/actions/runs/{run_id}/approve",
          {
            owner,
            repo,
            run_id: candidate.runId,
          }
        );
        console.log(`Approved run '${candidate.runId}'`);
        return candidate;
      })
    );

    const failures = results.filter((r) => r.status === "rejected");
    const successful = results.filter((r) => r.status === "fulfilled");

    console.log("Approval summary:");
    console.log(`  candidates discovered: ${candidates.length}`);
    console.log(`  eligible: ${eligibleCandidates.length}`);
    console.log(`  approved: ${successful.length}`);
    console.log(`  skipped: ${skippedCandidates.length}`);
    console.log(`  ignored: ${ignoredCandidates.length}`);
    console.log(`  failed: ${failures.length}`);

    if (eligibleCandidates.length === 0) {
      console.log("No eligible workflow runs require API approval.");
      return;
    }

    if (failures.length > 0) {
      for (const f of failures) {
        const err = f.reason;
        if (err.request && err.request.url) {
          console.log(
            `Warning: failed to approve run - ${err.request.url} - HTTP ${err.status}`
          );
        } else {
          console.log(`Warning: failed to approve run - ${err.message}`);
        }
      }
      const approved = successful.length;
      if (approved === 0) {
        return core.setFailed(`All ${failures.length} approval(s) failed`);
      }
      console.log(`Approved ${approved} run(s), ${failures.length} failed`);
    }
  } catch (e) {
    if (e.request && e.request.url) {
      return core.setFailed(
        `Error fetching ${e.request.url} - HTTP ${e.status}`
      );
    }
    return core.setFailed(e.message);
  }
}

if (require.main === module) {
  action();
}

module.exports = action;
