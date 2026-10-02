'use client';

import { useEffect, useRef, useState } from 'react';
import { Transcript, type Entry } from './transcript.tsx';
import { MicIcon, MicOffIcon, PhoneIcon } from './ui/icons.tsx';

type CallState = 'checking' | 'idle' | 'unavailable' | 'connecting' | 'listening' | 'speaking' | 'ended' | 'error';
type Vapi = {
  start(assistantId: string, overrides?: { metadata?: Record<string, string> }): Promise<unknown>; stop(): void; setMuted(mute: boolean): void;
  on(event: string, fn: (...a: any[]) => void): void; removeAllListeners?(): void;
};

const PUBLIC_KEY = process.env.NEXT_PUBLIC_VAPI_PUBLIC_KEY ?? '';
const ASSISTANT_ID = process.env.NEXT_PUBLIC_VAPI_ASSISTANT_ID ?? '';
const PHONE = process.env.NEXT_PUBLIC_SUPPORT_PHONE ?? '';

const STATUS: Record<CallState, string> = {
  checking: 'Checking whether voice support is available.',
  idle: 'Press Start call and speak when you hear the greeting.',
  unavailable: 'Voice support is busy right now. Try again in a few minutes, or use chat.',
  connecting: 'Connecting you to RelayPay support.',
  listening: 'Listening.',
  speaking: 'RelayPay is speaking.',
  ended: 'The call has ended.',
  error: '',
};

/** The mic error names its cause, because "something went wrong" leaves a caller with nothing to do. */
function describeError(e: unknown): string {
  const text = JSON.stringify(e ?? '') + String((e as any)?.message ?? e ?? '');
  const phone = PHONE ? `, or call ${PHONE}` : '';
  if (/NotAllowed|Permission|denied/i.test(text)) return `Microphone access was blocked. You can use chat instead${phone}.`;
  if (/NotFound|no.*device/i.test(text)) return `No microphone was found. You can use chat instead${phone}.`;
  return `The call could not connect. Try again in a moment, or use chat instead${phone}.`;
}

const clock = (s: number) => `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`;

/** Seconds since the call connected, for the live strip. */
function useElapsed(running: boolean) {
  const [secs, setSecs] = useState(0);
  useEffect(() => {
    if (!running) return;
    const t0 = Date.now(); setSecs(0);
    const id = setInterval(() => setSecs(Math.floor((Date.now() - t0) / 1000)), 1000);
    return () => clearInterval(id);
  }, [running]);
  return secs;
}

