-- ============================================================
-- Koya Content Desk — migration 0008
--
-- Re-keying the publish queue on what is being published, not when.
--
-- A client's LinkedIn received the same post twice. The cause was one line:
--
--     key = `${requestId}:${channel}:${dueAt.toISOString().slice(0, 16)}`
--
-- For immediate publishing `dueAt` is `new Date()` read at approval time, so
-- the key named a MINUTE. The approve route re-enqueues every already-
-- approved channel on each approval and depends on this key to collapse the
-- repeats. One real run approved LinkedIn at 02:27:59 and X at 02:28:26; the
-- second approval re-enqueued LinkedIn under `...T02:28`, the ON CONFLICT
-- clause saw a key it had never seen, and a second row appeared for a post
-- already queued.
--
-- Every layer of the defence failed from that one cause. The unique index
-- had nothing to catch, because the keys differed. The conflict clause had
-- nothing to collapse. And the provider header, which exists precisely so a
-- retry cannot post twice, carried the two DIFFERENT keys down to LinkedIn,
-- so LinkedIn saw two distinct posts rather than one repeated. Approving all
-- three channels inside a single minute would have hidden this indefinitely.
--
-- The key now names the publication: request + channel + asset revision.
-- Approving the same revision again is the same post and collapses. A new
-- revision is a genuinely different post and gets its own row, which is what
-- the approval model already assumes when it says an approval names an exact
-- revision.
--
-- THE BACKFILL IS NOT COSMETIC. Without it, existing rows keep their old
-- time-shaped keys, so the first re-enqueue after deploy would compute a new
-- identity key, collide with nothing, and duplicate exactly the way this
-- migration exists to stop.
--
-- Rows that are already duplicates of each other cannot all take the
-- canonical key without violating the unique index, so one row per group
-- wins it and the rest are suffixed. The winner is the row that actually
-- went out where there is one, so a future enqueue collides with the copy
-- the provider has really seen rather than with an abandoned sibling.
--
-- Safe to re-run: the ranking is deterministic and re-running maps each row
-- to the same key it already holds.
-- ============================================================

with ranked as (
  select id,
         row_number() over (
           partition by request_id, channel, asset_revision
           order by (state = 'sent') desc, created_at
         ) as rn
    from public.publish_queue
)
update public.publish_queue q
   set idempotency_key =
         q.request_id || ':' || q.channel || ':' || q.asset_revision
         || case when r.rn = 1 then '' else ':dup' || r.rn end
  from ranked r
 where r.id = q.id;

comment on column public.publish_queue.idempotency_key is
  'request:channel:asset_revision — the identity of the publication. Never '
  'derived from a timestamp: a key that names a moment lets two approvals of '
  'the same post land in different minutes and both go out. See migration '
  '0008. A `:dupN` suffix marks a row that was already a duplicate before '
  'the re-key and is kept only for history.';
