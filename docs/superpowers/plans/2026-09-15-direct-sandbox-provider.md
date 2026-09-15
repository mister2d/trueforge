# Direct Sandbox Provider Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Remove the architectural constraint requiring Daytona for agent skills by introducing a zero-config native `DirectSandboxProvider` that executes skills and commands directly inside the host microVM environment.

**Architecture:** Implement `DirectSandboxProvider` adhering to the core `SandboxProvider` contract using standard Node.js `child_process` and local filesystem I/O. Make `DirectSandboxProvider` the zero-config fallback in `resolveSandboxProvider`, update capabilities and validation so agent skills are enabled out-of-the-box, and ensure agents with skills automatically activate sandbox execution.

**Tech Stack:** TypeScript, Node.js (`node:child_process`, `node:fs/promises`, `node:path`), Zod, Hono OpenAPI, Jest.

**Spec:** [2026-09-15-direct-sandbox-provider-design.md](file:///home/agent/workspace/trueforge/docs/superpowers/specs/2026-09-15-direct-sandbox-provider-design.md)

## Global Constraints

- TypeScript code MUST NOT use assertion escapes (`as T`, `as unknown as T`, `!`, `as never`).
- When catching an error and throwing another, preserve `{ cause: caught }`.
- Static `import` and `import type` only; no `require()` or `require.resolve()`.
- HTTP/OpenAPI wire shapes and database identifiers MUST use `snake_case`.
- Environment variable reads MUST go through `packages/trueforge/src/config.ts`.
- Tests MUST live under package top-level `test` or `tests` directory mirroring `src`.
- Do NOT edit `.github/fern/openapi/openapi.json`, `docs/openapi.json`, or SDK packages manually.
- Published packages changes require a changeset in `.changeset/*.md`.

---

### Task 1: DirectSandboxProvider in `packages/trueforge-core`

**Files:**

- Create: `packages/trueforge-core/src/core/sandbox/provider/DirectSandboxProvider.ts`
- Modify: `packages/trueforge-core/src/core/index.ts:160-185`
- Test: `packages/trueforge-core/tests/core/sandbox/provider/directProvider.contract.test.ts`

**Interfaces:**

- Consumes: `SandboxProvider`, `SandboxExecParams`, `ExecResult`, `SandboxBuild`, `CodeModeTransport` from `packages/trueforge-core/src/core/sandbox/provider/Provider.ts`.
- Produces: `DirectSandboxProvider`, `DirectSandboxProviderOptions`.

- [ ] **Step 1: Write the failing contract test**

```typescript
// packages/trueforge-core/tests/core/sandbox/provider/directProvider.contract.test.ts
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DirectSandboxProvider } from '../../../../src/core/sandbox/provider/DirectSandboxProvider';
import { createSilentLogger } from '../../../../src/util/silentLogger';
import { runSandboxProviderContractSuite } from './sandboxProviderContractSuite';

describe('DirectSandboxProvider (SandboxProvider contract)', () => {
  let rootDir: string | undefined;

  runSandboxProviderContractSuite(async () => {
    rootDir = await mkdtemp(join(tmpdir(), 'tfy-direct-contract-'));
    const provider = new DirectSandboxProvider({
      sandboxRootDir: rootDir,
      logger: createSilentLogger(),
    });
    return {
      provider,
      dispose: async () => {
        if (rootDir !== undefined) {
          await rm(rootDir, { recursive: true, force: true });
        }
      },
    };
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @truefoundry/trueforge-core test tests/core/sandbox/provider/directProvider.contract.test.ts`
Expected: FAIL with "Cannot find module DirectSandboxProvider"

- [ ] **Step 3: Write minimal implementation of DirectSandboxProvider**

```typescript
// packages/trueforge-core/src/core/sandbox/provider/DirectSandboxProvider.ts
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { isAbsolute, join, resolve, sep } from 'node:path';
import type { Logger } from 'winston';
import {
  SandboxFileNotFoundError,
  SandboxFileTooLargeError,
  SandboxNotAvailableError,
  SandboxPathIsDirectoryError,
  validateNoPathTraversal,
} from '../SandboxErrors';
import type { CodeModeTransport } from '../codeMode/CodeModeTransport';
import type { ExecResult, SandboxBuild, SandboxExecParams, SandboxProvider } from './Provider';

const DEFAULT_EXEC_TIMEOUT_SECONDS = 60;
const DEFAULT_FILE_MAX_BYTES = 10 * 1024 * 1024;
const MAX_OUTPUT_BYTES = 14 * 1024 * 1024;

export interface DirectSandboxProviderOptions {
  sandboxRootDir: string;
  defaultExecTimeoutSeconds?: number | undefined;
  fileMaxBytesForDownload?: number | undefined;
  logger: Logger;
  shell?: string | undefined;
  python?: string | undefined;
}

export class DirectSandboxProvider implements SandboxProvider {
  readonly type = 'direct';
  private readonly sandboxRootDir: string;
  private readonly defaultExecTimeoutSeconds: number;
  private readonly fileMaxBytesForDownload: number;
  private readonly logger: Logger;
  private readonly shell: string;
  private readonly python: string;

  static readonly readyBuild: SandboxBuild = {
    status: 'ready',
    reason: null,
    metadata: null,
  };

  constructor(options: DirectSandboxProviderOptions) {
    this.sandboxRootDir = resolve(options.sandboxRootDir);
    this.defaultExecTimeoutSeconds = options.defaultExecTimeoutSeconds ?? DEFAULT_EXEC_TIMEOUT_SECONDS;
    this.fileMaxBytesForDownload = options.fileMaxBytesForDownload ?? DEFAULT_FILE_MAX_BYTES;
    this.logger = options.logger.child({ module: 'DirectSandboxProvider' });
    this.shell = options.shell ?? '/bin/sh';
    this.python = options.python ?? 'python3';
  }

  buildImage(): Promise<SandboxBuild> {
    return Promise.resolve(DirectSandboxProvider.readyBuild);
  }

  getImageBuildStatus(): Promise<SandboxBuild> {
    return Promise.resolve(DirectSandboxProvider.readyBuild);
  }

  async createSandbox(): Promise<{ sandboxId: string }> {
    const sandboxId = `sb_${Date.now()}_${Math.random().toString(36).slice(2, 9)}`;
    const sandboxDir = join(this.sandboxRootDir, sandboxId);
    await mkdir(join(sandboxDir, 'skills'), { recursive: true });
    await mkdir(join(sandboxDir, 'uploads'), { recursive: true });
    await mkdir(join(sandboxDir, 'tool-dumps'), { recursive: true });
    return { sandboxId };
  }

  private resolveSandboxPath(sandboxId: string, userPath: string): string {
    validateNoPathTraversal(userPath);
    const sandboxDir = join(this.sandboxRootDir, sandboxId);
    const resolved = userPath.startsWith('/') ? resolve(userPath) : resolve(sandboxDir, userPath);
    if (resolved !== sandboxDir && !resolved.startsWith(sandboxDir + sep)) {
      throw new SandboxFileNotFoundError(userPath);
    }
    return resolved;
  }

  async exec(params: SandboxExecParams): Promise<ExecResult> {
    const sandboxDir = join(this.sandboxRootDir, params.sandboxId);
    if (!existsSync(sandboxDir)) {
      return { success: false, error: `Sandbox directory not found: ${params.sandboxId}` };
    }
    const cwd = params.cwd ? this.resolveSandboxPath(params.sandboxId, params.cwd) : sandboxDir;
    const timeoutMs = (params.timeoutSeconds ?? this.defaultExecTimeoutSeconds) * 1000;

    return new Promise<ExecResult>(resolveExec => {
      const child = spawn(this.shell, ['-c', params.command], {
        cwd,
        env: {
          ...process.env,
          ...(params.env ?? {}),
          TFY_SKILLS_DIR: join(sandboxDir, 'skills'),
        },
        detached: true,
      });

      let stdoutText = '';
      let stderrText = '';
      let timedOut = false;

      const timer = setTimeout(() => {
        timedOut = true;
        if (child.pid !== undefined) {
          try {
            process.kill(-child.pid, 'SIGKILL');
          } catch {
            child.kill('SIGKILL');
          }
        }
      }, timeoutMs);

      child.stdout?.on('data', (chunk: Buffer) => {
        if (stdoutText.length < MAX_OUTPUT_BYTES) {
          stdoutText += chunk.toString('utf8');
        }
      });

      child.stderr?.on('data', (chunk: Buffer) => {
        if (stderrText.length < MAX_OUTPUT_BYTES) {
          stderrText += chunk.toString('utf8');
        }
      });

      child.on('error', err => {
        clearTimeout(timer);
        resolveExec({ success: false, error: err.message });
      });

      child.on('close', code => {
        clearTimeout(timer);
        if (timedOut) {
          resolveExec({ success: false, error: `Execution timed out after ${timeoutMs / 1000}s` });
          return;
        }
        resolveExec({
          success: true,
          response: {
            exitCode: code ?? 0,
            result: (stdoutText + stderrText).slice(0, MAX_OUTPUT_BYTES),
          },
        });
      });
    });
  }

  getAdditionalInstructions(): string | undefined {
    return undefined;
  }

  getToolResultDumpDir(sandboxId: string): string {
    return join(this.sandboxRootDir, sandboxId, 'tool-dumps');
  }

  getGitCredentialsPath(sandboxId: string): string {
    return join(this.sandboxRootDir, sandboxId, '.git-credentials');
  }

  getFileUploadsDir(sandboxId: string): string {
    return join(this.sandboxRootDir, sandboxId, 'uploads');
  }

  getSkillsDir(sandboxId: string): string {
    return join(this.sandboxRootDir, sandboxId, 'skills');
  }

  getSkillDownloaderPath(sandboxId: string): string {
    return join(this.sandboxRootDir, sandboxId, 'skills', 'skill_downloader.py');
  }

  async downloadFile(params: { sandboxId: string; path: string }): Promise<Buffer> {
    const fullPath = this.resolveSandboxPath(params.sandboxId, params.path);
    try {
      const stats = await stat(fullPath);
      if (stats.isDirectory()) {
        throw new SandboxPathIsDirectoryError(params.path);
      }
      if (stats.size > this.fileMaxBytesForDownload) {
        throw new SandboxFileTooLargeError(params.path, stats.size, this.fileMaxBytesForDownload);
      }
      return await readFile(fullPath);
    } catch (error) {
      if (error instanceof SandboxPathIsDirectoryError || error instanceof SandboxFileTooLargeError) {
        throw error;
      }
      throw new SandboxFileNotFoundError(params.path);
    }
  }

  async uploadFile(params: { sandboxId: string; remotePath: string; content: Buffer }): Promise<void> {
    const fullPath = this.resolveSandboxPath(params.sandboxId, params.remotePath);
    await mkdir(resolve(fullPath, '..'), { recursive: true });
    await writeFile(fullPath, params.content);
  }

  createCodeModeTransport(): CodeModeTransport {
    throw new Error('Code Mode transport for DirectSandboxProvider requires CodeModeUdsTransport configuration');
  }
}
```

- [ ] **Step 4: Export DirectSandboxProvider in `packages/trueforge-core/src/core/index.ts`**

- [ ] **Step 5: Run tests to verify they pass**

Run: `pnpm --filter @truefoundry/trueforge-core test tests/core/sandbox/provider/directProvider.contract.test.ts`
Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add packages/trueforge-core/src/core/sandbox/provider/DirectSandboxProvider.ts \
        packages/trueforge-core/src/core/index.ts \
        packages/trueforge-core/tests/core/sandbox/provider/directProvider.contract.test.ts
git commit -m "feat(core): add DirectSandboxProvider adhering to SandboxProvider contract"
```

---

### Task 2: Schema, Catalog & Provider Construction in `packages/trueforge`

**Files:**

- Modify: `packages/trueforge/src/schemas/sandboxProvider.ts:1-75`
- Modify: `packages/trueforge/catalog/sandbox-catalog.yaml:1-10`
- Modify: `packages/trueforge/src/sandbox/providerUtils.ts:60-95`
- Test: `packages/trueforge/tests/unit/schemas/sandboxProvider.test.ts`

**Interfaces:**

- Consumes: `DirectSandboxProvider` from `@truefoundry/trueforge-core/core`.
- Produces: `DirectSandboxProviderSchema`, updated `SandboxProviderManifestSchema`, updated `toSandboxProviderFromRecord`.

- [ ] **Step 1: Write the failing schema test**

Add a test case in `packages/trueforge/tests/unit/schemas/sandboxProvider.test.ts` verifying that `SandboxProviderManifestSchema.parse({ type: 'direct', exec_timeout_ms: 60000 })` succeeds.

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @truefoundry/trueforge test tests/unit/schemas/sandboxProvider.test.ts`
Expected: FAIL (invalid discriminator value 'direct')

- [ ] **Step 3: Update schemas and catalog**

In `packages/trueforge/src/schemas/sandboxProvider.ts`:

```typescript
export const DirectSandboxProviderSchema = z
  .object({
    type: z.literal('direct').describe('Direct host microVM sandbox provider.'),
    exec_timeout_ms: z
      .number()
      .int()
      .positive()
      .optional()
      .default(60000)
      .describe('Default sandbox command exec timeout in milliseconds.'),
  })
  .strict()
  .openapi('DirectSandboxProvider');

export const SandboxProviderManifestSchema = z
  .discriminatedUnion('type', [DaytonaSandboxProviderSchema, DirectSandboxProviderSchema])
  .openapi('SandboxProviderManifest');

export const StoredSandboxProviderManifestSchema = z.discriminatedUnion('type', [
  DaytonaSandboxProviderSchema,
  DirectSandboxProviderSchema,
  TrueFoundrySandboxProviderSchema,
]);
```

In `packages/trueforge/catalog/sandbox-catalog.yaml`:

```yaml
providers:
  - type: direct
    exec_timeout_ms: 60000
  - type: daytona
    exec_timeout_ms: 60000
    auto_stop_interval_in_minutes: 5
    auto_archive_interval_in_minutes: 60
    auto_delete_interval_in_minutes: 7200
```

In `packages/trueforge/src/sandbox/providerUtils.ts`:

```typescript
    case 'direct':
      return new DirectSandboxProvider({
        sandboxRootDir: configuration.DIRECT_SANDBOX_ROOT_DIR,
        defaultExecTimeoutSeconds: Math.ceil(record.manifest.exec_timeout_ms / 1000),
        fileMaxBytesForDownload: configuration.SANDBOX_FILE_MAX_BYTES_FOR_DOWNLOAD,
        logger,
      });
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm --filter @truefoundry/trueforge test tests/unit/schemas/sandboxProvider.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add packages/trueforge/src/schemas/sandboxProvider.ts \
        packages/trueforge/catalog/sandbox-catalog.yaml \
        packages/trueforge/src/sandbox/providerUtils.ts \
        packages/trueforge/tests/unit/schemas/sandboxProvider.test.ts
git commit -m "feat(sandbox): add direct provider schema and catalog preset"
```

---

### Task 3: Configuration & Server Environment Setup

**Files:**

- Modify: `packages/trueforge/src/config.ts:460-500,720-760`
- Modify: `packages/trueforge/src/main.ts:590-620`
- Test: `packages/trueforge/tests/unit/config.test.ts` (or add direct sandbox config test)

**Interfaces:**

- Consumes: process environment variables (`DIRECT_SANDBOX_ENABLED`, `DIRECT_SANDBOX_ROOT_DIR`).
- Produces: `configuration.DIRECT_SANDBOX_ENABLED`, `configuration.DIRECT_SANDBOX_ROOT_DIR`.

- [ ] **Step 1: Write the failing config test**

Test that `configuration.DIRECT_SANDBOX_ENABLED` defaults to `true` and `DIRECT_SANDBOX_ROOT_DIR` resolves to a valid absolute path.

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @truefoundry/trueforge test tests/unit/config.test.ts`
Expected: FAIL (property DIRECT_SANDBOX_ENABLED missing)

- [ ] **Step 3: Implement config entries**

In `packages/trueforge/src/config.ts`:

- Define `DIRECT_SANDBOX_ENABLED: boolean;` (parsed with `parseBoolean`, default `true`).
- Define `DIRECT_SANDBOX_ROOT_DIR: string;` (default `path.join(appDataDir, 'sandboxes')`).

In `packages/trueforge/src/main.ts`:

- Ensure `mkdir(configuration.DIRECT_SANDBOX_ROOT_DIR, { recursive: true })` runs at server boot.

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm --filter @truefoundry/trueforge test tests/unit/config.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add packages/trueforge/src/config.ts \
        packages/trueforge/src/main.ts \
        packages/trueforge/tests/unit/config.test.ts
git commit -m "feat(config): add DIRECT_SANDBOX_ENABLED and DIRECT_SANDBOX_ROOT_DIR"
```

---

### Task 4: Runtime Resolution & Capability Un-Gating

**Files:**

- Modify: `packages/trueforge/src/runtime/sessionResources.ts:190-230,310-330`
- Modify: `packages/trueforge/src/apis/capabilities.ts:30-60`
- Modify: `packages/trueforge/src/apis/turns.ts:225-245`
- Test: `packages/trueforge/tests/unit/runtime/sessionResources.test.ts`
- Test: `packages/trueforge/tests/unit/apis/capabilities.test.ts`

**Interfaces:**

- Consumes: `configuration.DIRECT_SANDBOX_ENABLED`, `DirectSandboxProvider`.
- Produces: Zero-config resolution of `DirectSandboxProvider` when database has no provider row; un-gated `capabilities.skill.enabled`.

- [ ] **Step 1: Write failing test in sessionResources.test.ts & capabilities.test.ts**

1. In `capabilities.test.ts`: test that when no provider is configured in the database, `GET /capabilities` returns:
   `skill: { enabled: true }` and `sandbox: { enabled: true }` when `DIRECT_SANDBOX_ENABLED` is true.
2. In `sessionResources.test.ts`: test that `resolveSandboxProvider` returns a `DirectSandboxProvider` instance when no provider record exists in the store.
3. In `sessionResources.test.ts`: test that `validateManifest` with `spec.skills = [{ name: 'git-skill' }]` does NOT throw 422 when `DIRECT_SANDBOX_ENABLED` is true.

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @truefoundry/trueforge test tests/unit/apis/capabilities.test.ts`
Expected: FAIL

- [ ] **Step 3: Implement runtime resolution and un-gating**

In `packages/trueforge/src/runtime/sessionResources.ts`:

- In `resolveSandboxProvider`:
  ```typescript
  const record = await store.getSandboxProvider(tenant_id);
  if (record !== undefined) {
    return toSandboxProviderFromRecord({ record, tenant_id, logger });
  }
  if (configuration.DIRECT_SANDBOX_ENABLED) {
    return new DirectSandboxProvider({
      sandboxRootDir: join(configuration.DIRECT_SANDBOX_ROOT_DIR, localSandboxSessionSegment(sessionId)),
      fileMaxBytesForDownload: configuration.SANDBOX_FILE_MAX_BYTES_FOR_DOWNLOAD,
      logger,
    });
  }
  ```
- In `validateManifest`:
  ```typescript
  if (wantsSandbox || hasSkills) {
    const record = await sandboxProviderStore.getSandboxProvider(tenant_id);
    if (record === undefined && !configuration.DIRECT_SANDBOX_ENABLED && !isLocalSandboxFallbackEnabled()) {
      throw new HTTPException(422, { ... });
    }
  }
  ```

In `packages/trueforge/src/apis/capabilities.ts`:

- Set `sandboxEnabled = status === 'ready' || configuration.DIRECT_SANDBOX_ENABLED || (status === undefined && isLocalSandboxFallbackEnabled());`
- `skill: sandboxEnabled ? { enabled: true } : ...`

In `packages/trueforge/src/apis/turns.ts`:

- `if (carriedSandboxId === undefined && provider.type === 'daytona')` instead of `provider.type !== 'local'` (so direct provider does not wait on snapshot registration).

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm --filter @truefoundry/trueforge test tests/unit/apis/capabilities.test.ts tests/unit/runtime/sessionResources.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add packages/trueforge/src/runtime/sessionResources.ts \
        packages/trueforge/src/apis/capabilities.ts \
        packages/trueforge/src/apis/turns.ts \
        packages/trueforge/tests/unit/runtime/sessionResources.test.ts \
        packages/trueforge/tests/unit/apis/capabilities.test.ts
git commit -m "feat(runtime): default to DirectSandboxProvider and un-gate skills capability"
```

---

### Task 5: Auto-Enable Sandbox Execution for Agents with Skills

**Files:**

- Modify: `packages/trueforge-core/src/agent-session/TurnResourceResolver.ts:28-32`
- Modify: `packages/trueforge-core/src/agent-session/schemas/agentSpec.ts:160-170`
- Test: `packages/trueforge-core/tests/agent-session/TurnResourceResolver.test.ts` (or add test case)

**Interfaces:**

- Consumes: `spec.config.sandbox.enabled`, `spec.skills`.
- Produces: `specWantsSandbox` returns true whenever `sandbox.enabled` is true OR `skills` are defined.

- [ ] **Step 1: Write failing test**

Test that `TurnResourceResolver.resolveSandbox` resolves a sandbox when `spec.config.sandbox.enabled` is `false` but `spec.skills` contains at least one skill.

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @truefoundry/trueforge-core test tests/agent-session/TurnResourceResolver.test.ts`
Expected: FAIL (returns undefined)

- [ ] **Step 3: Update `specWantsSandbox`**

In `packages/trueforge-core/src/agent-session/TurnResourceResolver.ts`:

```typescript
function specWantsSandbox(spec: AgentSpec): boolean {
  return spec.config.sandbox.enabled || (spec.skills !== undefined && spec.skills.length > 0);
}
```

In `packages/trueforge-core/src/agent-session/schemas/agentSpec.ts`:
Update description of `sandbox.enabled`: `'Give the agent a sandbox for arbitrary code execution and Code Mode. Skills automatically provision execution when present.'`

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter @truefoundry/trueforge-core test tests/agent-session/TurnResourceResolver.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add packages/trueforge-core/src/agent-session/TurnResourceResolver.ts \
        packages/trueforge-core/src/agent-session/schemas/agentSpec.ts
git commit -m "feat(agent-session): auto-activate sandbox execution when agent has skills"
```

---

### Task 6: Full Integration Test & Changeset

**Files:**

- Create: `packages/trueforge/tests/unit/sandbox/directExecution.test.ts`
- Create: `.changeset/direct-sandbox-provider.md`

- [ ] **Step 1: Write integration test**

Verify the full path: create session with agent containing skills and direct sandbox provider, resolve resources, execute command, verify file creation and output.

- [ ] **Step 2: Run all test suites across the monorepo**

Run: `pnpm test`
Expected: ALL PASS

- [ ] **Step 3: Create changeset**

```markdown
---
'@truefoundry/trueforge-core': minor
'@truefoundry/trueforge': minor
---

Add native DirectSandboxProvider for unconstrained host execution in microVM environments and remove Daytona-only gating for agent skills.
```

- [ ] **Step 4: Commit**

```bash
git add packages/trueforge/tests/unit/sandbox/directExecution.test.ts \
        .changeset/direct-sandbox-provider.md
git commit -m "test: add direct execution integration test and changeset"
```

---

## Execution Handoff

Plan complete and saved to `docs/superpowers/plans/2026-09-15-direct-sandbox-provider.md`. Two execution options:

1. **Subagent-Driven (recommended)** - Fresh subagent dispatched per task, review between tasks, fast iteration
2. **Inline Execution** - Execute tasks in this session using executing-plans, batch execution with checkpoints

Which approach would you like to take?
