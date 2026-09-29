'use client';

import { useEffect, useRef, useState } from 'react';

type CallState = 'checking' | 'idle' | 'unavailable' | 'connecting' | 'listening' | 'speaking' | 'ended' | 'error';
type Vapi = { start(assistantId: string): Promise<unknown>; stop(): void; on(event: string, fn: (...a: any[]) => void): void; removeAllListeners?(): void };

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

export function VoicePanel({ onSwitchToChat, onCallActive }: { onSwitchToChat?: () => void; onCallActive?: (active: boolean) => void }) {
  const [state, setState] = useState<CallState>('checking');
  const [error, setError] = useState('');
  const [latest, setLatest] = useState<{ you: string; relaypay: string }>({ you: '', relaypay: '' });
  const vapi = useRef<Vapi | null>(null);
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
  useEffect(() => { onCallActive?.(active); }, [active, onCallActive]);
  useEffect(() => () => { vapi.current?.stop(); }, []);

  async function start() {
    setError(''); setLatest({ you: '', relaypay: '' }); setState('connecting');
    try {
      if (!vapi.current) {
        const { default: VapiClient } = await import('@vapi-ai/web');
        const v = new VapiClient(PUBLIC_KEY) as unknown as Vapi;
        v.on('call-start', () => setState('listening'));
        v.on('call-end', () => setState('ended'));
        v.on('speech-start', () => setState('speaking'));
        v.on('speech-end', () => setState('listening'));
        v.on('message', (m: any) => {
          if (m?.type !== 'transcript' || m.transcriptType !== 'final') return;
          setLatest((l) => (m.role === 'user' ? { ...l, you: m.transcript } : { ...l, relaypay: m.transcript }));
        });
        v.on('error', (e: unknown) => { setError(describeError(e)); setState('error'); });
        vapi.current = v;
      }
      await vapi.current.start(ASSISTANT_ID);
    } catch (e) {
      setError(describeError(e)); setState('error');
    }
  }

  const status = state === 'error' ? error : !configured && state === 'unavailable'
    ? 'Voice support is not switched on for this page yet. Use chat instead.' : STATUS[state];

  return (
    <div>
      <div className="rp-row">
        {active
          ? <button type="button" className="rp-btn" data-live="true" onClick={() => vapi.current?.stop()}>End call</button>
          : <button type="button" className="rp-btn" disabled={state === 'checking' || state === 'unavailable'} onClick={start}>
              {state === 'ended' || state === 'error' ? 'Call again' : 'Start call'}
            </button>}
        {onSwitchToChat && (state === 'error' || state === 'unavailable') &&
          <button type="button" className="rp-btn rp-btn-quiet" onClick={onSwitchToChat}>Use chat</button>}
      </div>
      <p className="rp-status" role="status" aria-live="polite" data-tone={state === 'error' ? 'bad' : active ? 'live' : undefined}>{status}</p>
      {(latest.you || latest.relaypay) && (
        <dl className="rp-captions" aria-label="Latest exchange">
          {latest.you && <div><dt>You</dt><dd>{latest.you}</dd></div>}
          {latest.relaypay && <div><dt>RelayPay</dt><dd>{latest.relaypay}</dd></div>}
        </dl>
      )}
    </div>
  );
}
