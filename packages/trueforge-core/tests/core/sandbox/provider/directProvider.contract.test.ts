import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DirectSandboxProvider } from '../../../../src/core/sandbox/provider/DirectSandboxProvider';
import { makeSilentLogger } from '../../harnessMocks';
import { runSandboxProviderContractSuite } from './sandboxProviderContractSuite';

describe('DirectSandboxProvider (SandboxProvider contract)', () => {
  runSandboxProviderContractSuite(async () => {
    const rootDir = await mkdtemp(join(tmpdir(), 'tfy-direct-contract-'));
    const provider = new DirectSandboxProvider({
      sandboxRootDir: rootDir,
      logger: makeSilentLogger(),
    });
    // Warm up: the first createSandbox builds the shared virtualenv (venv +
    // pip install pydantic) — keep that out of the per-test 30s budget.
    await provider.createSandbox();
    return {
      provider,
      dispose: async () => {
        await rm(rootDir, { recursive: true, force: true });
      },
    };
  });
});