export function VoicePanel({ onSwitchToChat, onCallActive }: { onSwitchToChat?: () => void; onCallActive?: (active: boolean) => void }) {
  const [state, setState] = useState<CallState>('checking');
  const [error, setError] = useState('');
  const [entries, setEntries] = useState<Entry[]>([]);
  const [muted, setMuted] = useState(false);
  const vapi = useRef<Vapi | null>(null);
  const meter = useRef<HTMLSpanElement>(null);
  const configured = Boolean(PUBLIC_KEY && ASSISTANT_ID);

  useEffect(() => {
    if (!configured) { setState('unavailable'); return; }
    let live = true;
    fetch('/api/voice/availability', { cache: 'no-store' }).then((r) => r.json())
      .then((a: { available: boolean }) => { if (live) setState(a.available ? 'idle' : 'unavailable'); })
      .catch(() => { if (live) setState('unavailable'); });
    return () => { live = false; };
  }, [configured]);

  const active = state === 'connecting' || state === 'listening' || state === 'speaking';
  const connected = state === 'listening' || state === 'speaking';
  const elapsed = useElapsed(connected);
  useEffect(() => { onCallActive?.(active); }, [active, onCallActive]);
  useEffect(() => () => { vapi.current?.stop(); }, []);

  async function start() {
    setError(''); setEntries([]); setMuted(false); setState('connecting');
    try {
      if (!vapi.current) {
        const { default: VapiClient } = await import('@vapi-ai/web');
        const v = new VapiClient(PUBLIC_KEY) as unknown as Vapi;
        v.on('call-start', () => setState('listening'));
        v.on('call-end', () => { setState('ended'); meter.current?.style.setProperty('--lvl', '0'); });
        v.on('speech-start', () => setState('speaking'));
        v.on('speech-end', () => { setState('listening'); meter.current?.style.setProperty('--lvl', '0'); });
        // Written straight to a CSS variable: ten updates a second should not re-render the transcript.
        v.on('volume-level', (level: number) => meter.current?.style.setProperty('--lvl', String(Math.min(1, Math.max(0, level)))));
        v.on('message', (m: any) => {
          if (m?.type !== 'transcript' || m.transcriptType !== 'final') return;
          setEntries((prev) => [...prev, { who: m.role === 'user' ? 'you' : 'relaypay', text: m.transcript, at: new Date().toISOString() }]);
        });
        v.on('error', (e: unknown) => { setError(describeError(e)); setState('error'); });
        vapi.current = v;
      }
      // The signed caller rides with the call, so the agent knows who is speaking without asking.
      const token = await fetch('/api/voice/token', { cache: 'no-store' }).then((r) => (r.ok ? r.json() : null)).catch(() => null);
      await vapi.current.start(ASSISTANT_ID, token?.token ? { metadata: { rp_caller: token.token } } : undefined);
    } catch (e) {
      setError(describeError(e)); setState('error');
    }
  }

  function toggleMute() {
    const next = !muted;
    try { vapi.current?.setMuted(next); setMuted(next); } catch { /* the call ended under us; the strip is about to go */ }
  }

  const status = state === 'error' ? error : !configured && state === 'unavailable'
    ? 'Voice support is not switched on for this page yet. Use chat instead.' : STATUS[state];
  const tone = state === 'error' ? 'bad' : active ? 'live' : undefined;

  return (
    <>
      {active ? (
        <div className="rp-live" data-state={state}>
          <div className="rp-live-main">
            <span className="rp-live-dot" aria-hidden="true" />
            <div>
              <p className="rp-live-title">{state === 'connecting' ? 'Connecting' : 'Call in progress'}</p>
              <p className="rp-status" role="status" aria-live="polite" data-tone="live">{muted && connected ? 'Your microphone is muted.' : status}</p>
            </div>
            {connected && <span className="rp-live-time" aria-label={`Call time ${clock(elapsed)}`}>{clock(elapsed)}</span>}
            <span className="rp-meter" ref={meter} aria-hidden="true" data-on={state === 'speaking'}><i /><i /><i /><i /><i /></span>
          </div>
          <div className="rp-live-actions">
            <button type="button" className="rp-btn rp-btn-quiet" aria-pressed={muted} disabled={!connected} onClick={toggleMute}>
              {muted ? <MicOffIcon size={18} /> : <MicIcon size={18} />}{muted ? 'Unmute' : 'Mute'}
            </button>
            <button type="button" className="rp-btn rp-btn-end" onClick={() => vapi.current?.stop()}>End call</button>
          </div>
        </div>
      ) : (
        <div className="rp-call-start" data-state={state}>
          <span className="rp-call-mark" aria-hidden="true"><PhoneIcon size={26} /></span>
          <p className="rp-call-title">{state === 'ended' ? 'Your call has ended' : 'Speak to RelayPay support'}</p>
          <p className="rp-status" role="status" aria-live="polite" data-tone={tone}>{status}</p>
          <div className="rp-row rp-call-actions">
            <button type="button" className="rp-btn" disabled={state === 'checking' || state === 'unavailable'} onClick={start}>
              <PhoneIcon size={18} />{state === 'ended' || state === 'error' ? 'Call again' : 'Start call'}
            </button>
            {onSwitchToChat && (state === 'error' || state === 'unavailable') &&
              <button type="button" className="rp-btn rp-btn-quiet" onClick={onSwitchToChat}>Use chat</button>}
          </div>
          <p className="rp-call-fine">Your browser will ask to use your microphone. Calls are transcribed so you can read along.</p>
        </div>
      )}
      {entries.length > 0 && (
        <div className="rp-desk-body rp-desk-body-call">
          <Transcript entries={entries} label="Call transcript" />
        </div>
      )}
    </>
  );
}
