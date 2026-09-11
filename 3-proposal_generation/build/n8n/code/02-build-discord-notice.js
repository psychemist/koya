/**
 * The internal notification, built after the client email has gone.
 *
 * Kept deliberately short. A notification nobody reads is worse than none,
 * because it trains the channel to be ignored — so this is one line of what
 * happened plus the reference needed to find it, and nothing else.
 *
 * The client's email address is NOT included. It is personal data, the channel
 * is wider than the deal team, and the reference is enough to look it up.
 */

/**
 * The payload is read from the node that produced it, by name.
 *
 * `$input` here is the GMAIL RESPONSE — id, threadId, labelIds — because this
 * node sits directly after the send. It carries no `ref`, no `recipient` and
 * no `proposalId`. Reading the notice out of it put `undefined` in the
 * reference line and threw on `recipient.split`, which is the failure this
 * comment exists to stop coming back.
 *
 * Naming the node also survives an edit. A chain that relies on "whatever the
 * previous node emitted" breaks the moment someone inserts a step between the
 * send and this one; `$('Verify signature')` does not.
 */
function verifiedPayload() {
  try {
    return $('Verify signature').first().json || {};
  } catch (err) {
    // Unreachable in the wired workflow, and still guarded. See below.
    return {};
  }
}

const payload = verifiedPayload();

function sentResponse() {
  try {
    return $('Send client email').first().json || {};
  } catch (err) {
    return {};
  }
}

const sent = sentResponse();

const messageId = sent.id || sent.messageId || sent.threadId || 'unknown';
const ref = payload.ref || 'unknown';

/**
 * The domain only, and never the local part.
 *
 * `recipient` is guaranteed present by the shape check in the verify node, so
 * the guard is not about the happy path. It is about what a throw COSTS here:
 * this node runs after the client already has the email, and an exception
 * makes the workflow answer the app with a failure — at which point the app
 * correctly falls over to its own Resend lane and the client receives the
 * proposal twice. A missing internal notification is a nuisance. A duplicate
 * email to a client is something they see.
 */
function recipientDomain(value) {
  if (typeof value !== 'string') return 'their domain';
  const at = value.lastIndexOf('@');
  if (at === -1 || at === value.length - 1) return 'their domain';
  return value.slice(at + 1);
}

const lines = [
  `**Proposal sent** · \`${ref}\``,
  `Delivered to the client contact at ${recipientDomain(payload.recipient)}.`,
  `Message id: \`${messageId}\``,
];

if (payload.correlationId) {
  lines.push(`Correlation: \`${payload.correlationId}\``);
}

return [{
  json: {
    content: lines.join('\n'),
    // Echoed back to the app in the webhook response so the delivery row can
    // record which provider message this was.
    messageId,
    ref,
    proposalId: payload.proposalId || null,
    idempotencyKey: payload.idempotencyKey || null,
  },
}];
