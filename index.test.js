const core = require("@actions/core");
const github = require("@actions/github");
const yaml = require("js-yaml");
const action = require("./index");

process.env.GITHUB_REPOSITORY = "demo/repo";

let mockOctokit;
const _workflowContents = {};

beforeEach(() => {
  mockOctokit = {
    rest: {
      actions: {
        listWorkflowRunsForRepo: jest.fn(),
      },
      repos: {
        getContent: jest.fn(),
      },
      pulls: {
        list: jest.fn(),
        listFiles: jest.fn(),
      },
    },
    request: jest.fn(),
  };
  jest.spyOn(github, "getOctokit").mockReturnValue(mockOctokit);
});

afterEach(() => {
  jest.restoreAllMocks();
  Object.keys(_workflowContents).forEach((k) => delete _workflowContents[k]);
});

it("throws if no token is provided", async () => {
  // Don't mock any inputs — token will be missing
  mockInput({});
  jest.spyOn(core, "setFailed").mockImplementation(() => {});
  await action();
  expect(core.setFailed).toBeCalledWith(
    "Input required and not supplied: token"
  );
});

it("throws if no workflow list is provided", async () => {
  mockInput({ token: "my-token" });
  jest.spyOn(core, "setFailed").mockImplementation(() => {});
  await action();
  expect(core.setFailed).toBeCalledWith(
    "Input required and not supplied: workflows"
  );
});

it("returns early if there are no runs with action required", async () => {
  mockInput({ token: "my-token", workflows: "pr.yml,another.yml" });
  jest.spyOn(console, "log").mockImplementation(() => {});

  mockOctokit.rest.actions.listWorkflowRunsForRepo.mockResolvedValue({
    data: { total_count: 0, workflow_runs: [] },
  });

  await action();
  expect(console.log).toBeCalledWith(
    "No runs found with status 'action_required'"
  );
});

it("returns early if there are no runs that match the provided workflow", async () => {
  mockInput({ token: "my-token", workflows: "pr.yml,another.yml" });
  jest.spyOn(console, "log").mockImplementation(() => {});

  mockOctokit.rest.actions.listWorkflowRunsForRepo.mockResolvedValue({
    data: {
      total_count: 1,
      workflow_runs: [{ name: ".github/workflows/other-workflow.yml", id: "12345678" }],
    },
  });
  mockWorkflowContents("pr.yml", {});
  mockWorkflowContents("another.yml", {});

  await action();
  expect(console.log).toBeCalledWith(
    "No runs found for the following workflows: .github/workflows/pr.yml, .github/workflows/another.yml"
  );
});

it("handles HTTP 500 errors and exits with a failure code", async () => {
  mockInput({ token: "my-token", workflows: "pr.yml,another.yml" });
  jest.spyOn(core, "setFailed").mockImplementation(() => {});

  const error = new Error("server error");
  error.status = 500;
  error.request = { url: "https://api.github.com/repos/demo/repo/actions/runs?status=action_required" };
  mockOctokit.rest.actions.listWorkflowRunsForRepo.mockRejectedValue(error);

  await action();
  expect(core.setFailed).toBeCalledWith(
    "Error fetching https://api.github.com/repos/demo/repo/actions/runs?status=action_required - HTTP 500"
  );
});

it("skips completed runs that cannot be approved", async () => {
  mockInput({ token: "my-token", workflows: "pr.yml,another.yml" });
  jest.spyOn(console, "log").mockImplementation(() => {});

  mockOctokit.rest.actions.listWorkflowRunsForRepo.mockResolvedValue({
    data: {
      total_count: 1,
      workflow_runs: [
        {
          name: ".github/workflows/pr.yml",
          id: "12345678",
          status: "completed",
          head_branch: "patch-1",
          head_repository: { owner: { login: "user-a" } },
        },
      ],
    },
  });
  mockWorkflowContents("pr.yml", {});
  mockWorkflowContents("another.yml", {});

  await action();
  expect(console.log).toBeCalledWith(
    "Skipping completed run '12345678' (cannot approve completed runs)"
  );
});

