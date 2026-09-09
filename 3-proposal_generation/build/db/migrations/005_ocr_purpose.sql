-- ============================================================
-- 005_ocr_purpose
--
-- Adds 'ocr' to the recorded purposes of a Claude call.
--
-- A PDF that carries no text layer is a scan. Extraction returns nothing from
-- it, and until now that was the end of the road: the file was marked 'empty'
-- and the user was told to run it through OCR themselves.
--
-- The application can now read it, by sending the PDF to Claude as a document
-- block and letting the model's vision transcribe the pages. That is a paid
-- call like any other, so it needs its own purpose value — otherwise the cost
-- of reading scans is invisible inside whichever bucket it was miscounted as,
-- and the per-purpose spend breakdown on the System page stops being true.
-- ============================================================

ALTER TABLE ai_calls DROP CONSTRAINT IF EXISTS ai_calls_purpose_check;

ALTER TABLE ai_calls ADD CONSTRAINT ai_calls_purpose_check
  CHECK (purpose IN ('draft', 'section_regen', 'gap_analysis', 'grounding_judge', 'ocr'));
