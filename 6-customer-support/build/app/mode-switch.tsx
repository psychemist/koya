'use client';

import { useState } from 'react';
import { ChatPanel } from './chat-panel.tsx';
import { VoicePanel } from './voice-panel.tsx';
import { usePersisted } from './ui/use-persisted.ts';

/** Call and Chat as equals. The choice survives a refresh; a live call holds the page on Call until it ends. */
export function ModeSwitch() {
  const [mode, setMode] = usePersisted<'call' | 'chat'>('rp_mode', 'call', 'session');
  const [inCall, setInCall] = useState(false);
  return (
    <div>
      <div className="rp-modes" role="group" aria-label="How to contact support">
        <button type="button" aria-pressed={mode === 'call'} onClick={() => setMode('call')}>Call</button>
        <button type="button" aria-pressed={mode === 'chat'} disabled={inCall} title={inCall ? 'End the call to switch to chat' : undefined}
          onClick={() => setMode('chat')}>Chat</button>
      </div>
      {mode === 'call'
        ? <VoicePanel onSwitchToChat={() => setMode('chat')} onCallActive={setInCall} />
        : <ChatPanel />}
    </div>
  );
}
