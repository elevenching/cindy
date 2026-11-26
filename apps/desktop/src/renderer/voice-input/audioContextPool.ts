/**
 * Shared AudioContext + AudioWorklet module pool for voice input.
 *
 * AudioContext creation and `audioWorklet.addModule` together cost 30-100ms
 * on cold start: the WebMicAudioEngine pays this on every `start()` because it
 * also closes the context on `stop()`. The user-perceived latency from
 * "shortcut pressed" to "mic recording" includes this cost.
 *
 * This module keeps a single `AudioContext` alive across recording sessions
 * with the PCM16k worklet module pre-loaded into it, and suspends it whenever
 * no capture or active keep-alive session holds a lease (`activeLeases === 0`).
 *
 * Why suspend when idle: on macOS Core Audio, leaving an `AudioContext` in
 * `'running'` state keeps a real-time render thread (`PRI 97R`) + AudioWorklet
 * IPC spinning continuously (~375 wakeups/sec) even with zero connected nodes
 * and even inside a hidden window with `backgroundThrottling: false`.
 * Suspending right after prewarm (and after a short idle grace period once a
 * direct capture ends) drops idle audio CPU to ~0% while keeping the compiled
 * worklet module warm in memory; `WebMicAudioEngine` calls `resume()` after
 * acquiring the microphone stream, overlapping any hardware startup latency.
 */

const PCM16K_WORKLET_NAME = 'pcm16k-worklet';
const SHARED_AUDIO_IDLE_SUSPEND_MS = 15_000;

type SharedAudioState = {
  context: AudioContext;
  workletReady: Promise<void>;
  workletUrl: string;
};

let sharedState: SharedAudioState | null = null;
let activeLeases = 0;
let idleSuspendTimer: ReturnType<typeof setTimeout> | null = null;

function clearIdleSuspendTimer(): void {
  if (idleSuspendTimer === null) return;
  clearTimeout(idleSuspendTimer);
  idleSuspendTimer = null;
}

async function suspendContextIfIdle(context: AudioContext): Promise<void> {
  if (activeLeases > 0 || sharedState?.context !== context) return;
  if (context.state !== 'running' || typeof context.suspend !== 'function') return;
  try {
    await context.suspend();
  } catch {
    // Suspending an idle context is best-effort; recording does not depend on it.
  }
}

function scheduleIdleSuspend(): void {
  clearIdleSuspendTimer();
  if (activeLeases > 0 || !sharedState) return;
  idleSuspendTimer = setTimeout(() => {
    idleSuspendTimer = null;
    if (sharedState) void suspendContextIfIdle(sharedState.context);
  }, SHARED_AUDIO_IDLE_SUSPEND_MS);
}

/**
 * Acquire a lease on the shared `AudioContext` so it is not suspended while a
 * recording or active keep-alive microphone session is in flight.
 *
 * Returns an idempotent release function. Normal release waits for a short idle
 * grace period so back-to-back dictations stay instant; pass `{ immediate: true }`
 * when tearing down a keep-alive session or on power suspend / screen lock.
 */
export function retainSharedVoiceInputAudio(): (options?: { immediate?: boolean }) => void {
  activeLeases += 1;
  clearIdleSuspendTimer();
  let released = false;
  return (options?: { immediate?: boolean }) => {
    if (released) return;
    released = true;
    activeLeases = Math.max(0, activeLeases - 1);
    if (activeLeases > 0) return;
    if (options?.immediate) {
      clearIdleSuspendTimer();
      if (sharedState) void suspendContextIfIdle(sharedState.context);
    } else {
      scheduleIdleSuspend();
    }
  };
}

/**
 * Eagerly create the shared AudioContext, load the worklet module, and suspend
 * it immediately when idle (`activeLeases === 0`). Safe to call multiple times.
 */
export async function prewarmVoiceInputAudio(workletUrl: string): Promise<SharedAudioState> {
  if (sharedState && sharedState.workletUrl === workletUrl) {
    await sharedState.workletReady;
    if (activeLeases === 0 && !idleSuspendTimer) {
      await suspendContextIfIdle(sharedState.context);
    }
    return sharedState;
  }

  // If the workletUrl ever differs (dev HMR), close and drop the prior context
  // so no real-time audio thread stays alive behind it.
  if (sharedState && sharedState.workletUrl !== workletUrl) {
    clearIdleSuspendTimer();
    const previous = sharedState;
    sharedState = null;
    if (typeof previous.context.close === 'function' && previous.context.state !== 'closed') {
      void previous.context.close().catch(() => undefined);
    }
  }

  const context = new AudioContext();

  const workletReady = context.audioWorklet
    .addModule(workletUrl)
    .catch((error) => {
      // Reset state and close the failed context so the next call retries cleanly.
      if (sharedState?.context === context) sharedState = null;
      if (typeof context.close === 'function' && context.state !== 'closed') {
        void context.close().catch(() => undefined);
      }
      throw error;
    });

  sharedState = { context, workletReady, workletUrl };
  await workletReady;
  if (activeLeases === 0 && !idleSuspendTimer) {
    await suspendContextIfIdle(context);
  }
  return sharedState;
}

/** Cancel any idle grace timer and suspend the shared AudioContext immediately if idle. */
export async function suspendSharedVoiceInputAudioNow(): Promise<void> {
  clearIdleSuspendTimer();
  if (sharedState && activeLeases === 0) {
    await suspendContextIfIdle(sharedState.context);
  }
}

/** Close and clear the shared AudioContext pool (used on HMR and test cleanup). */
export async function disposeSharedVoiceInputAudio(): Promise<void> {
  clearIdleSuspendTimer();
  activeLeases = 0;
  const previous = sharedState;
  sharedState = null;
  if (previous && typeof previous.context.close === 'function' && previous.context.state !== 'closed') {
    await previous.context.close().catch(() => undefined);
  }
}

/**
 * Return the prewarmed shared state synchronously, or null if nothing has
 * been prewarmed yet (or a previous prewarm failed). Used by engines to
 * decide whether to take the fast path.
 */
export function getSharedVoiceInputAudio(): SharedAudioState | null {
  return sharedState;
}

export { PCM16K_WORKLET_NAME, SHARED_AUDIO_IDLE_SUSPEND_MS };
