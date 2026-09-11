/**
 * Generates the n8n workflow JSON from the .js files in n8n/code/.
 *
 * The workflow export is a build artefact and is never hand-edited. That is
 * the same discipline as Week 2, and for the same reason: an n8n export is a
 * single line of JSON with JavaScript embedded in string fields, so a Code
 * node edited in the n8n UI is invisible to review and untestable. Keeping the
 * bodies as real files means the JavaScript that runs in n8n is byte-for-byte
 * the text a reviewer reads here.
 *
 *   npm run build:workflow
 *
 * Then import n8n/koya-proposal-delivery.json into n8n, set the two
 * credentials and the IKE_KOYA_WEBHOOK_SECRET secret, and copy the production
 * webhook URL into N8N_PROPOSAL_WEBHOOK_URL.
 *
 * IKE_KOYA_WEBHOOK_SECRET is read from n8n Variables first and the process
 * environment second, because n8n Cloud exposes no process environment to a
 * Code node and self-hosted n8n blocks it unless
 * N8N_BLOCK_ENV_ACCESS_IN_NODE=false. See n8n/code/01-verify-signature.js.
 */
import { readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));

type Node = {
  id: string;
  name: string;
  type: string;
  typeVersion: number;
  position: [number, number];
  parameters: Record<string, unknown>;
  credentials?: Record<string, { id: string; name: string }>;
  onError?: string;
  notesInFlow?: boolean;
  notes?: string;
};

async function code(file: string): Promise<string> {
  return readFile(join(here, "code", file), "utf8");
}

