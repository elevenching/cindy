import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

beforeEach(() => {
  vi.useFakeTimers();
  vi.resetModules();
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

function audioContext(state = 'running') {
  const parameter = { setValueAtTime: vi.fn(), exponentialRampToValueAtTime: vi.fn() };
  const oscillator = {
    type: '',
    frequency: parameter,
    connect: vi.fn(),
    disconnect: vi.fn(),
    start: vi.fn(),
    stop: vi.fn(),
    onended: null as (() => void) | null,
  };
  const gain = { gain: parameter, connect: vi.fn(), disconnect: vi.fn() };
  const context = {
    state,
    currentTime: 0,
    destination: {},
    createOscillator: () => oscillator,
    createGain: () => gain,
    resume: vi.fn(() => new Promise<void>(() => {})),
    suspend: vi.fn(async () => {
      context.state = 'suspended';
    }),
  };
  vi.stubGlobal(
    'AudioContext',
    vi.fn(function () {
      return context;
    }),
  );
  return { oscillator, gain, context };
}

describe('ready cue completion for system mute', () => {
  it('settles after playback ends and disconnects its audio nodes', async () => {
    const { oscillator, gain } = audioContext();
    const { playVoiceInputStartCue } = await import('../startCue');
    const done = vi.fn();
    const playback = playVoiceInputStartCue().then(done);
    await Promise.resolve();
    expect(done).not.toHaveBeenCalled();
    oscillator.onended?.();
    await playback;
    expect(done).toHaveBeenCalledOnce();
    expect(oscillator.disconnect).toHaveBeenCalledOnce();
    expect(gain.disconnect).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('bounds a suspended context and cancels the sound so it cannot play late', async () => {
    const { oscillator } = audioContext('suspended');
    const { playVoiceInputStartCue } = await import('../startCue');
    const playback = playVoiceInputStartCue();
    await vi.advanceTimersByTimeAsync(310);
    await playback;
    expect(oscillator.stop).toHaveBeenLastCalledWith();
    expect(oscillator.disconnect).toHaveBeenCalledOnce();
    expect(oscillator.onended).toBeNull();
  });

  it('does not prevent muting when playback is unavailable', async () => {
    vi.stubGlobal(
      'AudioContext',
      vi.fn(function () {
        throw new Error('unavailable');
      }),
    );
    const { playVoiceInputStartCue } = await import('../startCue');
    await expect(playVoiceInputStartCue()).resolves.toBeUndefined();
    expect(vi.getTimerCount()).toBe(0);
  });

  // 测试价值
  // - 生产入口与可观察结果：调用 prepareVoiceInputCues / playVoiceInputStartCue / playVoiceInputEndCue，验证预热后及所有提示音播完后自动 suspend 闲置 AudioContext，且不额外创建定时器。
  // - Bug／规则依据：startCue 原先在预热与播音完成后让 AudioContext 长期保持 running，导致主窗与浮窗空闲唤醒音频线程。
  // - 现有覆盖缺口：现有用例仅测了节点断开与超时兜底，未断言 idle suspend 及双音结束提示音的重叠引用计数。
  // - 最小失败输入：prepareVoiceInputCues() 或 playVoiceInputEndCue() 播完双音后 context.state 仍为 running。
  // - tier：unit（与 startCue.test.ts 同文件表驱动扩展，无 DOM/Electron 依赖）。
  it('suspends idle cue context after prewarm and waits for overlapping end-cue notes to settle', async () => {
    const oscillators: Array<ReturnType<typeof audioContext>['oscillator']> = [];
    let ctx!: ReturnType<typeof audioContext>['context'];
    const parameter = { setValueAtTime: vi.fn(), exponentialRampToValueAtTime: vi.fn() };
    const gain = { gain: parameter, connect: vi.fn(), disconnect: vi.fn() };
    ctx = {
      state: 'running',
      currentTime: 0,
      destination: {},
      createOscillator: () => {
        const osc = {
          type: '',
          frequency: parameter,
          connect: vi.fn(),
          disconnect: vi.fn(),
          start: vi.fn(),
          stop: vi.fn(),
          onended: null as (() => void) | null,
        };
        oscillators.push(osc);
        return osc;
      },
      createGain: () => gain,
      resume: vi.fn(async () => {
        ctx.state = 'running';
      }),
      suspend: vi.fn(async () => {
        ctx.state = 'suspended';
      }),
    };
    vi.stubGlobal(
      'AudioContext',
      vi.fn(function () {
        return ctx;
      }),
    );

    const { playVoiceInputEndCue, playVoiceInputStartCue, prepareVoiceInputCues } = await import('../startCue');
    prepareVoiceInputCues();
    expect(ctx.suspend).toHaveBeenCalledTimes(1);
    expect(ctx.state).toBe('suspended');

    const startPlayback = playVoiceInputStartCue();
    await Promise.resolve();
    expect(ctx.resume).toHaveBeenCalledTimes(1);
    oscillators[0].onended?.();
    await startPlayback;
    expect(ctx.suspend).toHaveBeenCalledTimes(2);
    expect(ctx.state).toBe('suspended');

    playVoiceInputEndCue();
    await Promise.resolve();
    oscillators[1].onended?.();
    expect(ctx.suspend).toHaveBeenCalledTimes(2);
    oscillators[2].onended?.();
    expect(ctx.suspend).toHaveBeenCalledTimes(3);
    expect(ctx.state).toBe('suspended');
    expect(vi.getTimerCount()).toBe(0);
  });
});
