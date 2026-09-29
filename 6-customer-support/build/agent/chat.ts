import { LINES } from '../lib/lines.ts';
/** The stored turns, as the same labelled block Vapi's history produces, so recovery reads the same on both channels. */
export function priorFromTurns(turns: { user_transcript: string; assistant_response: string }[], max = 12): string {
  return turns.flatMap((t) => [`Caller: ${t.user_transcript}`, `Agent: ${t.assistant_response}`]).slice(-max).join('\n');
}
export const endsChat = (reply: string) => reply.trim().endsWith(LINES.chatGoodbye);
