# Direct Sandbox Provider & Unconstrained Agent Skills Architecture Design

## 1. Background & Context
TrueForge was architected with a strict assumption: all agent skill materialization (cloning git repositories, unpacking registry artifacts) and code execution must take place inside an isolated sandbox environment. In upstream TrueForge, the only supported production sandbox provider is **Daytona** (`https://www.daytona.io`).

Consequently, upstream TrueForge introduced several tight architectural couplings:
1. **Capabilities Gate**: `GET /api/v1/capabilities` reports `skill: { enabled: false }` unless a Daytona provider is configured and its snapshot image build status is `ready`.
2. **UI Gate**: The agent configuration drawer (`AgentConfigPanel.tsx`) disables the skill picker with `"Skills require an available sandbox."` if `capabilities.skill.enabled` is false.
3. **Validation Gate**: Creating or updating an agent with skills or running a turn with skills throws HTTP 422 (`skills require a sandbox provider — configure via PUT /settings/sandbox-providers`) if no sandbox provider is configured in the database.
4. **Turn Execution Gate**: `specWantsSandbox` in `TurnResourceResolver.ts` only activates the sandbox if `spec.config.sandbox.enabled` is explicitly `true`. If `false`, `Sandbox` is never instantiated, meaning skills are neither downloaded nor mounted, and their instructions are omitted from the LLM prompt.
5. **SRT Restrictions**: An experimental `LocalSandboxProvider` exists in standalone mode, but it wraps execution in Anthropic's Sandbox Runtime (`@anthropic-ai/sandbox-runtime`), requiring bubblewrap (`bwrap`), socat, seccomp filters, strict network domain whitelisting (PyPI/GitHub only), loopback network denial (`127.0.0.1`), and seatbelt filesystem jails.

In a deployment where the entire TrueForge environment runs within its own dedicated microVM (e.g. Firecracker or Cloud Hypervisor), **the microVM itself is the security boundary**. Imposing Daytona requirements, external sandbox API keys, or nested container jails (bubblewrap) creates unnecessary operational complexity, failure modes, and unneeded restrictions.

## 2. Goals & Non-Goals
### Goals
- **Native Direct Execution**: Provide a first-class `DirectSandboxProvider` that executes commands directly within the host environment (microVM) using standard OS processes (`/bin/sh` or `/bin/bash`, `python3`), without Daytona, bubblewrap, or proxy restrictions.
- **Zero-Config Default**: Automatically default to `DirectSandboxProvider` when no external provider is explicitly configured, enabling skills and code execution out of the box with zero setup steps.
- **Remove Sandbox Constraint for Skills**:
  - Update `GET /capabilities` to report `skill: { enabled: true }` and `sandbox: { enabled: true }` by default.
  - Update `validateManifest` so agents with skills are not rejected when Daytona is not configured.
  - Ensure agents with skills automatically resolve the sandbox execution environment without requiring manual toggling of `sandbox.enabled`.
- **Full Compatibility with Existing Skill Ecosystem**:
  - Support existing git skills and registry skills via `skill_downloader.py`.
  - Support Code Mode execution using local Unix Domain Sockets (`CodeModeUdsTransport`).
  - Pass the canonical `runSandboxProviderContractSuite` to ensure interface invariants are preserved.

### Non-Goals
- Removing Daytona support (Daytona remains an optional configurable provider for environments that still want it).
- Changing the agent LLM prompt syntax for `<skills>` or `<skill>`.

