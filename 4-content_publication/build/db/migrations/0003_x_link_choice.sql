-- ============================================================
-- Koya Content Desk — migration 0003
--
-- Whether the X post carries its link, which is a PRICING decision.
--
-- X charges $0.015 for a post and $0.20 for a post containing a link. That is
-- more than thirteen times the price for one URL, and $0.20 is roughly 45% of
-- what producing the entire content pack costs. It is the single largest line
-- item in a run and it was being incurred silently, because every post this
-- system writes contains a link and nothing ever asked whether it had to.
--
-- Default true: the link is what the post is FOR, and quietly dropping it to
-- save money would be the system making an editorial decision to protect a
-- budget. The choice is offered at intake, priced in words rather than left to
-- be worked out, and the link is stripped at the publish boundary when the
-- answer is no.
--
-- Safe to re-run.
-- ============================================================

alter table public.content_requests
  add column if not exists x_include_link boolean not null default true;

comment on column public.content_requests.x_include_link is
  'X bills $0.015 per post and $0.20 if it contains a link. False strips the '
  'URL at the publish boundary, in lib/publish/links.ts, rather than asking '
  'the writer to produce a different post.';
