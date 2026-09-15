import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AgentSpecSchema } from '../../src/agent-session/schemas/agentSpec';
import { TurnResourceResolver } from '../../src/agent-session/TurnResourceResolver';
import { DirectSandboxProvider } from '../../src/core/sandbox/provider/DirectSandboxProvider';
import { Sandbox } from '../../src/core/sandbox/Sandbox';
import { NOOP_AGENT_TRACING } from '../../src/core/tracing/NoopAgentTracing';
import { makeMockILLM, makeSilentLogger } from './testHelpers';

describe('TurnResourceResolver.resolveSandbox', () => {
  let rootDir = '';

  beforeEach(async () => {
    rootDir = await mkdtemp(join(tmpdir(), 'tfy-turn-resolver-'));
  });

  afterEach(async () => {
    if (rootDir !== '') {
      await rm(rootDir, { recursive: true, force: true });
    }
  });

  function makeResolver(): TurnResourceResolver {
    const provider = new DirectSandboxProvider({
      sandboxRootDir: rootDir,
      logger: makeSilentLogger(),
    });
    return new TurnResourceResolver({
      llm: () => Promise.resolve({ modelClient: makeMockILLM(), defaultModelParams: {} }),
      mcp: name => Promise.reject(new Error(`unexpected mcp lookup: ${name}`)),
      mcpRequestTimeoutMs: 60_000,
      mcpConnectTimeoutMs: 5_000,
      sandboxProvider: async () =>
        new Sandbox({
          provider,
          blockDestructiveToolsInCodeMode: true,
          mcpRequestTimeoutMs: 60_000,
          mcpConnectTimeoutMs: 5_000,
          tracing: NOOP_AGENT_TRACING,
          logger: makeSilentLogger(),
        }),
      logger: makeSilentLogger(),
    });
  }

  async function resolveSandbox(spec: ReturnType<typeof AgentSpecSchema.parse>) {
    const resolver = makeResolver();
    const sandbox = await resolver.resolveSandbox({
      spec,
      signal: new AbortController().signal,
      tracing: NOOP_AGENT_TRACING,
    });
    await resolver.close();
    return sandbox;
  }

  it('resolves a sandbox when sandbox.enabled is false but the agent has skills', async () => {
    const spec = AgentSpecSchema.parse({
      model: { name: 'test-provider/test-model' },
      instructions: 'test',
      skills: [{ name: 'git-skill' }],
      config: { sandbox: { enabled: false } },
    });
    const sandbox = await resolveSandbox(spec);
    expect(sandbox).toBeInstanceOf(Sandbox);
  });

  it('resolves no sandbox when sandbox.enabled is false and the agent has no skills', async () => {
    const spec = AgentSpecSchema.parse({
      model: { name: 'test-provider/test-model' },
      instructions: 'test',
      config: { sandbox: { enabled: false } },
    });
    const sandbox = await resolveSandbox(spec);
    expect(sandbox).toBeUndefined();
  });

  it('resolves a sandbox when sandbox.enabled is true, with or without skills', async () => {
    const spec = AgentSpecSchema.parse({
      model: { name: 'test-provider/test-model' },
      instructions: 'test',
      config: { sandbox: { enabled: true } },
    });
    const sandbox = await resolveSandbox(spec);
    expect(sandbox).toBeInstanceOf(Sandbox);
  });
});
