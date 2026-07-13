import { afterEach, describe, expect, it } from 'vitest';
import { KILL_SWITCH_ENV, checkKillSwitch } from './kill-switch.js';

describe('checkKillSwitch — injected reader', () => {
  it('absent value = run (default before the parameter is provisioned)', async () => {
    expect(await checkKillSwitch({ read: () => undefined })).toEqual({
      state: 'run',
      halted: false,
      raw: null,
    });
    expect(await checkKillSwitch({ read: () => '   ' })).toEqual({
      state: 'run',
      halted: false,
      raw: null,
    });
  });

  it("'run' runs, case/whitespace-insensitively", async () => {
    expect((await checkKillSwitch({ read: () => 'run' })).halted).toBe(false);
    expect((await checkKillSwitch({ read: () => ' RUN ' })).halted).toBe(false);
  });

  it("'halt' halts", async () => {
    const status = await checkKillSwitch({ read: () => 'halt' });
    expect(status).toEqual({ state: 'halt', halted: true, raw: 'halt' });
  });

  it('any unrecognized value FAILS CLOSED to halt', async () => {
    for (const raw of ['stop', 'true', '1', 'runn', 'run halt']) {
      const status = await checkKillSwitch({ read: () => raw });
      expect(status.halted, `value "${raw}" must halt`).toBe(true);
      expect(status.raw).toBe(raw.trim());
    }
  });

  it('supports async readers (SSM wiring shape)', async () => {
    expect((await checkKillSwitch({ read: () => Promise.resolve('halt') })).halted).toBe(true);
    expect((await checkKillSwitch({ read: () => Promise.resolve(undefined) })).halted).toBe(false);
  });

  it('propagates reader failures (an unreadable switch is an incident, not "run")', async () => {
    await expect(
      checkKillSwitch({
        read: () => Promise.reject(new Error('ssm unavailable')),
      }),
    ).rejects.toThrow('ssm unavailable');
  });
});

describe('checkKillSwitch — default env reader', () => {
  const original = process.env[KILL_SWITCH_ENV];

  afterEach(() => {
    if (original === undefined) delete process.env[KILL_SWITCH_ENV];
    else process.env[KILL_SWITCH_ENV] = original;
  });

  it('reads NEWSTRADER_KILL_SWITCH when no reader is injected', async () => {
    delete process.env[KILL_SWITCH_ENV];
    expect((await checkKillSwitch()).halted).toBe(false);

    process.env[KILL_SWITCH_ENV] = 'halt';
    expect((await checkKillSwitch()).halted).toBe(true);

    process.env[KILL_SWITCH_ENV] = 'run';
    expect((await checkKillSwitch()).halted).toBe(false);
  });
});
