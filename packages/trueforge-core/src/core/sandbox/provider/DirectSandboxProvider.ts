/**
 * Direct host-execution SandboxProvider for deployments where the TrueForge
 * process itself runs in an isolated microVM (or dedicated container): the
 * microVM is the security boundary, so commands run as plain host processes
 * (`sh` + `python3` via a shared virtualenv) with local filesystem I/O — no
 * Daytona, no nested container runtime, no network proxy.
 *
 * `sandboxId` is the absolute path of the sandbox directory (path-id model,
 * same as LocalSandboxProvider). When the kernel allows unprivileged user
 * namespaces (`unshare -Urm`), exec additionally shadows the sandbox root
 * directory with a per-sandbox view so sibling sandboxes are not reachable;
 * without that capability the sandbox root is plain (host-wide visibility,
 * the microVM boundary applies).
 */
import { execFile, spawn, spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { existsSync, statSync } from 'node:fs';
import { chmod, mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { isAbsolute, join, resolve, sep } from 'node:path';
import { promisify } from 'node:util';
import type { Logger } from 'winston';
import type { CodeModeTransport } from '../codeMode/CodeModeTransport';
import {
  SandboxError,
  SandboxFileNotFoundError,
  SandboxFileTooLargeError,
  SandboxNotAvailableError,
  SandboxPathIsDirectoryError,
  validateNoPathTraversal,
} from '../SandboxErrors';
import { absolutizeRelativeExecEnv } from './execEnv';
import type { ExecResult, SandboxBuild, SandboxExecParams, SandboxProvider } from './Provider';

const execFileAsync = promisify(execFile);

const DEFAULT_EXEC_TIMEOUT_SECONDS = 60;
const DEFAULT_FILE_MAX_BYTES = 10 * 1024 * 1024;
const MAX_OUTPUT_BYTES = 14 * 1024 * 1024;
const VENV_CREATE_TIMEOUT_MS = 60_000;
const VENV_PIP_TIMEOUT_MS = 120_000;
/** Same pin as the Daytona image / skill_downloader.py PEP 723 header. */
const VENV_PYDANTIC_PIN = 'pydantic>=2.0.0,<3.0.0';
/** Shared virtualenv under the sandbox root (sibling of the sandbox dirs). */
const VENV_DIR_NAME = '.venv';
/** Code Mode is not transportable from core for this provider; the client script reports it clearly. */
const CODE_MODE_UNAVAILABLE_SCRIPT = [
  '#!/usr/bin/env python3',
  'import sys',
  '',
  'print("Code Mode is not supported by the direct sandbox provider; use the exec tool instead.", file=sys.stderr)',
  'raise SystemExit(1)',
].join('\n');

export interface DirectSandboxProviderOptions {
  /** Absolute parent directory under which each sandbox gets a child directory. */
  sandboxRootDir: string;
  defaultExecTimeoutSeconds?: number | undefined;
  fileMaxBytesForDownload?: number | undefined;
  logger: Logger;
  /** Host shell for exec (resolved via PATH). Default `sh`. */
  shell?: string | undefined;
}

export class DirectSandboxProvider implements SandboxProvider {
  readonly type = 'direct';
  private readonly sandboxRootDir: string;
  private readonly defaultExecTimeoutSeconds: number;
  private readonly fileMaxBytesForDownload: number;
  private readonly logger: Logger;
  private readonly shell: string;
  private confinementAvailable: boolean | undefined;
  private pythonAvailable: boolean | undefined;
  private venvReady: boolean | undefined;

  static readonly readyBuild: SandboxBuild = {
    status: 'ready',
    reason: null,
    metadata: null,
  };

  constructor(options: DirectSandboxProviderOptions) {
    if (!isAbsolute(options.sandboxRootDir)) {
      throw new Error('sandboxRootDir must be an absolute path');
    }
    validateNoPathTraversal(options.sandboxRootDir);
    this.sandboxRootDir = resolve(options.sandboxRootDir);
    this.defaultExecTimeoutSeconds = options.defaultExecTimeoutSeconds ?? DEFAULT_EXEC_TIMEOUT_SECONDS;
    this.fileMaxBytesForDownload = options.fileMaxBytesForDownload ?? DEFAULT_FILE_MAX_BYTES;
    this.logger = options.logger.child({ module: 'DirectSandboxProvider' });
    this.shell = options.shell ?? 'sh';
  }

  buildImage(): Promise<SandboxBuild> {
    return Promise.resolve(DirectSandboxProvider.readyBuild);
  }

  getImageBuildStatus(): Promise<SandboxBuild> {
    return Promise.resolve(DirectSandboxProvider.readyBuild);
  }

  /** True when `unshare -Urm` works, i.e. exec can shadow the sandbox root per sandbox. */
  private async isConfinementAvailable(): Promise<boolean> {
    if (this.confinementAvailable === undefined) {
      const probe = spawnSync('unshare', ['-Urm', '--', 'true'], { stdio: 'ignore', timeout: 10_000 });
      this.confinementAvailable = probe.error === undefined && probe.status === 0;
    }
    return this.confinementAvailable;
  }

  /** Host `python3 -m venv` (stdlib only), then venv pip for pydantic. Idempotent and shared. */
  private async ensureVenv(): Promise<void> {
    if (this.venvReady === true) {
      return;
    }
    if (this.pythonAvailable === undefined) {
      const probe = spawnSync('python3', ['--version'], { stdio: 'ignore', timeout: 10_000 });
      this.pythonAvailable = probe.error === undefined && probe.status === 0;
    }
    if (!this.pythonAvailable) {
      this.logger.warn(
        'python3 not found on the host; the direct sandbox virtualenv is unavailable (skills need python3)',
      );
      return;
    }

    const venvDir = join(this.sandboxRootDir, VENV_DIR_NAME);
    const venvPython = join(venvDir, 'bin', 'python');
    if (!existsSync(venvPython)) {
      try {
        await execFileAsync('python3', ['-m', 'venv', venvDir], { timeout: VENV_CREATE_TIMEOUT_MS });
      } catch (error) {
        throw new Error(`Failed to create direct sandbox ${VENV_DIR_NAME}: ${execErrorDetail(error)}`, {
          cause: error,
        });
      }
    }

    const check = spawnSync(venvPython, ['-c', 'import pydantic'], { stdio: 'ignore', timeout: 10_000 });
    if (check.error === undefined && check.status === 0) {
      this.venvReady = true;
      return;
    }

    const install = spawnSync(join(venvDir, 'bin', 'pip'), ['install', VENV_PYDANTIC_PIN], {
      timeout: VENV_PIP_TIMEOUT_MS,
      stdio: 'pipe',
    });
    if (install.error !== undefined || install.status !== 0) {
      throw new Error(
        `Failed to pip install ${VENV_PYDANTIC_PIN} into the direct sandbox ${VENV_DIR_NAME}: ` +
          `${install.error?.message ?? String(install.status)}`,
        { cause: install.error ?? new Error(`pip exited ${String(install.status)}`) },
      );
    }
    this.venvReady = true;
  }

  async createSandbox(): Promise<{ sandboxId: string }> {
    await this.ensureVenv();
    const sandboxId = join(this.sandboxRootDir, randomUUID());
    await mkdir(join(sandboxId, this.getSkillsDir()), { recursive: true, mode: 0o700 });
    await mkdir(join(sandboxId, this.getFileUploadsDir()), { recursive: true, mode: 0o700 });
    await mkdir(join(sandboxId, this.getToolResultDumpDir()), { recursive: true, mode: 0o700 });
    this.logger.info('DirectSandboxProvider created sandbox', { sandboxId });
    return { sandboxId };
  }

  /** Missing or not a directory → SandboxNotAvailableError (Sandbox recreates and retries). */
  private ensureSandboxRoot(sandboxId: string): void {
    if (!isAbsolute(sandboxId)) {
      throw new SandboxNotAvailableError(sandboxId);
    }
    const resolved = resolve(sandboxId);
    if (!existsSync(resolved) || !statSync(resolved).isDirectory()) {
      throw new SandboxNotAvailableError(sandboxId);
    }
  }

  private resolveInSandboxRoot(sandboxId: string, userPath: string): string {
    validateNoPathTraversal(userPath);
    const resolved = userPath.startsWith('/') ? resolve(userPath) : resolve(sandboxId, userPath);
    const root = resolve(sandboxId);
    if (resolved !== root && !resolved.startsWith(root + sep)) {
      throw new SandboxFileNotFoundError(userPath);
    }
    return resolved;
  }

  /**
   * Confinement wrapper: shadow `sandboxRootDir` with a stage dir holding only
   * this sandbox (plus the shared venv), then cd into the sandbox. `pwd`
   * reports the sandbox path (logical) and sibling sandboxes are unreachable.
   */
  private buildConfinementCommand(params: { sandboxId: string; cwd: string; command: string }): string {
    // `name` is a UUID (safe unquoted). The real sandbox dir is shadowed by the
    // stage bind, so it is first bound into `realref` (a path outside the
    // shadow); the shadowed view then re-binds from realref. The trap must
    // umount realref before rm — `rm -rf` on the mounted dir would delete the
    // real sandbox files.
    const name = params.sandboxId.slice(this.sandboxRootDir.length + 1);
    const venvDir = join(this.sandboxRootDir, VENV_DIR_NAME);
    const quote = (value: string) => `'${value.replace(/'/g, "'\\''")}'`;
    const realrefSandbox = `"$realref/${name}"`;
    const realrefVenv = `"$realref/${VENV_DIR_NAME}"`;
    const viewSandbox = `${quote(this.sandboxRootDir)}/${name}`;
    const viewVenv = `${quote(this.sandboxRootDir)}/${VENV_DIR_NAME}`;
    return [
      `set -e`,
      `stage=$(mktemp -d)`,
      `realref=$(mktemp -d)`,
      `trap 'umount ${realrefSandbox} 2>/dev/null; umount ${realrefVenv} 2>/dev/null; rm -rf "$stage" "$realref" 2>/dev/null || true' EXIT`,
      // Probe before the shadow: after the stage bind the real venv is hidden.
      `have_venv=0`,
      `if [ -d ${quote(venvDir)} ]; then`,
      `have_venv=1`,
      `fi`,
      `mkdir -p ${realrefSandbox}`,
      `mount --bind ${quote(params.sandboxId)} ${realrefSandbox}`,
      `if [ "$have_venv" = 1 ]; then`,
      `mkdir -p ${realrefVenv}`,
      `mount --bind ${quote(venvDir)} ${realrefVenv}`,
      `fi`,
      `mount --bind "$stage" ${quote(this.sandboxRootDir)}`,
      `mkdir -p ${viewSandbox}`,
      `mount --bind ${realrefSandbox} ${viewSandbox}`,
      `if [ "$have_venv" = 1 ]; then`,
      `mkdir -p ${viewVenv}`,
      `mount --bind ${realrefVenv} ${viewVenv}`,
      `fi`,
      `cd ${quote(params.cwd)}`,
      params.command,
    ].join('\n');
  }

  async exec(params: SandboxExecParams): Promise<ExecResult> {
    this.ensureSandboxRoot(params.sandboxId);
    const cwd =
      params.cwd === undefined || params.cwd === ''
        ? params.sandboxId
        : this.resolveInSandboxRoot(params.sandboxId, params.cwd);
    const timeoutSeconds = params.timeoutSeconds ?? this.defaultExecTimeoutSeconds;
    const venvBin = join(this.sandboxRootDir, VENV_DIR_NAME, 'bin');
    const baseEnv: Record<string, string> = {};
    for (const [key, value] of Object.entries(process.env)) {
      if (value !== undefined) {
        baseEnv[key] = value;
      }
    }
    if (params.env !== undefined) {
      Object.assign(baseEnv, params.env);
    }
    if (existsSync(venvBin)) {
      baseEnv['PATH'] = `${venvBin}:${baseEnv['PATH'] ?? ''}`;
    }
    const env = absolutizeRelativeExecEnv({ root: params.sandboxId, env: baseEnv });

    return new Promise<ExecResult>(async resolveExec => {
      const available = await this.isConfinementAvailable();
      const child = available
        ? spawn(
            'unshare',
            [
              '-Urm',
              '--',
              this.shell,
              '-c',
              this.buildConfinementCommand({ sandboxId: params.sandboxId, cwd, command: params.command }),
            ],
            { env, detached: true },
          )
        : spawn(this.shell, ['-c', params.command], { cwd, env, detached: true });

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
      }, timeoutSeconds * 1000);

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
          resolveExec({ success: false, error: `Execution timed out after ${timeoutSeconds}s` });
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

  getAdditionalInstructions(): string {
    return [
      'SANDBOX RULES:',
      '- Commands run directly on the host; the microVM is the boundary (no nested container jail).',
      '- A shared Python virtualenv is on PATH: `python3` and `pip` are that environment; packages you `pip install` persist across sandboxes.',
      '- uploads, skills, and tool-dumps live in the sandbox working directory.',
      '- ALL file creation and writes MUST stay within the sandbox working directory.',
      '- The Agent must NOT write outside the working directory (including host home and /tmp).',
    ].join('\n');
  }

  // Cwd-relative: exec cwd is the sandbox root (same convention as TFY / local providers).
  getToolResultDumpDir(): string {
    return 'tool-dumps';
  }

  getGitCredentialsPath(): string {
    return '.git-credentials';
  }

  getFileUploadsDir(): string {
    return 'uploads';
  }

  getSkillsDir(): string {
    return 'skills';
  }

  getSkillDownloaderPath(): string {
    return 'skill_downloader.py';
  }

  async downloadFile(params: { sandboxId: string; path: string }): Promise<Buffer> {
    this.ensureSandboxRoot(params.sandboxId);
    const fullPath = this.resolveInSandboxRoot(params.sandboxId, params.path);
    try {
      const info = await stat(fullPath);
      if (info.isDirectory()) {
        throw new SandboxPathIsDirectoryError(params.path);
      }
      if (info.size > this.fileMaxBytesForDownload) {
        throw new SandboxFileTooLargeError(params.path, info.size, this.fileMaxBytesForDownload);
      }
      return await readFile(fullPath);
    } catch (error) {
      if (error instanceof SandboxError) {
        throw error;
      }
      throw new SandboxFileNotFoundError(params.path);
    }
  }

  async uploadFile(params: { sandboxId: string; remotePath: string; content: Buffer }): Promise<void> {
    this.ensureSandboxRoot(params.sandboxId);
    const fullPath = this.resolveInSandboxRoot(params.sandboxId, params.remotePath);
    await mkdir(resolve(fullPath, '..'), { recursive: true });
    await chmod(fullPath, 0o600).catch(() => {});
    await rm(fullPath, { force: true, recursive: true });
    await writeFile(fullPath, params.content);
  }

  createCodeModeTransport(): CodeModeTransport {
    // Core has no UDS Code Mode transport; exec still works, and the installed
    // client script reports Code Mode as unavailable with exit 1.
    return {
      getClientInstall: () => ({
        content: CODE_MODE_UNAVAILABLE_SCRIPT,
        remotePath: join('mcp-client', 'mcp_client.py'),
      }),
      start: async () => ({ env: {} }),
      stop: async () => undefined,
    };
  }
}

function execErrorDetail(error: unknown): string {
  if (!(error instanceof Error)) {
    return String(error);
  }
  const parts = [error.message];
  if ('stderr' in error && typeof error.stderr === 'string' && error.stderr.length > 0) {
    parts.push(error.stderr);
  }
  if ('stdout' in error && typeof error.stdout === 'string' && error.stdout.length > 0) {
    parts.push(error.stdout);
  }
  return parts.join(' ');
}