it("continues approving other runs when one fails with 403", async () => {
  mockInput({ token: "my-token", workflows: "pr.yml,another.yml" });
  jest.spyOn(console, "log").mockImplementation(() => {});

  mockOctokit.rest.actions.listWorkflowRunsForRepo.mockResolvedValue({
    data: {
      total_count: 2,
      workflow_runs: [
        {
          name: ".github/workflows/pr.yml",
          id: "11111111",
          status: "waiting",
          head_branch: "patch-1",
          head_repository: { owner: { login: "user-a" } },
        },
        {
          name: ".github/workflows/pr.yml",
          id: "22222222",
          status: "waiting",
          head_branch: "patch-2",
          head_repository: { owner: { login: "user-b" } },
        },
      ],
    },
  });
  mockWorkflowContents("pr.yml", {});
  mockWorkflowContents("another.yml", {});

  mockOctokit.rest.pulls.list
    .mockResolvedValueOnce({ data: [{ number: 99 }] })
    .mockResolvedValueOnce({ data: [{ number: 42 }] });
  mockOctokit.rest.pulls.listFiles
    .mockResolvedValueOnce({ data: [{ filename: "README.md" }] })
    .mockResolvedValueOnce({ data: [{ filename: "README.md" }] });

  const error403 = new Error("Forbidden");
  error403.status = 403;
  error403.request = { url: "https://api.github.com/repos/demo/repo/actions/runs/11111111/approve" };
  mockOctokit.request
    .mockRejectedValueOnce(error403)
    .mockResolvedValueOnce({});

  await action();
  expect(console.log).toBeCalledWith("Approved run '22222222'");
  expect(console.log).toBeCalledWith(
    expect.stringContaining("Warning: failed to approve run")
  );
});

it("removes any runs that edit .github/workflows", async () => {
  mockInput({ token: "my-token", workflows: "pr.yml,another.yml" });
  jest.spyOn(console, "log").mockImplementation(() => {});

  mockOctokit.rest.actions.listWorkflowRunsForRepo.mockResolvedValue({
    data: {
      total_count: 2,
      workflow_runs: [
        {
          name: ".github/workflows/pr.yml",
          id: "12345678",
          head_branch: "patch-1",
          head_repository: { owner: { login: "user-a" } },
        },
        {
          name: ".github/workflows/pr.yml",
          id: "87654321",
          head_branch: "totally-honest-update-no-miners-here",
          head_repository: { owner: { login: "bad-actor" } },
        },
      ],
    },
  });
  mockWorkflowContents("pr.yml", {});
  mockWorkflowContents("another.yml", {});

  mockOctokit.rest.pulls.list
    .mockResolvedValueOnce({ data: [{ number: 99 }] })
    .mockResolvedValueOnce({ data: [{ number: 321 }] });
  mockOctokit.rest.pulls.listFiles
    .mockResolvedValueOnce({ data: [{ filename: "README.md" }] })
    .mockResolvedValueOnce({ data: [{ filename: ".github/workflows/miner.yml" }] });

  mockOctokit.request.mockResolvedValue({});

  await action();
  expect(console.log).toBeCalledWith("Skipped dangerous run '87654321'");
  expect(console.log).toBeCalledWith("Approved run '12345678'");
});

it("removes any runs that edit a file in dangerous_files", async () => {
  mockInput({ token: "my-token", workflows: "pr.yml,another.yml", dangerous_files: "build.js" });
  jest.spyOn(console, "log").mockImplementation(() => {});

  mockOctokit.rest.actions.listWorkflowRunsForRepo.mockResolvedValue({
    data: {
      total_count: 1,
      workflow_runs: [
        {
          name: ".github/workflows/pr.yml",
          id: "12345678",
          head_branch: "patch-1",
          head_repository: { owner: { login: "z-user" } },
        },
      ],
    },
  });
  mockWorkflowContents("pr.yml", {});
  mockWorkflowContents("another.yml", {});

  mockOctokit.rest.pulls.list.mockResolvedValue({ data: [{ number: 1713 }] });
  mockOctokit.rest.pulls.listFiles.mockResolvedValue({
    data: [{ filename: "README.md" }, { filename: "build.js" }],
  });

  await action();
  expect(console.log).toBeCalledWith("Skipped dangerous run '12345678'");
});

it("removes any runs that edit a file outside safe_files", async () => {
  mockInput({ token: "my-token", workflows: "pr.yml,another.yml", safe_files: "docs/" });
  jest.spyOn(console, "log").mockImplementation(() => {});

  mockOctokit.rest.actions.listWorkflowRunsForRepo.mockResolvedValue({
    data: {
      total_count: 1,
      workflow_runs: [
        {
          name: ".github/workflows/pr.yml",
          id: "12345678",
          head_branch: "patch-1",
          head_repository: { owner: { login: "z-user" } },
        },
      ],
    },
  });
  mockWorkflowContents("pr.yml", {});
  mockWorkflowContents("another.yml", {});

  mockOctokit.rest.pulls.list.mockResolvedValue({ data: [{ number: 1713 }] });
  mockOctokit.rest.pulls.listFiles.mockResolvedValue({
    data: [{ filename: "build.js" }, { filename: "docs/index.md" }],
  });

  await action();
  expect(console.log).toBeCalledWith("Skipped dangerous run '12345678'");
});

