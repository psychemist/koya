/**
 * A caller who is done: "bye", "that's all, thanks", "you can end the call". The whole utterance has to be a
 * sign-off, so "that's all I have, what's the fee?" is a question, not a goodbye. Short on purpose: anything
 * longer goes to the model, which still knows to say the closing line.
 */
const THANKS = String.raw`(?:thanks?(?: you)?(?: (?:so|very) much)?(?: for (?:your|the) help)?|cheers|appreciate it|great|perfect|cool|alright|all right|ok(?:ay)?)`;
const LEAD = String.raw`(?:(?:no|nope|nah|that's great|${THANKS})[ ,]+)*`;
const CORE = String.raw`(?:(?:good ?)?bye(?: bye)?(?: now)?|see (?:you|ya)|talk (?:to you )?later|have a (?:good|nice|great) (?:day|one|evening|night)` +
  String.raw`|(?:that'?s|that is) (?:all|it|everything)(?: (?:for (?:now|today)|i needed|i need))?|(?:i'?m|i am|we'?re) (?:done|good|all set|sorted)` +
  String.raw`|nothing (?:else|more)|no (?:more )?(?:other )?questions|(?:you can |please )?(?:end|hang up|stop|close)(?: up)?(?: (?:the|this) (?:call|chat))?` +
  String.raw`|end (?:the|this) (?:call|chat)(?: please)?)`;
const CLOSING = new RegExp(String.raw`^${LEAD}${CORE}(?:[ ,]+(?:${THANKS}|${CORE}))*$`);

export function isClosing(text: string): boolean {
  const t = text.toLowerCase().replace(/[’`]/g, "'").replace(/[^a-z' ]+/g, ' ').replace(/\s+/g, ' ').trim();
  return t.length > 0 && t.split(' ').length <= 12 && CLOSING.test(t);
}
