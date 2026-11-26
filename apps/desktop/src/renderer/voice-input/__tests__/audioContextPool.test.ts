import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  disposeSharedVoiceInputAudio,
  prewarmVoiceInputAudio,
  retainSharedVoiceInputAudio,
  SHARED_AUDIO_IDLE_SUSPEND_MS,
  suspendSharedVoiceInputAudioNow,
} from '../audioContextPool';

// 测试价值
// - 生产入口与可观察结果：直接调用真实 audioContextPool 导出的 prewarmVoiceInputAudio / retainSharedVoiceInputAudio / suspendSharedVoiceInputAudioNow / disposeSharedVoiceInputAudio，验证共享 AudioContext 在闲置时立即 suspend、在活跃租约期间保持 running 并在到期或电源取消后立即挂起。
// - Bug／规则依据：闲置窗口保留 running 状态的 AudioContext 会持续唤醒 macOS Core Audio PRI 97R 实时音频线程造成空闲 CPU 消耗。
// - 现有覆盖缺口：WebMicAudioEngine.*.test.ts 与 useVoiceInput.*.test.ts 均通过 vi.mock('../audioContextPool') 屏蔽了真实池实现，现有测试从未测过 audioContextPool 本身的生命周期。
// - 最小失败输入：prewarmVoiceInputAudio('worklet.js') 后若未调用 context.suspend()，即触发闲置实时音频线程空转。
// - tier：unit（node 环境，内存 fake AudioContext，不依赖 DOM 或 Electron）。

const WORKLET_URL = 'https://app.local/pcm16k-worklet.js';

function installFakeAudioContext() {
  const contexts: Array<{
    state: AudioContextState;
    suspend: ReturnType<typeof vi.fn>;
    close: ReturnType<typeof vi.fn>;
    addModule: ReturnType<typeof vi.fn>;
  }> = [];
  let addModuleImpl: () => Promise<void> = async () => undefined;

  vi.stubGlobal(
    'AudioContext',
    vi.fn().mockImplementation(() => {
      const addModule = vi.fn(() => addModuleImpl());
      const ctx = {
        state: 'running' as AudioContextState,
        audioWorklet: { addModule },
        suspend: vi.fn(async () => {
          ctx.state = 'suspended';
        }),
        close: vi.fn(async () => {
          ctx.state = 'closed';
        }),
      };
      contexts.push({
        get state() {
          return ctx.state;
        },
        suspend: ctx.suspend,
        close: ctx.close,
        addModule,
      });
      return ctx;
    }),
  );

  return {
    contexts,
    setAddModuleImpl: (impl: () => Promise<void>) => {
      addModuleImpl = impl;
    },
  };
}

describe('audioContextPool idle suspend lifecycle', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(async () => {
    await disposeSharedVoiceInputAudio();
    vi.useRealTimers();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('suspends immediately after prewarm when idle and reuses the same context', async () => {
    const { contexts } = installFakeAudioContext();

    const first = await prewarmVoiceInputAudio(WORKLET_URL);
    const second = await prewarmVoiceInputAudio(WORKLET_URL);

    expect(first).toBe(second);
    expect(contexts).toHaveLength(1);
    expect(contexts[0].addModule).toHaveBeenCalledTimes(1);
    expect(contexts[0].suspend).toHaveBeenCalledTimes(1);
    expect(contexts[0].state).toBe('suspended');
  });

  it('keeps context running during an active lease and suspends after the idle grace period', async () => {
    const { contexts } = installFakeAudioContext();

    const release = retainSharedVoiceInputAudio();
    await prewarmVoiceInputAudio(WORKLET_URL);
    expect(contexts[0].suspend).not.toHaveBeenCalled();

    release();
    expect(contexts[0].suspend).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(SHARED_AUDIO_IDLE_SUSPEND_MS - 1);
    expect(contexts[0].suspend).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(1);
    expect(contexts[0].suspend).toHaveBeenCalledTimes(1);
    expect(contexts[0].state).toBe('suspended');
  });

  it('requires all overlapping leases to release and cancels pending suspend when retained again', async () => {
    const { contexts } = installFakeAudioContext();

    const releaseOne = retainSharedVoiceInputAudio();
    const releaseTwo = retainSharedVoiceInputAudio();
    await prewarmVoiceInputAudio(WORKLET_URL);

    releaseOne();
    releaseOne(); // Idempotent duplicate release must not drop leaseTwo.
    await vi.advanceTimersByTimeAsync(SHARED_AUDIO_IDLE_SUSPEND_MS + 100);
    expect(contexts[0].suspend).not.toHaveBeenCalled();

    releaseTwo();
    await vi.advanceTimersByTimeAsync(SHARED_AUDIO_IDLE_SUSPEND_MS / 2);
    const releaseThree = retainSharedVoiceInputAudio();
    await vi.advanceTimersByTimeAsync(SHARED_AUDIO_IDLE_SUSPEND_MS);
    expect(contexts[0].suspend).not.toHaveBeenCalled();

    releaseThree({ immediate: true });
    await Promise.resolve();
    expect(contexts[0].suspend).toHaveBeenCalledTimes(1);
    expect(contexts[0].state).toBe('suspended');
  });

  it('cancels grace timer on suspendSharedVoiceInputAudioNow and closes stale/failed contexts', async () => {
    const { contexts, setAddModuleImpl } = installFakeAudioContext();

    const release = retainSharedVoiceInputAudio();
    await prewarmVoiceInputAudio(WORKLET_URL);
    release();
    await suspendSharedVoiceInputAudioNow();
    expect(contexts[0].suspend).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);

    // Changing worklet URL closes the prior context cleanly.
    await prewarmVoiceInputAudio('https://app.local/pcm16k-worklet-v2.js');
    expect(contexts[0].close).toHaveBeenCalledTimes(1);
    expect(contexts[1].suspend).toHaveBeenCalledTimes(1);

    // Failed addModule closes the broken context and allows retry on the same URL.
    setAddModuleImpl(async () => {
      throw new Error('worklet load failed');
    });
    await expect(prewarmVoiceInputAudio('https://app.local/pcm16k-worklet-v3.js')).rejects.toThrow(
      'worklet load failed',
    );
    expect(contexts[2].close).toHaveBeenCalledTimes(1);

    setAddModuleImpl(async () => undefined);
    await prewarmVoiceInputAudio('https://app.local/pcm16k-worklet-v3.js');
    expect(contexts[3].suspend).toHaveBeenCalledTimes(1);
  });
});
