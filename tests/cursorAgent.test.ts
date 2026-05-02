import { describe, expect, it } from 'vitest';
import {
  createCursorGateway,
  CursorSdkGateway,
  MockCursorAgentGateway
} from '../src/server/cursorAgent.js';
import type { AppConfig } from '../src/server/config.js';

describe('MockCursorAgentGateway', () => {
  it('creates a deterministic mock run shape without credentials', async () => {
    const gateway = new MockCursorAgentGateway();
    const run = await gateway.startRun({
      prompt: 'Explain the repo',
      repoUrl: 'https://github.com/cursor/cookbook',
      startingRef: 'main',
      modelId: 'composer-2'
    });

    expect(run.id).toMatch(/^mock_/);
    expect(run.status).toBe('mocked');
    expect(run.runtime).toBe('mock');
    expect(run.repoUrl).toBe('https://github.com/cursor/cookbook');
    expect(run.resultText).toContain('Mock run created');
  });
});

describe('CursorSdkGateway', () => {
  it('fails fast when real runtime has no API key', async () => {
    const config: AppConfig = {
      port: 8787,
      runtime: 'cloud',
      defaultRef: 'main',
      defaultModel: 'composer-2'
    };
    const gateway = new CursorSdkGateway(config);

    await expect(gateway.startRun({ prompt: 'Run without key' })).rejects.toThrow(
      'CURSOR_API_KEY is required'
    );
  });

  it('delegates to mock mode when request runtime is mock', async () => {
    const config: AppConfig = {
      port: 8787,
      runtime: 'cloud',
      cursorApiKey: 'crsr_test',
      defaultRef: 'main',
      defaultModel: 'composer-2'
    };
    const gateway = new CursorSdkGateway(config);
    const run = await gateway.startRun({ prompt: 'Use mock override', runtime: 'mock' });
    expect(run.status).toBe('mocked');
  });

  it('requires a local cwd for local runtime', async () => {
    const config: AppConfig = {
      port: 8787,
      runtime: 'local',
      cursorApiKey: 'crsr_test',
      defaultRef: 'main',
      defaultModel: 'composer-2'
    };
    const gateway = new CursorSdkGateway(config);

    await expect(gateway.startRun({ prompt: 'Run locally' })).rejects.toThrow(
      'CURSOR_LOCAL_CWD is required'
    );
  });

  it('requires a repo URL for cloud runtime', async () => {
    const config: AppConfig = {
      port: 8787,
      runtime: 'cloud',
      cursorApiKey: 'crsr_test',
      defaultRef: 'main',
      defaultModel: 'composer-2'
    };
    const gateway = new CursorSdkGateway(config);

    await expect(gateway.startRun({ prompt: 'Cloud without repo' })).rejects.toThrow(
      'Cloud runs require a Git repository URL'
    );
  });
});

describe('createCursorGateway', () => {
  it('uses the mock gateway for mock runtime', () => {
    const gateway = createCursorGateway({
      port: 8787,
      runtime: 'mock',
      defaultRef: 'main',
      defaultModel: 'composer-2'
    });

    expect(gateway).toBeInstanceOf(MockCursorAgentGateway);
  });
});
