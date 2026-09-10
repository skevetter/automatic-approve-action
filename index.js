const core = require("@actions/core");
const github = require("@actions/github");
const yaml = require("js-yaml");

function parseConfiguration() {
  const owner = github.context.repo.owner;
  const repo = github.context.repo.repo;
  const token = core.getInput("token", { required: true });
  const workflows = core
    .getInput("workflows", { required: true })
    .split(",")
    .map((workflow) => `.github/workflows/${workflow}`);

  const dangerousFiles = core
    .getInput("dangerous_files")
    .split(",")
    .filter(Boolean);
  dangerousFiles.push(".github/workflows");

  const safeFiles = core
    .getInput("safe_files")
    .split(",")
    .filter(Boolean);

  const pullRequestNumberInput =
    core.getInput("pull-request-number") ||
    core.getInput("pull_request_number");
  const headShaInput =
    core.getInput("head-sha") || core.getInput("head_sha");

  const eventPullRequest = github.context.payload?.pull_request;
  const targetPrNumber = pullRequestNumberInput
    ? parseInt(pullRequestNumberInput, 10)
    : eventPullRequest?.number || null;
  const targetHeadSha =
    headShaInput || eventPullRequest?.head?.sha || null;

  return {
    owner,
    repo,
    token,
    workflows,
    dangerousFiles,
    safeFiles,
    targetPrNumber,
    targetHeadSha,
  };
}

async function loadWorkflowNames(octokit, config) {
  const nameToWorkflow = {};
  for (const workflowPath of config.workflows) {
    const { data: file } = await octokit.rest.repos.getContent({
      owner: config.owner,
      repo: config.repo,
      path: workflowPath,
    });
    const parsedWorkflow = yaml.load(Buffer.from(file.content, "base64"));
    if (parsedWorkflow.name) {
      nameToWorkflow[parsedWorkflow.name] = workflowPath;
    }
  }
  return nameToWorkflow;
}

function resolveRunWorkflowPath(run, nameToWorkflow) {
  return nameToWorkflow[run.name] || run.path || run.name;
}

function filterRunsByWorkflows(runs, allowedWorkflows, nameToWorkflow) {
  return runs.filter((run) => {
    const resolvedPath = resolveRunWorkflowPath(run, nameToWorkflow);
    return allowedWorkflows.includes(resolvedPath);
  });
}

function hasDifferentPrNumber(run, targetPrNumber) {
  if (!targetPrNumber || !run.pull_requests || run.pull_requests.length === 0) {
    return false;
  }
  return !run.pull_requests.some((pr) => pr.number === targetPrNumber);
}

function hasDifferentHeadSha(run, targetHeadSha) {
  return Boolean(targetHeadSha && run.head_sha && run.head_sha !== targetHeadSha);
}

function isSameRepository(owner, repo, headRepository) {
  if (!headRepository) {
    return false;
  }
  const baseFull = `${owner}/${repo}`.toLowerCase();
  const headFull = (
    headRepository.full_name ||
    (headRepository.owner ? `${headRepository.owner.login}/${repo}` : "")
  ).toLowerCase();

  return (
    headFull === baseFull ||
    (headRepository.owner &&
      headRepository.owner.login.toLowerCase() === owner.toLowerCase())
  );
}

function isSameRepositoryPullRequest(pull) {
  const headFull = pull?.head?.repo?.full_name?.toLowerCase();
  const baseFull = pull?.base?.repo?.full_name?.toLowerCase();
  return Boolean(headFull && baseFull && headFull === baseFull);
}

function hasDangerousFile(files, dangerousFiles) {
  return files.some((file) =>
    dangerousFiles.some((danger) => file.filename.includes(danger))
  );
}

function hasUnsafeFile(files, safeFiles) {
  if (safeFiles.length === 0) {
    return false;
  }
  return files.some((file) =>
    !safeFiles.some((safe) => file.filename.includes(safe))
  );
}

function hasDisallowedFiles(files, dangerousFiles, safeFiles) {
  return (
    hasDangerousFile(files, dangerousFiles) ||
    hasUnsafeFile(files, safeFiles)
  );
}

async function findPullRequest(octokit, config, run) {
  const { data: pulls } = await octokit.rest.pulls.list({
    owner: config.owner,
    repo: config.repo,
    state: "all",
    head: `${run.head_repository.owner.login}:${run.head_branch}`,
  });
  return pulls;
}

