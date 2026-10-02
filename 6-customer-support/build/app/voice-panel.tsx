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
  idle: 'Press Start call. RelayPay says hello first, then it is your turn to speak.',
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

/** The closing line the agent says when a call is over (lib/lines.ts), however the transcriber spells RelayPay. */
const CLOSING = /thanks for calling relay ?pay support,? goodbye/i;

/**
 * Whose turn it is on a live call. A caller should never have to guess when to talk: RelayPay greets first,
 * then the strip says "Your turn" until they speak, and shows when it is listening and when it is answering.
 */
type Turn = 'greeting' | 'agent' | 'you' | 'hearing' | 'thinking';
const TURN: Record<Turn, { title: string; hint: string }> = {
  greeting: { title: 'Connected. RelayPay is about to say hello', hint: 'Wait for the greeting to finish, then it is your turn.' },
  agent: { title: 'RelayPay is speaking', hint: 'Wait for it to finish, then it is your turn.' },
  you: { title: 'Your turn. Speak now', hint: 'Ask your question. RelayPay answers when you pause.' },
  hearing: { title: 'Listening to you', hint: 'Take your time. Read references out slowly, RelayPay waits for the whole thing.' },
  thinking: { title: 'Got it. Working on an answer', hint: 'RelayPay will reply in a moment.' },
};

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
  const [turn, setTurn] = useState<Turn>('greeting');
  const vapi = useRef<Vapi | null>(null);
  const meter = useRef<HTMLSpanElement>(null);
  const closing = useRef<{ heard: boolean; speaking: boolean; timer: ReturnType<typeof setTimeout> | null }>({ heard: false, speaking: false, timer: null });
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

  /**
   * The agent's goodbye should end the call, and Vapi's end-call phrase does not always fire, which left calls
   * open and billing after the goodbye. So the page hangs up itself once the closing line has finished playing,
   * and at the latest a few seconds after it was heard.
   */
  function hangUpSoon(afterMs: number) {
    if (closing.current.timer) clearTimeout(closing.current.timer);
    closing.current.timer = setTimeout(() => vapi.current?.stop(), afterMs);
  }

  async function start() {
    setError(''); setEntries([]); setMuted(false); setTurn('greeting'); setState('connecting');
    if (closing.current.timer) clearTimeout(closing.current.timer);
    closing.current = { heard: false, speaking: false, timer: null };
    try {
      if (!vapi.current) {
        // In development only, a browser test can hand the page a stand-in client, so the call screen can be
        // driven without a microphone, an agent or Vapi credits. The production build removes this branch.
        const fake = process.env.NODE_ENV !== 'production' ? (window as any).__RP_FAKE_VAPI__ : undefined;
        const VapiClient = fake ?? (await import('@vapi-ai/web')).default;
        const v = new VapiClient(PUBLIC_KEY) as unknown as Vapi;
        v.on('call-start', () => { setTurn('greeting'); setState('listening'); });
        v.on('call-end', () => { if (closing.current.timer) clearTimeout(closing.current.timer); setState('ended'); meter.current?.style.setProperty('--lvl', '0'); });
        v.on('speech-start', () => { closing.current.speaking = true; setTurn('agent'); setState('speaking'); });
        v.on('speech-end', () => {
          closing.current.speaking = false;
          if (closing.current.heard) hangUpSoon(600);
          setTurn('you'); setState('listening'); meter.current?.style.setProperty('--lvl', '0'); });
        // Written straight to a CSS variable: ten updates a second should not re-render the transcript.
        v.on('volume-level', (level: number) => meter.current?.style.setProperty('--lvl', String(Math.min(1, Math.max(0, level)))));
        v.on('message', (m: any) => {
          // The caller's own speech: started means we hear them, stopped means the agent is now working on it.
          if (m?.type === 'speech-update' && m.role === 'user') {
            if (m.status === 'started') setTurn('hearing');
            if (m.status === 'stopped') setTurn((t) => (t === 'hearing' ? 'thinking' : t));
            return;
          }
          if (m?.type !== 'transcript' || m.transcriptType !== 'final') return;
          if (m.role === 'user') setTurn((t) => (t === 'hearing' || t === 'you' ? 'thinking' : t));
          if (m.role !== 'user' && CLOSING.test(m.transcript ?? '') && !closing.current.heard) {
            closing.current.heard = true;
            hangUpSoon(closing.current.speaking ? 8000 : 900);
          }
          // The transcriber finalises speech in fragments. Fragments from the same speaker in a row are one turn,
          // so they join one row instead of stacking up short rows that make the window jump.
          const who = m.role === 'user' ? 'you' : 'relaypay';
          setEntries((prev) => {
            const before = prev.at(-1);
            if (before && before.who === who) return [...prev.slice(0, -1), { ...before, text: `${before.text} ${m.transcript}`.trim() }];
            return [...prev, { who, text: m.transcript, at: new Date().toISOString() }];
          });
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
        <div className="rp-live" data-state={state} data-turn={state === 'connecting' ? 'connecting' : muted ? 'muted' : turn}>
          <div className="rp-live-main">
            <span className="rp-live-badge" aria-hidden="true">{turn === 'you' || turn === 'hearing' ? <MicIcon size={20} /> : <PhoneIcon size={18} />}</span>
            <div role="status" aria-live="polite">
              <p className="rp-live-title">{state === 'connecting' ? 'Connecting you to RelayPay support' : muted ? 'Your microphone is muted' : TURN[turn].title}</p>
              <p className="rp-status">{state === 'connecting' ? 'Allow the microphone if your browser asks.' : muted ? 'Unmute to speak. RelayPay cannot hear you.' : TURN[turn].hint}</p>
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
