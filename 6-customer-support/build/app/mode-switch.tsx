'use client';

import { useState } from 'react';
import { ChatPanel } from './chat-panel.tsx';
import { VoicePanel } from './voice-panel.tsx';
import { usePersisted } from './ui/use-persisted.ts';
import { ChatIcon, PhoneIcon } from './ui/icons.tsx';

/** Call and Chat as equals. The choice survives a refresh; a live call holds the page on Call until it ends. */
export function ModeSwitch({ hint, starters }: { hint: string; starters: string[] }) {
  const [mode, setMode] = usePersisted<'call' | 'chat'>('rp_mode', 'call', 'session');
  const [inCall, setInCall] = useState(false);
  return (
    <section className="rp-desk" aria-label="Contact support">
      <div className="rp-desk-head">
        <div className="rp-modes" role="group" aria-label="How to contact support" data-mode={mode}>
          <button type="button" aria-pressed={mode === 'call'} onClick={() => setMode('call')}><PhoneIcon size={18} />Call</button>
          <button type="button" aria-pressed={mode === 'chat'} disabled={inCall} title={inCall ? 'End the call to switch to chat' : undefined}
            onClick={() => setMode('chat')}><ChatIcon size={18} />Chat</button>
        </div>
        <span className="rp-desk-hint"><i aria-hidden="true" />{hint}</span>
      </div>
      {mode === 'call'
        ? <VoicePanel onSwitchToChat={() => setMode('chat')} onCallActive={setInCall} />
        : <ChatPanel starters={starters} />}
    </section>
  );
}
