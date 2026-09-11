/**
 * The failure path.
 *
 * Reached when signature verification fails, the payload is malformed, or
 * Gmail refuses. All three are reported to Discord and returned to the app
 * with a non-2xx status, which is what makes the app fail over to its own
 * Resend lane rather than silently reporting success.
 *
 * The distinction matters: a 401 means somebody sent us an unverifiable
 * request and no email should be attempted anywhere; a 500 means we tried and
 * could not, and the app should try the other lane.
 */
const item = $input.first().json;

/**
 * Two different things arrive here and they carry different fields.
 *
 *   the IF node's false branch   the verify node's refusal: status, reason,
 *                                and no ref, because a request that failed
 *                                verification has no payload we are willing
 *                                to quote back
 *   Gmail's error output         an `error` object, and nothing else at all
 *
 * The second case is why the reference is looked up by node name rather than
 * read off the input. A Gmail failure is the one alert somebody has to act on
 * — the client did not get the proposal — and an alert that says `unknown`
 * where the reference goes cannot be acted on. `Verify signature` still holds
 * the verified payload at this point, so the reference is there to be had.
 *
 * Guarded, because on the 401 path that node produced no payload either, and
 * a notifier that throws turns a reportable failure into a silent one.
 */
function verified() {
  try {
    return $('Verify signature').first().json || {};
  } catch (err) {
    return {};
  }
}

const payload = verified();

const status = item.status || 500;
const reason = item.reason || (item.error && item.error.message) || 'unknown failure';
const ref = item.ref || payload.ref || 'unknown';
const correlationId = item.correlationId || payload.correlationId || null;

const severity = status === 401 ? 'REJECTED' : 'FAILED';

const lines = [
  `**Proposal delivery ${severity}** · \`${ref}\``,
  `Reason: ${reason}`,
];

if (status === 401) {
  lines.push('An unverified request reached this workflow. Nothing was sent. Check that IKE_KOYA_WEBHOOK_SECRET on this n8n instance matches N8N_WEBHOOK_SECRET in the app.');
} else {
  lines.push('The application will fall back to its own send lane. Nothing was sent from here.');
}

if (correlationId) {
  lines.push(`Correlation: \`${correlationId}\``);
}

return [{
  json: {
    content: lines.join('\n'),
    status,
    reason,
    ref,
  },
}];
