'use client';

import { useState } from 'react';
import { ChatPanel } from './chat-panel.tsx';
import { VoicePanel } from './voice-panel.tsx';
import { RequestsTab } from './support/requests.tsx';
import { usePersisted } from './ui/use-persisted.ts';
import { ChatIcon, ChecklistIcon, PhoneIcon } from './ui/icons.tsx';
import type { CustomerRequest } from '../lib/customer-requests.ts';

type Mode = 'call' | 'chat' | 'requests';

/**
 * Call and Chat as equals, and for a signed-in customer a third tab with their tickets and specialist cases.
 * The choice survives a refresh; a live call holds the page on Call until it ends.
 */
export function ModeSwitch({ hint, starters, firstName, requests }: {
  hint: string; starters: string[]; firstName?: string; requests?: CustomerRequest[];
}) {
  const [stored, setMode] = usePersisted<Mode>('rp_mode', 'call', 'session');
  const [inCall, setInCall] = useState(false);
  const mode: Mode = stored === 'requests' && !requests ? 'call' : stored;
  const tabs: Mode[] = requests ? ['call', 'chat', 'requests'] : ['call', 'chat'];
  return (
    <section className="rp-desk" aria-label="Contact support">
      <div className="rp-desk-head">
        <div className="rp-modes" role="group" aria-label="How to contact support" data-mode={mode}
          style={{ ['--n' as string]: tabs.length, ['--i' as string]: tabs.indexOf(mode) }}>
          <button type="button" aria-pressed={mode === 'call'} onClick={() => setMode('call')}><PhoneIcon size={18} />Call</button>
          <button type="button" aria-pressed={mode === 'chat'} disabled={inCall} title={inCall ? 'End the call to switch to chat' : undefined}
            onClick={() => setMode('chat')}><ChatIcon size={18} />Chat</button>
          {requests && <button type="button" aria-pressed={mode === 'requests'} disabled={inCall} title={inCall ? 'End the call to see your requests' : undefined}
            onClick={() => setMode('requests')}><ChecklistIcon size={18} />Requests</button>}
        </div>
        <span className="rp-desk-hint"><i aria-hidden="true" />{hint}</span>
      </div>
      {mode === 'call' ? <VoicePanel onSwitchToChat={() => setMode('chat')} onCallActive={setInCall} firstName={firstName} />
        : mode === 'chat' ? <ChatPanel starters={starters} />
        : <RequestsTab initial={requests ?? []} />}
    </section>
  );
}
