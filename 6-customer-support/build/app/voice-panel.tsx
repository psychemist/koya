'use client';

import { useEffect, useRef, useState } from 'react';
import { Transcript, type Entry } from './transcript.tsx';
import { MicIcon, MicOffIcon, PhoneIcon } from './ui/icons.tsx';
import { Lines } from './ui/lines.tsx';
import { Feedback } from './ui/feedback.tsx';
import { primeTones, ring, tones } from './ui/tones.ts';
import { usePersisted } from './ui/use-persisted.ts';
import { requestsChanged } from './support/requests.tsx';

type CallState = 'checking' | 'idle' | 'unavailable' | 'connecting' | 'listening' | 'speaking' | 'ended' | 'error';
type Vapi = {
  start(assistantId: string, overrides?: { metadata?: Record<string, string>; firstMessage?: string }): Promise<{ id?: string } | null | unknown>; stop(): void; setMuted(mute: boolean): void;
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

/**
 * The closing line the agent says when a call is over (lib/lines.ts), however the transcriber spells and punctuates
 * it: the agent sends "support, goodbye", and the transcript comes back as "support. Goodbye.", sometimes in two parts.
 */
const CLOSING = /thanks for calling relay ?pay support[\s,.!]*goodbye/i;

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

/**
 * The SDK is downloaded while the caller reads the page, not after they press Start call, so the press
 * does not wait on a script. A failed download is forgotten, and the press tries again.
 */
let sdk: Promise<any> | null = null;
const loadSdk = () => (sdk ??= import('@vapi-ai/web').then((m) => m.default).catch((e) => { sdk = null; throw e; }));

/**
 * Where the seconds between Start call and the greeting go, one console line per call. Vapi reports each
 * connect stage itself (call-start-progress); the page adds the moments the caller notices.
 */
function startTimer() {
  const t0 = performance.now();
  const stages: string[] = [];
  let done = false;
  const ms = () => Math.round(performance.now() - t0);
  return {
    stage(p: { stage?: string; status?: string; duration?: number }) {
      if (p?.status === 'completed' && typeof p.duration === 'number' && p.duration > 0) stages.push(`${p.stage} ${p.duration}ms`);
    },
    mark(label: string) { if (!done) stages.push(`${label} at ${ms()}ms`); },
    greeted() {
      if (done) return;
      done = true;
      console.info(`[voice timing] ${[...stages, `greeting heard at ${ms()}ms`].join(', ')}`);
    },
  };
}

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

export function VoicePanel({ onSwitchToChat, onCallActive, firstName }: {
  onSwitchToChat?: () => void; onCallActive?: (active: boolean) => void; firstName?: string;
}) {
  const [state, setState] = useState<CallState>('checking');
  const [error, setError] = useState('');
  const [entries, setEntries] = useState<Entry[]>([]);
  const [muted, setMuted] = useState(false);
  const [turn, setTurn] = useState<Turn>('greeting');
  const [callId, setCallId] = useState<string | null>(null);
  const [sound, setSound] = usePersisted('rp_call_sounds', true);
  const soundOn = useRef(sound);
  soundOn.current = sound;
  const cue = (name: keyof typeof tones) => { if (soundOn.current) tones[name](); };
  const vapi = useRef<Vapi | null>(null);
  const meter = useRef<HTMLSpanElement>(null);
  // End call pressed while the call is still connecting: the start is cancelled, not left to connect afterwards.
  const cancelled = useRef(false);
  // Whether a call is in progress. The SDK's stop() drops its speaking timer without clearing it, so a speech-end can
  // arrive up to a second after call-end; without this it put the live strip back on screen after End call.
  const live = useRef(false);
  // said: what the agent has said since the caller last spoke, so a closing line split across transcript parts still counts.
  const closing = useRef<{ heard: boolean; speaking: boolean; said: string; timer: ReturnType<typeof setTimeout> | null }>({ heard: false, speaking: false, said: '', timer: null });
  // Stops the ringback. It rings from Start call until RelayPay starts speaking, or the call ends first.
  const stopRing = useRef<() => void>(() => {});
  const configured = Boolean(PUBLIC_KEY && ASSISTANT_ID);
  const timer = useRef<ReturnType<typeof startTimer> | null>(null);

  useEffect(() => {
    if (!configured) { setState('unavailable'); return; }
    loadSdk().catch(() => {});
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
  useEffect(() => () => { stopRing.current(); vapi.current?.stop(); }, []);

  /**
   * The agent's goodbye should end the call, and Vapi's end-call phrase does not always fire, which left calls
   * open and billing after the goodbye. So the page hangs up itself once the closing line has finished playing,
   * and at the latest a few seconds after it was heard.
   */
  function hangUpSoon(afterMs: number) {
    if (closing.current.timer) clearTimeout(closing.current.timer);
    closing.current.timer = setTimeout(() => { live.current = false; vapi.current?.stop(); }, afterMs);
  }

  async function start() {
    cancelled.current = false;
    live.current = true;
    setError(''); setEntries([]); setMuted(false); setTurn('greeting'); setCallId(null); setState('connecting');
    primeTones();
    if (closing.current.timer) clearTimeout(closing.current.timer);
    closing.current = { heard: false, speaking: false, said: '', timer: null };
    stopRing.current();
    if (soundOn.current) stopRing.current = ring();
    timer.current = startTimer();
    // The signed caller rides with the call, so the agent knows who is speaking without asking. Asked for
    // now, alongside the SDK, rather than after it.
    const tokenAsked = fetch('/api/voice/token', { cache: 'no-store' }).then((r) => (r.ok ? r.json() : null)).catch(() => null);
    try {
      if (!vapi.current) {
        // In development only, a browser test can hand the page a stand-in client, so the call screen can be
        // driven without a microphone, an agent or Vapi credits. The production build removes this branch.
        const fake = process.env.NODE_ENV !== 'production' ? (window as any).__RP_FAKE_VAPI__ : undefined;
        const VapiClient = fake ?? (await loadSdk());
        const v = new VapiClient(PUBLIC_KEY) as unknown as Vapi;
        v.on('call-start-progress', (p: any) => timer.current?.stage(p));
        v.on('call-start', () => { if (!live.current) return; timer.current?.mark('connected'); setTurn('greeting'); setState('listening'); });
        v.on('call-end', () => { live.current = false; stopRing.current(); if (closing.current.timer) clearTimeout(closing.current.timer); cue('ended'); requestsChanged(); setState('ended'); meter.current?.style.setProperty('--lvl', '0'); });
        v.on('speech-start', () => { if (!live.current) return; stopRing.current(); timer.current?.greeted(); closing.current.speaking = true; setTurn('agent'); setState('speaking'); });
        v.on('speech-end', () => {
          if (!live.current) return;
          closing.current.speaking = false;
          if (closing.current.heard) hangUpSoon(600);
          if (!closing.current.heard) cue('yourTurn');
          setTurn('you'); setState('listening'); meter.current?.style.setProperty('--lvl', '0'); });
        // Written straight to a CSS variable: ten updates a second should not re-render the transcript.
        v.on('volume-level', (level: number) => { if (live.current) meter.current?.style.setProperty('--lvl', String(Math.min(1, Math.max(0, level)))); });
        v.on('message', (m: any) => {
          if (!live.current) return;
          // The caller's own speech: started means we hear them, stopped means the agent is now working on it.
          if (m?.type === 'speech-update' && m.role === 'user') {
            if (m.status === 'started') setTurn('hearing');
            if (m.status === 'stopped') setTurn((t) => (t === 'hearing' ? 'thinking' : t));
            return;
          }
          if (m?.type !== 'transcript' || m.transcriptType !== 'final') return;
          if (m.role === 'user') setTurn((t) => (t === 'hearing' || t === 'you' ? 'thinking' : t));
          if (m.role === 'user') closing.current.said = '';
          else closing.current.said = `${closing.current.said} ${m.transcript ?? ''}`;
          if (m.role !== 'user' && CLOSING.test(closing.current.said) && !closing.current.heard) {
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
        v.on('error', (e: unknown) => { stopRing.current(); setError(describeError(e)); setState('error'); });
        vapi.current = v;
      }
      const token = await tokenAsked;
      timer.current?.mark('sdk and token ready');
      if (cancelled.current) { setState('ended'); return; }
      // A signed-in caller is greeted by name; the greeting is the only line Vapi speaks without the agent.
      const call = await vapi.current.start(ASSISTANT_ID, {
        ...(token?.token ? { metadata: { rp_caller: token.token } } : {}),
        ...(firstName ? { firstMessage: `Hi ${firstName}, you've reached RelayPay support. How can I help today?` } : {}),
      }) as { id?: string } | null;
      if (call?.id) setCallId(call.id);
      if (cancelled.current) vapi.current.stop();
    } catch (e) {
      stopRing.current();
      setError(describeError(e)); setState('error');
    }
  }

  function endCall() {
    cancelled.current = true;
    live.current = false;
    stopRing.current();
    vapi.current?.stop();
    if (state === 'connecting') setState('ended');
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
            <button type="button" className="rp-btn rp-btn-end" onClick={endCall}>End call</button>
          </div>
        </div>
      ) : (
        <div className="rp-call-start" data-state={state}>
          <span className="rp-call-mark" aria-hidden="true"><PhoneIcon size={26} /></span>
          <p className="rp-call-title">{state === 'ended' ? 'Your call has ended' : 'Speak to RelayPay Support'}</p>
          <p className="rp-status" role="status" aria-live="polite" data-tone={tone}><Lines text={status} /></p>
          <div className="rp-row rp-call-actions">
            <button type="button" className="rp-btn" disabled={state === 'checking' || state === 'unavailable'} onClick={start}>
              <PhoneIcon size={18} />{state === 'ended' || state === 'error' ? 'Call again' : 'Start call'}
            </button>
            {onSwitchToChat && (state === 'error' || state === 'unavailable') &&
              <button type="button" className="rp-btn rp-btn-quiet" onClick={onSwitchToChat}>Use chat</button>}
          </div>
          {state === 'ended' && callId && <Feedback key={callId} channel="voice_web" callId={callId} label="How was this call?" />}
          <p className="rp-call-fine"><Lines text="Your browser will ask to use your microphone. Calls are transcribed so you can read along." /></p>
          <button type="button" className="rp-link-btn rp-sound" aria-pressed={sound} onClick={() => setSound(!sound)}>
            Call sounds: {sound ? 'on' : 'off'}
          </button>
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