it("approves any runs that edit a file inside safe_files", async () => {
  mockInput({ token: "my-token", workflows: "pr.yml,another.yml", safe_files: "docs/" });
  jest.spyOn(console, "log").mockImplementation(() => {});

  mockOctokit.rest.actions.listWorkflowRunsForRepo.mockResolvedValue({
    data: {
      total_count: 1,
      workflow_runs: [
        {
          name: ".github/workflows/pr.yml",
          id: "12345678",
          head_branch: "patch-1",
          head_repository: { owner: { login: "z-user" } },
        },
      ],
    },
  });
  mockWorkflowContents("pr.yml", {});
  mockWorkflowContents("another.yml", {});

  mockOctokit.rest.pulls.list.mockResolvedValue({ data: [{ number: 1713 }] });
  mockOctokit.rest.pulls.listFiles.mockResolvedValue({
    data: [{ filename: "docs/asdf.md" }, { filename: "docs/index.md" }],
  });
  mockOctokit.request.mockResolvedValue({});

  await action();
  expect(console.log).toBeCalledWith("Approved run '12345678'");
});

it("approves all pending workflows (no name)", async () => {
  mockInput({ token: "my-token", workflows: "pr.yml,another.yml" });
  jest.spyOn(console, "log").mockImplementation(() => {});

  mockWorkflowContents("pr.yml", {});
  mockWorkflowContents("another.yml", {});

  mockOctokit.rest.actions.listWorkflowRunsForRepo.mockResolvedValue({
    data: {
      total_count: 2,
      workflow_runs: [
        {
          name: ".github/workflows/pr.yml",
          id: "12345678",
          head_branch: "patch-1",
          head_repository: { owner: { login: "user-a" } },
        },
        {
          name: ".github/workflows/pr.yml",
          id: "87654321",
          head_branch: "update-readme",
          head_repository: { owner: { login: "user-b" } },
        },
      ],
    },
  });

  mockOctokit.rest.pulls.list
    .mockResolvedValueOnce({ data: [{ number: 99 }] })
    .mockResolvedValueOnce({ data: [{ number: 42 }] });
  mockOctokit.rest.pulls.listFiles
    .mockResolvedValueOnce({ data: [{ filename: "README.md" }] })
    .mockResolvedValueOnce({ data: [{ filename: "README.md" }] });
  mockOctokit.request.mockResolvedValue({});

  await action();
  expect(console.log).toBeCalledWith("Approved run '12345678'");
  expect(console.log).toBeCalledWith("Approved run '87654321'");
});

it("approves all pending workflows (with name)", async () => {
  mockInput({ token: "my-token", workflows: "pr.yml,another.yml" });
  jest.spyOn(console, "log").mockImplementation(() => {});

  mockWorkflowContents("pr.yml", { name: "Run Tests" });
  mockWorkflowContents("another.yml", { name: "Do Another Thing" });

  mockOctokit.rest.actions.listWorkflowRunsForRepo.mockResolvedValue({
    data: {
      total_count: 2,
      workflow_runs: [
        {
          name: "Run Tests",
          id: "12345678",
          head_branch: "patch-1",
          head_repository: { owner: { login: "user-a" } },
        },
        {
          name: "Do Another Thing",
          id: "87654321",
          head_branch: "update-readme",
          head_repository: { owner: { login: "user-b" } },
        },
      ],
    },
  });

  mockOctokit.rest.pulls.list
    .mockResolvedValueOnce({ data: [{ number: 99 }] })
    .mockResolvedValueOnce({ data: [{ number: 42 }] });
  mockOctokit.rest.pulls.listFiles
    .mockResolvedValueOnce({ data: [{ filename: "README.md" }] })
    .mockResolvedValueOnce({ data: [{ filename: "README.md" }] });
  mockOctokit.request.mockResolvedValue({});

  await action();
  expect(console.log).toBeCalledWith("Approved run '12345678'");
  expect(console.log).toBeCalledWith("Approved run '87654321'");
});

// --- Helpers ---

function mockInput(inputs) {
  const defaults = { token: "", workflows: "", dangerous_files: "", safe_files: "" };
  const merged = { ...defaults, ...inputs };
  jest.spyOn(core, "getInput").mockImplementation((name, opts) => {
    const val = merged[name] || "";
    if (opts?.required && !val) {
      throw new Error(`Input required and not supplied: ${name}`);
    }
    return val;
  });
}

function mockWorkflowContents(name, content) {
  content = { on: "push", jobs: [], ...content };
  _workflowContents[`.github/workflows/${name}`] = content;
  mockOctokit.rest.repos.getContent.mockImplementation(async ({ path }) => {
    const wf = _workflowContents[path];
    if (wf) {
      return {
        data: { content: Buffer.from(yaml.dump(wf)).toString("base64") },
      };
    }
    throw new Error(`No mock for ${path}`);
  });
}
