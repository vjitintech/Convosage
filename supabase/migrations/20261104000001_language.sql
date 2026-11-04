-- Multilingual input: everything is shown and reasoned over in English; the original wording is kept for provenance.
alter table app.transcript_segments add column if not exists language text, add column if not exists original_text text;
alter table app.visual_evidence add column if not exists language text;
