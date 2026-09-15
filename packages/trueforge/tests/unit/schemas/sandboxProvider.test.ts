import {
  DirectSandboxProviderSchema,
  SandboxProviderManifestSchema,
  StoredSandboxProviderManifestSchema,
  UpdateSandboxProviderRequestSchema,
  toDaytonaSandboxProviderInput,
  type DaytonaSandboxProvider,
} from '../../../src/schemas/sandboxProvider';

describe('toDaytonaSandboxProviderInput', () => {
  it('maps a Daytona wire/DB manifest to apiKey plus provider settings', () => {
    const manifest: DaytonaSandboxProvider = {
      type: 'daytona',
      auth: { api_key: 'dtn-test' },
      exec_timeout_ms: 60_000,
      auto_stop_interval_in_minutes: 5,
      auto_archive_interval_in_minutes: 60,
      auto_delete_interval_in_minutes: 7200,
    };

    expect(toDaytonaSandboxProviderInput(manifest)).toEqual({
      apiKey: 'dtn-test',
      timeoutMs: 60_000,
      autoStopIntervalInMinutes: 5,
      autoArchiveIntervalInMinutes: 60,
      autoDeleteIntervalInMinutes: 7200,
    });
  });
});

describe('StoredSandboxProviderManifestSchema', () => {
  it('parses a truefoundry manifest for internal store use', () => {
    expect(
      StoredSandboxProviderManifestSchema.parse({
        type: 'truefoundry',
        server_url: 'http://sandbox-server',
        nats_bridge_url: 'ws://nats-bridge',
        exec_timeout_ms: 60_000,
      }),
    ).toEqual({
      type: 'truefoundry',
      server_url: 'http://sandbox-server',
      nats_bridge_url: 'ws://nats-bridge',
      exec_timeout_ms: 60_000,
    });
  });

  it('parses a direct manifest with the defaulted timeout', () => {
    expect(StoredSandboxProviderManifestSchema.parse({ type: 'direct' })).toEqual({
      type: 'direct',
      exec_timeout_ms: 60_000,
    });
  });
});

describe('DirectSandboxProviderSchema', () => {
  it('parses a direct manifest with an explicit exec timeout', () => {
    expect(DirectSandboxProviderSchema.parse({ type: 'direct', exec_timeout_ms: 120_000 })).toEqual({
      type: 'direct',
      exec_timeout_ms: 120_000,
    });
  });

  it('defaults the exec timeout to 60000 when omitted', () => {
    expect(DirectSandboxProviderSchema.parse({ type: 'direct' })).toEqual({
      type: 'direct',
      exec_timeout_ms: 60_000,
    });
  });
});

describe('SandboxProviderManifestSchema', () => {
  it('accepts a direct manifest (settings PUT exposes direct)', () => {
    expect(SandboxProviderManifestSchema.parse({ type: 'direct', exec_timeout_ms: 60_000 })).toEqual({
      type: 'direct',
      exec_timeout_ms: 60_000,
    });
  });

  it('still accepts a daytona manifest', () => {
    expect(
      SandboxProviderManifestSchema.parse({
        type: 'daytona',
        auth: { api_key: 'dtn-test' },
        exec_timeout_ms: 60_000,
        auto_stop_interval_in_minutes: 5,
        auto_archive_interval_in_minutes: 60,
        auto_delete_interval_in_minutes: 7200,
      }).type,
    ).toBe('daytona');
  });
});

describe('UpdateSandboxProviderRequestSchema', () => {
  it('rejects a truefoundry manifest (settings PUT is Daytona + Direct only)', () => {
    expect(() =>
      UpdateSandboxProviderRequestSchema.parse({
        manifest: {
          type: 'truefoundry',
          server_url: 'http://sandbox-server',
          nats_bridge_url: 'ws://nats-bridge',
          exec_timeout_ms: 60_000,
        },
      }),
    ).toThrow();
  });

  it('accepts a direct manifest', () => {
    expect(UpdateSandboxProviderRequestSchema.parse({ manifest: { type: 'direct', exec_timeout_ms: 60_000 } })).toEqual(
      { manifest: { type: 'direct', exec_timeout_ms: 60_000 } },
    );
  });
});
