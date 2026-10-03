'use client';

/**
 * Soft call cues made in the browser, with no audio files: a ringback while the call connects, two rising notes
 * when it is the caller's turn, two falling notes when it ends. Quiet sine tones, because the brand is calm
 * and a caller is listening to a voice. The context is made on the Start call click, as browsers require.
 */
let ctx: AudioContext | null = null;

export function primeTones() {
  try { ctx ??= new (window.AudioContext || (window as any).webkitAudioContext)(); void ctx.resume(); } catch { ctx = null; }
}

function play(freqs: number[], each = 0.11, volume = 0.05) {
  if (!ctx) return;
  try {
    let t = ctx.currentTime + 0.01;
    for (const f of freqs) {
      const osc = ctx.createOscillator(), gain = ctx.createGain();
      osc.type = 'sine'; osc.frequency.value = f;
      gain.gain.setValueAtTime(0, t);
      gain.gain.linearRampToValueAtTime(volume, t + 0.015);
      gain.gain.exponentialRampToValueAtTime(0.0001, t + each);
      osc.connect(gain).connect(ctx.destination);
      osc.start(t); osc.stop(t + each + 0.02);
      t += each * 0.9;
    }
  } catch { /* no sound is never an error */ }
}

export const tones = {
  yourTurn: () => play([659, 988], 0.12, 0.06),
  ended: () => play([660, 440]),
};

/**
 * A soft ringback while the call connects: two tones together, one second on and two off, the way a phone
 * rings out, until RelayPay answers. Returns the function that stops it.
 */
export function ring(): () => void {
  if (!ctx) return () => {};
  const c = ctx;
  try {
    const out = c.createGain();
    out.connect(c.destination);
    const t0 = c.currentTime + 0.05;
    for (let i = 0; i < 10; i++) {
      const t = t0 + i * 3;
      for (const f of [440, 480]) {
        const osc = c.createOscillator(), gain = c.createGain();
        osc.type = 'sine'; osc.frequency.value = f;
        gain.gain.setValueAtTime(0, t);
        gain.gain.linearRampToValueAtTime(0.025, t + 0.03);
        gain.gain.setValueAtTime(0.025, t + 0.97);
        gain.gain.linearRampToValueAtTime(0, t + 1);
        osc.connect(gain).connect(out);
        osc.start(t); osc.stop(t + 1.02);
      }
    }
    let stopped = false;
    return () => {
      if (stopped) return;
      stopped = true;
      try { out.gain.setTargetAtTime(0, c.currentTime, 0.02); setTimeout(() => out.disconnect(), 200); } catch { /* already gone */ }
    };
  } catch { return () => {}; }
}
