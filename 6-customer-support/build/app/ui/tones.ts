'use client';

/**
 * Soft call cues made in the browser, with no audio files: two rising notes when the call connects, one quiet
 * note when it is the caller's turn, two falling notes when it ends. Quiet sine tones, because the brand is calm
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
  connected: () => play([587, 880]),
  yourTurn: () => play([784], 0.09, 0.03),
  ended: () => play([660, 440]),
};