function selectTargetPull(pulls, targetPrNumber) {
  if (!targetPrNumber) {
    return pulls[0];
  }
  return pulls.find((pull) => pull.number === targetPrNumber) || pulls[0];
}

function createInitialCandidate(config, run, workflowPath) {
  return {
    runId: run.id,
    workflowPath,
    headSha: run.head_sha,
    actor: run.actor?.login,
    headRepository:
      run.head_repository?.full_name || run.head_repository?.owner?.login,
    baseRepository: `${config.owner}/${config.repo}`,
    pullRequestNumber: run.pull_requests?.[0]?.number,
    disposition: "eligible",
  };
}

function checkRunPrEligibility(candidate, run, targetPrNumber) {
  if (!hasDifferentPrNumber(run, targetPrNumber)) {
    return true;
  }
  const runPrs = run.pull_requests.map((pr) => pr.number).join(", #");
  console.log(
    `Ignoring workflow run ${run.id}: belongs to PR #${runPrs}, not current PR #${targetPrNumber}`
  );
  candidate.disposition = "unrelated";
  return false;
}

function checkRunRevisionEligibility(candidate, run, targetHeadSha) {
  if (!hasDifferentHeadSha(run, targetHeadSha)) {
    return true;
  }
  console.log(
    `Ignoring workflow run ${run.id}: head SHA ${run.head_sha} does not match current PR head SHA ${targetHeadSha}`
  );
  candidate.disposition = "unrelated";
  return false;
}

function checkRunRepositoryEligibility(candidate, run, owner, repo) {
  if (!run.head_repository) {
    console.log(
      `No head_repository found for '${run.html_url}'. Must be manually approved`
    );
    candidate.disposition = "manual_required";
    return false;
  }

  if (isSameRepository(owner, repo, run.head_repository)) {
    console.log(
      `Skipping workflow run ${run.id}: action_required run is not an API-approvable fork PR workflow; manual or security approval may be required`
    );
    candidate.disposition = "manual_required";
    return false;
  }

  return true;
}

async function resolveAndVerifyPullRequest(octokit, config, candidate, run) {
  const pulls = await findPullRequest(octokit, config, run);
  if (pulls.length === 0) {
    console.log(
      `No pull request found for '${run.head_repository.owner.login}:${run.head_branch}'`
    );
    candidate.disposition = "unrelated";
    return null;
  }

  const pullNumbers = pulls.map((pull) => pull.number);
  if (config.targetPrNumber && !pullNumbers.includes(config.targetPrNumber)) {
    console.log(
      `Ignoring workflow run ${run.id}: PR #${pullNumbers.join(", #") || "unknown"} does not match current PR #${config.targetPrNumber}`
    );
    candidate.disposition = "unrelated";
    return null;
  }

  const targetPull = selectTargetPull(pulls, config.targetPrNumber);
  candidate.pullRequestNumber = targetPull.number;

  if (isSameRepositoryPullRequest(targetPull)) {
    console.log(
      `Skipping workflow run ${run.id}: action_required run is not an API-approvable fork PR workflow; manual or security approval may be required`
    );
    candidate.disposition = "manual_required";
    return null;
  }

  return targetPull;
}

async function checkPullRequestFiles(octokit, config, candidate, targetPull) {
  const { data: files } = await octokit.rest.pulls.listFiles({
    owner: config.owner,
    repo: config.repo,
    pull_number: targetPull.number,
  });

  if (hasDisallowedFiles(files, config.dangerousFiles, config.safeFiles)) {
    console.log(`Skipped dangerous run '${candidate.runId}'`);
    candidate.disposition = "manual_required";
    return false;
  }

  return true;
}

async function classifyCandidate(octokit, config, run, nameToWorkflow) {
  const workflowPath = resolveRunWorkflowPath(run, nameToWorkflow);
  const candidate = createInitialCandidate(config, run, workflowPath);

  if (!checkRunPrEligibility(candidate, run, config.targetPrNumber)) {
    return candidate;
  }

  if (!checkRunRevisionEligibility(candidate, run, config.targetHeadSha)) {
    return candidate;
  }

  if (!checkRunRepositoryEligibility(candidate, run, config.owner, config.repo)) {
    return candidate;
  }

  const targetPull = await resolveAndVerifyPullRequest(octokit, config, candidate, run);
  if (!targetPull) {
    return candidate;
  }

  await checkPullRequestFiles(octokit, config, candidate, targetPull);
  return candidate;
}

