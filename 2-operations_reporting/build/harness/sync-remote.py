#!/usr/bin/env python3
"""
Applies the source of truth in ../code onto koya-ops-reporting.remote.json.

WHY THIS EXISTS
---------------
koya-ops-reporting.json is GENERATED and is a clean template: no credentials,
no instance ids, no positions anyone has dragged. koya-ops-reporting.remote.json
is an EXPORT of the live workflow: it carries credential references, n8n's own
node ids, webhook ids, and a layout somebody arranged by hand. Regenerating
over the top of the export would throw all of that away, and every credential
would have to be re-attached by hand after each import.

So this script is deliberately SURGICAL. It changes exactly three things and
touches nothing else:

  1. every Code node's jsCode, from ../code
  2. returnAll on the Airtable node — see THE 100-RECORD CLIFF below
  3. the timeout on the Claude node — 120s was not enough for the widest window
  4. the Discord chain at the end of the workflow

Everything else in the export is left alone on purpose: triggers (the live
workflow runs weekly, the template daily), positions, credentials, ids,
settings, and any node added in the n8n UI that the template does not know
about. Those are the live instance's business.

    python3 harness/build-workflow.py     # regenerate the template first
    python3 harness/sync-remote.py        # then push code/ onto the export
    python3 harness/sync-remote.py --check # verify only, write nothing

THE 100-RECORD CLIFF
--------------------
Airtable's API returns at most 100 records per response plus an `offset`
cursor, and the n8n node only follows that cursor when Return All is on. The
live export had it OFF — which is not an error, does not warn, and returns a
2xx: the workflow would simply have stopped at 100 projects and reported
success. The table holds 74 today, so it would have stayed invisible until
the 101st project and then understated every delivery metric at once. This
script asserts it stays on.
"""
import json
import pathlib
import sys

ROOT = pathlib.Path(__file__).resolve().parent.parent
CODE = ROOT / "code"
REMOTE = ROOT / "koya-ops-reporting.remote.json"
CHECK_ONLY = "--check" in sys.argv

# Node name -> the file in code/ that is its body. A name here that is not in
# the export is a hard failure: it means the live workflow has drifted from
# the source, and silently skipping it is how a "synced" file ships stale JS.
# The Claude call and the ceiling it needs. See the enforcement block below.
CLAUDE = "Claude — Generate Insights"
CLAUDE_TIMEOUT_MS = 300000

CODE_NODES = {
    "Resolve Reporting Period": "01-resolve-reporting-period.js",
    "Normalize Sales": "02-normalize-sales.js",
    "Normalize Delivery": "03-normalize-delivery.js",
    "Normalize People Ops": "04-normalize-people-ops.js",
    "Compute Metrics": "05-compute-metrics.js",
    "Build Claude Brief": "06-build-claude-brief.js",
    "Parse & Validate Insights": "07-parse-validate-insights.js",
    "Build Supabase Payloads": "08-build-supabase-payloads.js",
    "Verify Publish": "09-verify-publish.js",
    "Build Discord Report": "10-build-discord-report.js",
    "Build Failure Record": "11-build-failure-record.js",
}

AIRTABLE = "Fetch Delivery (Airtable)"
RESPOND = "Respond — Report Updated"
REPORT = "Build Discord Report"
DISCORD = "Post Report to Discord"
# What the node was called in the export before it did anything. Renamed so
# the export and the generated template agree, and so the node says what it
# does in the executions list.
DISCORD_OLD_NAMES = ["Discord"]

if not REMOTE.exists():
    raise SystemExit(f"\n  x {REMOTE.name} not found. Export the live workflow from n8n first.\n")

wf = json.loads(REMOTE.read_text())
nodes = wf["nodes"]
conns = wf.setdefault("connections", {})
by_name = {n["name"]: n for n in nodes}
changes = []


def rename(old, new):
    """Rename a node and every connection that mentions it. n8n addresses
    nodes by NAME, so a rename that misses the connection map produces a
    workflow that imports cleanly and is silently disconnected."""
    node = by_name.pop(old)
    node["name"] = new
    by_name[new] = node
    if old in conns:
        conns[new] = conns.pop(old)
    for conn in conns.values():
        for group in conn.get("main", []):
            for c in group:
                if c["node"] == old:
                    c["node"] = new


def wire(src, dst):
    c = conns.setdefault(src, {"main": [[]]})
    if not c["main"]:
        c["main"].append([])
    if not any(x["node"] == dst for x in c["main"][0]):
        c["main"][0].append({"node": dst, "type": "main", "index": 0})
        return True
    return False


def unwire(src, dst):
    c = conns.get(src)
    if not c:
        return False
    hit = False
    for group in c.get("main", []):
        for x in list(group):
            if x["node"] == dst:
                group.remove(x)
                hit = True
    return hit


# ---- 1. Code node bodies ------------------------------------
for name, filename in CODE_NODES.items():
    body = (CODE / filename).read_text()
    node = by_name.get(name)
    if node is None:
        if name == REPORT:
            continue  # created below
        raise SystemExit(
            f"\n  x the export has no node called {name!r}, but code/{filename} exists.\n"
            f"    Either the live workflow was renamed, or this map is stale.\n"
            f"    Fix one of them rather than letting the two drift.\n")
    if node["parameters"].get("jsCode") != body:
        node["parameters"]["jsCode"] = body
        changes.append(f"jsCode  {name}  <- code/{filename}")

# ---- 2. Airtable pagination ---------------------------------
air = by_name.get(AIRTABLE)
if air is None:
    raise SystemExit(f"\n  x the export has no {AIRTABLE!r} node.\n")