## 3. System Architecture & Components

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                            MicroVM Environment                              │
│                                                                             │
│  ┌───────────────────────────┐         ┌─────────────────────────────────┐  │
│  │   TrueForge HTTP / APIs   │         │      DirectSandboxProvider      │  │
│  │                           │         │                                 │  │
│  │  /capabilities ───────────┼────────▶│  Always reports status: ready   │  │
│  │  /sessions & /turns ──────┼────────▶│  Default provider if DB empty   │  │
│  └───────────────────────────┘         └────────────────┬────────────────┘  │
│                                                         │                   │
│                                    ┌────────────────────┴───────────────┐   │
│                                    │ Direct Execution Engine            │   │
│                                    │  - spawn(/bin/sh, [-c, command])   │   │
│                                    │  - direct node:fs/promises I/O     │   │
│                                    │  - CodeModeUdsTransport (UDS)      │   │
│                                    └────────────────────┬───────────────┘   │
│                                                         │                   │
│                                                         ▼                   │
│                        ┌──────────────────────────────────────────────────┐ │
│                        │ Workspace: <sandboxRootDir>/<sandboxId>/         │ │
│                        │   ├── skills/      (git clones / registry tars)  │ │
│                        │   ├── uploads/     (user file uploads)           │ │
│                        │   ├── tool-dumps/  (large tool response dumps)   │ │
│                        │   └── .venv/       (shared python virtualenv)    │ │
│                        └──────────────────────────────────────────────────┘ │
└─────────────────────────────────────────────────────────────────────────────┘
```

### Component Details

#### 1. `DirectSandboxProvider` (`packages/trueforge-core`)
Located at `packages/trueforge-core/src/core/sandbox/provider/DirectSandboxProvider.ts`.
Implements `SandboxProvider`:
- `readonly type = 'direct'`
- `buildImage(): Promise<SandboxBuild>`: Immediately returns `{ status: 'ready', reason: null, metadata: null }`.
- `getImageBuildStatus(): Promise<SandboxBuild>`: Immediately returns `{ status: 'ready', reason: null, metadata: null }`.
- `createSandbox()`: Generates a unique sandbox ID and creates the directory structure (`skills/`, `uploads/`, `tool-dumps/`).
- `exec(params: SandboxExecParams)`: Runs commands via `node:child_process.spawn('/bin/sh', ['-c', params.command], { cwd, env })`. Supports process-group termination on timeout and caps buffered output at 14 MB.
- `uploadFile(params)`: Writes buffer to destination path after creating parent directories.
- `downloadFile(params)`: Reads buffer from destination path, throwing standard errors (`SandboxFileNotFoundError`, `SandboxPathIsDirectoryError`, `SandboxFileTooLargeError`).
- `createCodeModeTransport()`: Instantiates `CodeModeUdsTransport` for Unix domain socket IPC with MCP clients.
- `getSkillsDir()`, `getSkillDownloaderPath()`, `getFileUploadsDir()`, `getToolResultDumpDir()`, `getGitCredentialsPath()`: Return paths scoped under the sandbox directory.
- Python environment: Initializes and caches a lightweight virtualenv containing `pydantic` under `<sandboxRootDir>/.venv` for `skill_downloader.py`.

#### 2. Configuration & Runtime Resolution (`packages/trueforge`)
- `packages/trueforge/src/config.ts`:
  - `DIRECT_SANDBOX_ROOT_DIR`: Parent directory for direct sandboxes (defaults to `~/.local/share/trueforge/sandboxes` or `/tmp/trueforge-sandboxes`).
  - `DIRECT_SANDBOX_ENABLED`: Defaults to `true`.
- `packages/trueforge/src/runtime/sessionResources.ts`:
  - In `resolveSandboxProvider`: If no provider row is found in `sandboxProviderStore`, return an instance of `DirectSandboxProvider`.
  - In `validateManifest`: Do not reject agents requesting skills when `DirectSandboxProvider` is available.
- `packages/trueforge/src/apis/capabilities.ts`:
  - When direct sandbox is enabled (default), report `sandbox: { enabled: true }` and `skill: { enabled: true }`.
- `packages/trueforge/src/apis/turns.ts`:
  - Only execute Daytona snapshot checks (`checkSnapshotStatus`) when `provider.type === 'daytona'`.
- `packages/trueforge-core/src/agent-session/TurnResourceResolver.ts`:
  - Update `specWantsSandbox` to check `spec.config.sandbox.enabled || (spec.skills !== undefined && spec.skills.length > 0)`.

#### 3. Schemas & Catalog
- `packages/trueforge/src/schemas/sandboxProvider.ts`:
  - Add `DirectSandboxProviderSchema` (`type: 'direct'`, `exec_timeout_ms`).
  - Include in `SandboxProviderManifestSchema` and `StoredSandboxProviderManifestSchema`.
- `packages/trueforge/catalog/sandbox-catalog.yaml`:
  - Add `direct` preset.

## 4. Verification Plan
- **Contract Tests**: Add `packages/trueforge-core/tests/core/sandbox/provider/directProvider.contract.test.ts` running `runSandboxProviderContractSuite`.
- **Runtime Tests**: Add unit tests in `packages/trueforge/tests/unit/runtime/sessionResources.test.ts` verifying auto-defaulting to direct provider and skill validation without Daytona.
- **Capabilities Tests**: Verify `GET /capabilities` reports `skill.enabled: true` with no provider configured in database.
- **End-to-End Skill Execution Test**: Verify mounting and running a git skill through `DirectSandboxProvider`.