async function approveWorkflowRun(octokit, owner, repo, runId) {
  await octokit.request(
    "POST /repos/{owner}/{repo}/actions/runs/{run_id}/approve",
    { owner, repo, run_id: runId }
  );
  console.log(`Approved run '${runId}'`);
}

async function executeApprovals(octokit, owner, repo, eligibleCandidates) {
  return Promise.allSettled(
    eligibleCandidates.map((candidate) =>
      approveWorkflowRun(octokit, owner, repo, candidate.runId)
    )
  );
}

function logTargetScope(config) {
  console.log("Automatic workflow approval");
  if (config.targetPrNumber) {
    console.log(`PR: #${config.targetPrNumber}`);
  }
  if (config.targetHeadSha) {
    console.log(`Head SHA: ${config.targetHeadSha}`);
  }
}

function countDispositions(candidates) {
  return {
    eligible: candidates.filter((candidate) => candidate.disposition === "eligible").length,
    skipped: candidates.filter((candidate) => candidate.disposition === "manual_required").length,
    ignored: candidates.filter((candidate) => candidate.disposition === "unrelated").length,
  };
}

function logSummary(candidates, successful, failures) {
  const counts = countDispositions(candidates);
  console.log("Approval summary:");
  console.log(`  candidates discovered: ${candidates.length}`);
  console.log(`  eligible: ${counts.eligible}`);
  console.log(`  approved: ${successful.length}`);
  console.log(`  skipped: ${counts.skipped}`);
  console.log(`  ignored: ${counts.ignored}`);
  console.log(`  failed: ${failures.length}`);
}

function logFailureWarnings(failures) {
  for (const failure of failures) {
    const error = failure.reason;
    const requestUrl = error.request?.url;
    if (requestUrl) {
      console.log(
        `Warning: failed to approve run - ${requestUrl} - HTTP ${error.status}`
      );
    } else {
      console.log(`Warning: failed to approve run - ${error.message}`);
    }
  }
}

function handleApprovalFailures(failures, approvedCount) {
  if (failures.length === 0) {
    return;
  }
  logFailureWarnings(failures);
  if (approvedCount === 0) {
    core.setFailed(`All ${failures.length} approval(s) failed`);
    return;
  }
  console.log(`Approved ${approvedCount} run(s), ${failures.length} failed`);
}

function handleActionError(error) {
  if (error.request?.url) {
    core.setFailed(
      `Error fetching ${error.request.url} - HTTP ${error.status}`
    );
    return;
  }
  core.setFailed(error.message);
}

async function action() {
  try {
    const config = parseConfiguration();
    const octokit = github.getOctokit(config.token);

    const { data: runs } = await octokit.rest.actions.listWorkflowRunsForRepo({
      owner: config.owner,
      repo: config.repo,
      status: "action_required",
    });

    if (runs.total_count === 0) {
      console.log("No runs found with status 'action_required'");
      return;
    }

    const nameToWorkflow = await loadWorkflowNames(octokit, config);
    const matchingRuns = filterRunsByWorkflows(
      runs.workflow_runs,
      config.workflows,
      nameToWorkflow
    );

    if (matchingRuns.length === 0) {
      console.log(
        `No runs found for the following workflows: ${config.workflows.join(", ")}`
      );
      return;
    }

    logTargetScope(config);

    const candidates = [];
    for (const run of matchingRuns) {
      candidates.push(
        await classifyCandidate(octokit, config, run, nameToWorkflow)
      );
    }

    const eligibleCandidates = candidates.filter(
      (candidate) => candidate.disposition === "eligible"
    );

    const results = await executeApprovals(
      octokit,
      config.owner,
      config.repo,
      eligibleCandidates
    );

    const failures = results.filter((result) => result.status === "rejected");
    const successful = results.filter((result) => result.status === "fulfilled");

    logSummary(candidates, successful, failures);

    if (eligibleCandidates.length === 0) {
      console.log("No eligible workflow runs require API approval.");
      return;
    }

    handleApprovalFailures(failures, successful.length);
  } catch (error) {
    handleActionError(error);
  }
}

if (require.main === module) {
  action();
}

module.exports = action;
