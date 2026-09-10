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

    // Remove any PRs that edit the `.github/workflows` directory
    runs = await runs.reduce(async (acc, run) => {
      // Scope candidate to current PR if PR context is present
      if (targetPrNumber && run.pull_requests && run.pull_requests.length > 0) {
        const matchesPr = run.pull_requests.some(
          (p) => p.number === targetPrNumber
        );
        if (!matchesPr) {
          const runPrs = run.pull_requests.map((p) => p.number).join(", #");
          console.log(
            `Ignoring workflow run ${run.id}: belongs to PR #${runPrs}, not current PR #${targetPrNumber}`
          );
          return acc;
        }
      }

      if (targetHeadSha && run.head_sha && run.head_sha !== targetHeadSha) {
        console.log(
          `Ignoring workflow run ${run.id}: head SHA ${run.head_sha} does not match current PR head SHA ${targetHeadSha}`
        );
        return acc;
      }

      // If the fork has been deleted head_repository will be null
      if (!run.head_repository) {
        console.log(
          `No head_repository found for '${run.html_url}'. Must be manually approved`
        );
        return acc;
      }

      // Determine if this run represents an API-approvable fork PR hold
      const baseRepoFullName = `${owner}/${repo}`.toLowerCase();
      const headRepoFullName = (
        run.head_repository.full_name ||
        (run.head_repository.owner
          ? `${run.head_repository.owner.login}/${repo}`
          : "")
      ).toLowerCase();

      const isSameRepo =
        headRepoFullName === baseRepoFullName ||
        (run.head_repository.owner &&
          run.head_repository.owner.login.toLowerCase() ===
            owner.toLowerCase());

      if (isSameRepo) {
        console.log(
          `Skipping workflow run ${run.id}: action_required run is not an API-approvable fork PR workflow; manual or security approval may be required`
        );
        return acc;
      }

      // Find the pull request for the current run
      const { data: pulls } = await octokit.rest.pulls.list({
        owner,
        repo,
        state: "all",
        head: `${run.head_repository.owner.login}:${run.head_branch}`,
      });

      if (pulls.length === 0) {
        console.log(
          `No pull request found for '${run.head_repository.owner.login}:${run.head_branch}'`
        );
        return acc;
      }

      if (targetPrNumber && !pulls.some((p) => p.number === targetPrNumber)) {
        const pullNumbers = pulls.map((p) => p.number).join(", #");
        console.log(
          `Ignoring workflow run ${run.id}: PR #${pullNumbers || "unknown"} does not match current PR #${targetPrNumber}`
        );
        return acc;
      }

      const targetPull = targetPrNumber
        ? pulls.find((p) => p.number === targetPrNumber) || pulls[0]
        : pulls[0];
      // List all the files in there
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
        console.log(
          `Skipping workflow run ${run.id}: action_required run is not an API-approvable fork PR workflow; manual or security approval may be required`
        );
        return acc;
      }

      // List all the files in there
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

      const matching = [].concat(matching_danger, matching_unsafe)

      // If we changed any files in that directory, return the current set and skip this run
      if (matching.length > 0) {
        console.log(`Skipped dangerous run '${run.id}'`);
        return acc;
      }

      // Otherwise add this run to the list of runs to execute
      return (await acc).concat(run);
    }, []);

    // Loop through them and approve all, continuing on individual failures
    const results = await Promise.allSettled(
      runs.map(async (run) => {
        await octokit.request(
          "POST /repos/{owner}/{repo}/actions/runs/{run_id}/approve",
          {
            owner,
            repo,
            run_id: run.id,
          }
        );
        console.log(`Approved run '${run.id}'`);
      })
    );

    const failures = results.filter((r) => r.status === "rejected");
    if (failures.length > 0) {
      for (const f of failures) {
        const err = f.reason;
        if (err.request && err.request.url) {
          console.log(`Warning: failed to approve run - ${err.request.url} - HTTP ${err.status}`);
        } else {
          console.log(`Warning: failed to approve run - ${err.message}`);
        }
      }
      const approved = results.length - failures.length;
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
