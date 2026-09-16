/**
 * DirectSandboxProvider integration test: direct host execution plus the
 * canonical skill init flow (empty skill list — validates the shared python
 * venv and skill_downloader.py end-to-end, no network skill downloads).
 */
import {
  DirectSandboxProvider,
  SKILL_DOWNLOAD_TIMEOUT_SECONDS,
  SkillMounter,
  getSkillPath,
  type SandboxProvider,
} from '@truefoundry/trueforge-core/core';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createLogger } from 'winston';

describe('DirectSandboxProvider direct execution', () => {
  let rootDir: string | undefined;
  let provider: SandboxProvider;
  let sandboxId: string;

  afterEach(async () => {
    if (rootDir !== undefined) {
      await rm(rootDir, { recursive: true, force: true });
      rootDir = undefined;
    }
  });

  async function assertExecExitZero(command: string): Promise<string> {
    const result = await provider.exec({ sandboxId, command });
    expect(result.success).toBe(true);
    if (!result.success) throw new Error(`exec failed: ${result.error}`);
    if (result.response.exitCode !== 0)
      throw new Error(`exit ${String(result.response.exitCode)}: ${result.response.result}`);
    return result.response.result;
  }

  it('runs the canonical skill init flow and direct exec end-to-end (empty skill list)', async () => {
    rootDir = await mkdtemp(join(tmpdir(), 'tfy-direct-exec-'));
    provider = new DirectSandboxProvider({
      sandboxRootDir: rootDir,
      logger: createLogger({ silent: true }),
    });

    // The first createSandbox warms up the shared python venv (venv + pydantic).
    const created = await provider.createSandbox();
    sandboxId = created.sandboxId;
    expect(sandboxId.startsWith(rootDir)).toBe(true);

    const skillsDir = provider.getSkillsDir(sandboxId);
    const skillInit = new SkillMounter({ skills: [] }).getSandboxInit({
      skillsDir,
      skillDownloaderPath: provider.getSkillDownloaderPath(sandboxId),
    });
    expect(skillInit.timeoutSeconds).toBe(SKILL_DOWNLOAD_TIMEOUT_SECONDS);
    expect(skillInit.env).toEqual({ TFY_SKILLS_DIR: skillsDir });

    // Canonical flow: upload the requested-skills JSON (even when empty) before the init command.
    for (const upload of skillInit.uploads) {
      expect(upload.remotePath).toBe(`${skillsDir}/.tfy-requested-skills.json`);
      await provider.uploadFile({ sandboxId, remotePath: upload.remotePath, content: upload.content });
    }

    const init = await provider.exec({
      sandboxId,
      command: skillInit.command,
      env: skillInit.env,
      timeoutSeconds: skillInit.timeoutSeconds,
    });
    expect(init.success).toBe(true);
    if (!init.success) throw new Error(`skill init failed: ${init.error}`);
    if (init.response.exitCode !== 0)
      throw new Error(`init exit ${String(init.response.exitCode)}: ${init.response.result}`);

    // skill_downloader.py was written into the sandbox and ran via the venv python.
    await assertExecExitZero('test -f skill_downloader.py');
    // The skills dir exists.
    await assertExecExitZero(`ls -A ${skillsDir}`);
    // The downloader deleted the requested file and persisted its state.
    await assertExecExitZero(`test ! -f ${skillsDir}/.tfy-requested-skills.json`);
    await assertExecExitZero(`test -f ${skillsDir}/.tfy-skill-downloader-state.json`);

    // exec is stateful: write in one exec, read it back in another.
    await assertExecExitZero('echo direct-state > stateful.txt');
    expect(await assertExecExitZero('cat stateful.txt')).toContain('direct-state');

    // Upload/download round-trip.
    await provider.uploadFile({
      sandboxId,
      remotePath: 'uploads/roundtrip.txt',
      content: Buffer.from('roundtrip-content', 'utf8'),
    });
    const downloaded = await provider.downloadFile({ sandboxId, path: 'uploads/roundtrip.txt' });
    expect(downloaded.toString('utf8')).toBe('roundtrip-content');

    // Materialized (fake) skill + the mounter prompt path convention.
    const skillName = 'direct-fake-skill';
    await provider.uploadFile({
      sandboxId,
      remotePath: `${skillsDir}/${skillName}/SKILL.md`,
      content: Buffer.from('# Fake skill\n\nMaterialized directly for the test.\n', 'utf8'),
    });
    expect(getSkillPath({ skillsDir, skillName })).toBe(`${skillsDir}/${skillName}`);
    expect(await assertExecExitZero(`cat ${skillsDir}/${skillName}/SKILL.md`)).toContain('# Fake skill');
  }, 120_000);

  it('allows uploadFile to overwrite read-only files across multi-turn session inits', async () => {
    rootDir = await mkdtemp(join(tmpdir(), 'tfy-direct-overwrite-'));
    provider = new DirectSandboxProvider({
      sandboxRootDir: rootDir,
      logger: createLogger({ silent: true }),
    });

    const created = await provider.createSandbox();
    sandboxId = created.sandboxId;

    const testPath = 'mcp-client/mcp_client.py';
    // Turn 1 upload + chmod 0555 (matching Sandbox.initSandboxEnvironment)
    await provider.uploadFile({
      sandboxId,
      remotePath: testPath,
      content: Buffer.from('print("turn 1 mcp_client")', 'utf8'),
    });
    await assertExecExitZero(`chmod 0555 ${testPath}`);

    // Turn 2 re-init upload to the same path
    await provider.uploadFile({
      sandboxId,
      remotePath: testPath,
      content: Buffer.from('print("turn 2 mcp_client")', 'utf8'),
    });

    const downloaded = await provider.downloadFile({ sandboxId, path: testPath });
    expect(downloaded.toString('utf8')).toBe('print("turn 2 mcp_client")');
  }, 60_000);
});