async function main(): Promise<void> {
  const verify = await code("01-verify-signature.js");
  const notice = await code("02-build-discord-notice.js");
  const failure = await code("03-build-failure-notice.js");

  const nodes: Node[] = [
    {
      id: "webhook",
      name: "Proposal approved",
      type: "n8n-nodes-base.webhook",
      typeVersion: 2,
      position: [-260, 0],
      parameters: {
        httpMethod: "POST",
        path: "koya-proposal-delivery",
        // The app waits for the real outcome, so the workflow must not answer
        // before it knows one. "responseNode" hands that job to the explicit
        // respond nodes below.
        responseMode: "responseNode",
        options: { rawBody: false },
      },
      notes:
        "POST from the Proposal Studio after internal approval. Signed with HMAC-SHA256; the URL alone is not authorisation.",
      notesInFlow: true,
    },
    {
      id: "verify",
      name: "Verify signature",
      type: "n8n-nodes-base.code",
      typeVersion: 2,
      position: [-40, 0],
      parameters: { mode: "runOnceForAllItems", jsCode: verify },
      notes:
        "Constant-time HMAC check plus a 5-minute replay window, then a payload shape check. Fails closed if the secret is unset.",
      notesInFlow: true,
    },
    {
      id: "gate",
      name: "Verified?",
      type: "n8n-nodes-base.if",
      typeVersion: 2,
      position: [180, 0],
      parameters: {
        conditions: {
          options: { caseSensitive: true, leftValue: "", typeValidation: "strict", version: 2 },
          conditions: [
            {
              id: "ok",
              leftValue: "={{ $json.ok }}",
              rightValue: true,
              operator: { type: "boolean", operation: "true", singleValue: true },
            },
          ],
          combinator: "and",
        },
        options: {},
      },
    },
    {
      id: "gmail",
      name: "Send client email",
      type: "n8n-nodes-base.gmail",
      typeVersion: 2.1,
      position: [420, -120],
      parameters: {
        sendTo: "={{ $json.recipient }}",
        subject: "={{ $json.subject }}",
        emailType: "text",
        message: "={{ $json.bodyText }}",
        // The approver is copied so the record of who signed it off exists in
        // a mailbox as well as in the audit trail. Joined rather than passed
        // as an array because Gmail's ccList takes a comma-separated string,
        // and an empty list becomes an empty string, which it ignores.
        options: { ccList: "={{ ($json.cc || []).join(',') }}" },
      },
      credentials: {
        gmailOAuth2: { id: "REPLACE_WITH_YOUR_GMAIL_CREDENTIAL_ID", name: "Gmail account" },
      },
      // Continue rather than halt, so a Gmail failure reaches the failure
      // branch and is reported to the app — which then falls over to its own
      // Resend lane. Halting here would leave the app waiting for a timeout.
      onError: "continueErrorOutput",
      notes:
        "The proposal itself is not attached: the email carries the tokenised link, which is the same URL the client would click from anywhere.",
      notesInFlow: true,
    },
    {
      id: "buildNotice",
      name: "Build Discord notice",
      type: "n8n-nodes-base.code",
      typeVersion: 2,
      position: [660, -120],
      parameters: { mode: "runOnceForAllItems", jsCode: notice },
      notes: "One line plus the reference. The client's email address is deliberately omitted.",
      notesInFlow: true,
    },
    {
      id: "discordOk",
      name: "Notify team",
      type: "n8n-nodes-base.discord",
      typeVersion: 2,
      position: [900, -120],
      parameters: {
        authentication: "webhook",
        content: "={{ $json.content }}",
        options: {},
      },
      credentials: {
        discordWebhookApi: {
          id: "REPLACE_WITH_YOUR_DISCORD_CREDENTIAL_ID",
          name: "Discord webhook",
        },
      },
      // A failed notification must not fail the delivery. The client already
      // has the proposal; losing the internal ping is a nuisance, not an
      // incident, and reporting failure here would make the app send twice.
      onError: "continueRegularOutput",
    },
    {
      id: "respondOk",
      name: "Respond sent",
      type: "n8n-nodes-base.respondToWebhook",
      typeVersion: 1.1,
      position: [1140, -120],
      parameters: {
        respondWith: "json",
        responseBody:
          '={{ JSON.stringify({ ok: true, messageId: $(\'Build Discord notice\').first().json.messageId, ref: $(\'Build Discord notice\').first().json.ref }) }}',
        options: { responseCode: 200 },
      },
      notes: "The messageId is echoed so the app can store it on the delivery row.",
      notesInFlow: true,
    },
    {
      id: "buildFailure",
      name: "Build failure notice",
      type: "n8n-nodes-base.code",
      typeVersion: 2,
      position: [420, 140],
      parameters: { mode: "runOnceForAllItems", jsCode: failure },
      notes: "Distinguishes 401 (nothing should be sent anywhere) from 500 (try the other lane).",
      notesInFlow: true,
    },
    {
      id: "discordFail",
      name: "Alert team",
      type: "n8n-nodes-base.discord",
      typeVersion: 2,
      position: [660, 140],
      parameters: {
        authentication: "webhook",
        content: "={{ $json.content }}",
        options: {},
      },
      credentials: {
        discordWebhookApi: {
          id: "REPLACE_WITH_YOUR_DISCORD_CREDENTIAL_ID",
          name: "Discord webhook",
        },
      },
      onError: "continueRegularOutput",
    },
    {
      id: "respondFail",
      name: "Respond failed",
      type: "n8n-nodes-base.respondToWebhook",
      typeVersion: 1.1,
      position: [900, 140],
      parameters: {
        respondWith: "json",
        responseBody:
          "={{ JSON.stringify({ ok: false, reason: $('Build failure notice').first().json.reason }) }}",
        // A non-2xx is what tells the app to fall back. Returning 200 with an
        // error body would look like success to any client that checks status.
        options: { responseCode: "={{ $('Build failure notice').first().json.status }}" },
      },
    },
  ];

  const connections: Record<string, { main: { node: string; type: string; index: number }[][] }> = {
    "Proposal approved": { main: [[{ node: "Verify signature", type: "main", index: 0 }]] },
    "Verify signature": { main: [[{ node: "Verified?", type: "main", index: 0 }]] },
    "Verified?": {
      main: [
        [{ node: "Send client email", type: "main", index: 0 }],
        [{ node: "Build failure notice", type: "main", index: 0 }],
      ],
    },
    "Send client email": {
      main: [
        [{ node: "Build Discord notice", type: "main", index: 0 }],
        // The error output of the Gmail node.
        [{ node: "Build failure notice", type: "main", index: 0 }],
      ],
    },
    "Build Discord notice": { main: [[{ node: "Notify team", type: "main", index: 0 }]] },
    "Notify team": { main: [[{ node: "Respond sent", type: "main", index: 0 }]] },
    "Build failure notice": { main: [[{ node: "Alert team", type: "main", index: 0 }]] },
    "Alert team": { main: [[{ node: "Respond failed", type: "main", index: 0 }]] },
  };

  const workflow = {
    name: "Koya — Proposal Delivery",
    nodes,
    connections,
    settings: {
      executionOrder: "v1",
      // Keep failed executions for debugging; successes are noise once the
      // app has its own delivery record.
      saveDataErrorExecution: "all",
      saveDataSuccessExecution: "all",
      saveExecutionProgress: true,
    },
    staticData: null,
    pinData: {},
    meta: {
      generatedBy: "n8n/build-workflow.ts — do not hand-edit this file",
      generatedAt: "REPLACED_BELOW",
      sourceFiles: ["code/01-verify-signature.js", "code/02-build-discord-notice.js", "code/03-build-failure-notice.js"],
    },
  };

  // A timestamp inside the artefact would make every regeneration a diff, so
  // it records the source checksum instead of the time.
  const { createHash } = await import("node:crypto");
  workflow.meta.generatedAt = createHash("sha256")
    .update(verify + notice + failure, "utf8")
    .digest("hex")
    .slice(0, 16);

  const out = join(here, "koya-proposal-delivery.json");
  await writeFile(out, `${JSON.stringify(workflow, null, 2)}\n`, "utf8");

  console.log(`Wrote ${out}`);
  console.log(`  ${nodes.length} nodes, ${Object.keys(connections).length} connections`);
  console.log(`  source checksum ${workflow.meta.generatedAt}`);
}

main().catch((err: unknown) => {
  console.error(`Failed: ${err instanceof Error ? err.message : String(err)}`);
  process.exitCode = 1;
});
