import { describe, expect, it } from 'vitest';
import { loadConfig } from '../src/server/config.js';

describe('loadConfig', () => {
  it('falls back to mock runtime and default port', () => {
    const config = loadConfig({});
    expect(config.port).toBe(8787);
    expect(config.runtime).toBe('mock');
    expect(config.defaultRef).toBe('main');
    expect(config.defaultModel).toBe('composer-2');
  });

  it('normalizes blank optional values', () => {
    const config = loadConfig({
      PORT: '9000',
      CURSOR_API_KEY: '   ',
      CURSOR_RUNTIME: 'cloud',
      CURSOR_LOCAL_CWD: '/Users/example/project',
      CURSOR_DEFAULT_REPO_URL: '   ',
      CURSOR_DEFAULT_REF: 'dev',
      CURSOR_DEFAULT_MODEL: 'composer-test'
    });
    expect(config.port).toBe(9000);
    expect(config.runtime).toBe('cloud');
    expect(config.localCwd).toBe('/Users/example/project');
    expect(config.cursorApiKey).toBeUndefined();
    expect(config.defaultRepoUrl).toBeUndefined();
    expect(config.defaultRef).toBe('dev');
    expect(config.defaultModel).toBe('composer-test');
  });
});
