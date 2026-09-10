-- ============================================================
-- 008_style_gap_source
--
-- Adds 'style' to the set of things that can raise a gap.
--
-- The build had two gates that were enforced — grounding ("is this figure
-- real?") and gaps ("what is missing?") — and a voice specification that was
-- not. The house rules described the register in seven bullet points and
-- nothing ever checked the output against them. Guidance with no consequence
-- is advice, and this system is careful about that distinction everywhere
-- else, so the style gate exists to close it.
--
-- Its own detector value rather than reusing 'grounding', for the reason
-- migration 004 records at length: `syncGaps` reconciles, closing every open
-- gap from the same `detected_by` that is not in the candidate list it is
-- handed. A clean style pass sharing the grounding detector would silently
-- auto-resolve the ungrounded-figure gaps that block approval.
--
-- Everything this detector raises is ADVISORY. A blocking style gate stops a
-- proposal over a word choice, and a salesperson blocked twice by a thesaurus
-- will waive the third one without reading it — which is how a gate teaches
-- people to ignore gates.
-- ============================================================

ALTER TABLE gaps DROP CONSTRAINT IF EXISTS gaps_detected_by_check;

ALTER TABLE gaps ADD CONSTRAINT gaps_detected_by_check
  CHECK (detected_by IN ('validator', 'model', 'grounding', 'scanner', 'style'));