if air["parameters"].get("returnAll") is not True:
    air["parameters"]["returnAll"] = True
    air["parameters"].pop("limit", None)  # meaningless once returnAll is on
    changes.append(
        f"returnAll  {AIRTABLE}  -> true  (was off: the node would have "
        f"stopped at 100 records and reported success)")

# ---- 3. the Claude timeout ----------------------------------
# The live export carried 120000, which the year-to-date window exceeded:
# one non-streaming request, adaptive thinking before the answer, and three
# department sections to write. It failed safely - two tries, then the
# deterministic fallback - but the period most worth reading lost its
# commentary. Enforced here rather than left to the UI for the same reason
# returnAll is: it is a setting whose wrong value produces a plausible
# result, and those do not stay fixed unless something checks them.
claude = by_name.get(CLAUDE)
if claude is None:
    raise SystemExit(f"\n  x the export has no {CLAUDE!r} node.\n")
_opts = claude["parameters"].setdefault("options", {})
if _opts.get("timeout", 0) < CLAUDE_TIMEOUT_MS:
    was = _opts.get("timeout", "unset")
    _opts["timeout"] = CLAUDE_TIMEOUT_MS
    changes.append(
        f"timeout  {CLAUDE}  {was} -> {CLAUDE_TIMEOUT_MS} ms  (the widest window "
        f"was timing out and falling back to the rules-based summary)")

# ---- 4. the Discord chain -----------------------------------
for old in DISCORD_OLD_NAMES:
    if old in by_name and DISCORD not in by_name:
        rename(old, DISCORD)
        changes.append(f"renamed  {old!r} -> {DISCORD!r}")

discord = by_name.get(DISCORD)
if discord is None:
    raise SystemExit(
        f"\n  x no Discord node in the export.\n"
        f"    Add one in n8n and attach a Discord Webhook credential — the webhook\n"
        f"    URL is a bearer secret and must not be written into this file — then\n"
        f"    export again and re-run this script.\n")

if RESPOND not in by_name:
    raise SystemExit(f"\n  x the export has no {RESPOND!r} node to hang the report off.\n")

# The report builder goes BETWEEN the response and Discord. The caller is a
# browser waiting on a fetch; Discord is a third party that can be slow or
# down. Answer the caller first, then tell the channel.
if REPORT not in by_name:
    anchor = discord["position"]
    node = {
        "parameters": {"mode": "runOnceForAllItems", "jsCode": (CODE / CODE_NODES[REPORT]).read_text()},
        "name": REPORT,
        "type": "n8n-nodes-base.code",
        "typeVersion": 2,
        "position": [anchor[0], anchor[1]],
        "id": "build-discord-report",
        "notes": ("Composes the whole published report as Discord markdown and emits ONE ITEM "
                  "PER MESSAGE. Discord caps a message body at 2000 characters and rejects an "
                  "over-length POST outright rather than truncating it, so a single-message "
                  "design would fail on exactly the runs with the most to say."),
        "notesInFlow": False,
    }
    # Shift Discord right so the two do not land on top of each other.
    discord["position"] = [anchor[0] + 240, anchor[1]]
    nodes.append(node)
    by_name[REPORT] = node
    changes.append(f"added  {REPORT} (code/{CODE_NODES[REPORT]})")

# The Discord node posts one message per input item, in order.
want = {"authentication": "webhook", "content": "={{ $json.content }}", "options": {}}
if {k: discord["parameters"].get(k) for k in want} != want:
    discord["parameters"].update(want)
    changes.append(f"parameters  {DISCORD}  -> content from the report builder")

# A Discord outage must not fail a run whose report is already published and
# verified in Supabase. The dashboard is the record; this is the announcement.
for key, value in (("onError", "continueRegularOutput"), ("retryOnFail", True),
                   ("maxTries", 2), ("waitBetweenTries", 3000)):
    if discord.get(key) != value:
        discord[key] = value
        changes.append(f"{key}  {DISCORD}  -> {value}")

if unwire(RESPOND, DISCORD):
    changes.append(f"unwired  {RESPOND} -> {DISCORD}  (the builder goes between them)")
if wire(RESPOND, REPORT):
    changes.append(f"wired  {RESPOND} -> {REPORT}")
if wire(REPORT, DISCORD):
    changes.append(f"wired  {REPORT} -> {DISCORD}")

# ---- guard: nothing secret in the file ----------------------
# A credential REFERENCE (id + name) is fine and is how n8n re-attaches on
# import. A credential VALUE is not, and a Discord webhook URL pasted into
# the node's parameters instead of a credential is the easy way to leak one.
blob = json.dumps(wf)
for needle, what in [
    ("discord.com/api/webhooks", "a Discord webhook URL"),
    ("sb_secret_", "a Supabase secret key"),
    ("sk-ant-", "an Anthropic API key"),
]:
    if needle in blob:
        raise SystemExit(
            f"\n  x {what} appears in {REMOTE.name}. It must live in n8n's\n"
            f"    credential store, not in a workflow file that gets shared.\n")

# ---- report --------------------------------------------------
if CHECK_ONLY:
    if changes:
        print(f"\n  x {REMOTE.name} is stale:")
        for c in changes:
            print("    - " + c)
        print("\n    run: python3 harness/sync-remote.py\n")
        sys.exit(1)
    print(f"\n  OK {REMOTE.name} matches code/\n")
    sys.exit(0)

if not changes:
    print(f"\n  OK {REMOTE.name} already matches code/ — nothing to do.\n")
else:
    REMOTE.write_text(json.dumps(wf, indent=2, ensure_ascii=False) + "\n")
    print(f"\n  wrote {REMOTE.name}")
    for c in changes:
        print("    - " + c)
    print(f"\n  {len(nodes)} nodes. Credentials, ids, positions and triggers untouched.")
    print("  Re-import into n8n; the credential references come back with it.\n")
