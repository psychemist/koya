import type { ServerResponse } from 'node:http';
import type { SpeechSink } from './turn.ts';

/**
 * The reply to Vapi, as an OpenAI chat.completion.chunk stream: one frame per
 * approved line, then a stop frame and [DONE]. A caller who hangs up mid-turn
 * closes the socket; the turn still finishes and records, and every write
 * after that is dropped here rather than thrown.
 */
export function openSse(res: ServerResponse): SpeechSink & { finish(): void } {
  const id = `chatcmpl-${Date.now().toString(36)}`;
  const created = Math.floor(Date.now() / 1000);
  const write = (s: string) => { try { if (!res.writableEnded && !res.destroyed) res.write(s); } catch { /* client gone */ } };
  const frame = (delta: Record<string, string>, finish: string | null) => `data: ${JSON.stringify({ id, object: 'chat.completion.chunk',
    created, model: 'relaypay-support-agent', choices: [{ index: 0, delta, finish_reason: finish }] })}\n\n`;
  try { res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive' }); } catch { /* already sent */ }
  return {
    say(text: string, _kind?: 'filler' | 'reply') { write(frame({ content: `${text} ` }, null)); },   // a caller hears both kinds
    finish() {
      write(frame({}, 'stop'));
      write('data: [DONE]\n\n');
      try { if (!res.writableEnded) res.end(); } catch { /* client gone */ }
    },
  };
}
