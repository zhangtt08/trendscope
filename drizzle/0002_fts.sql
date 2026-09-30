-- Stage 2 §6: FTS5 full-text search over content items.
-- App-layer sync (decision documented in ARCHITECTURE.md §7): the sync service
-- writes CJK-bigram-expanded documents; unicode61 tokenizer then supports
-- Chinese phrase matching. Backfill happens at boot (ensureFtsBackfilled).
CREATE VIRTUAL TABLE IF NOT EXISTS `fts_documents` USING fts5(
  title,
  body,
  author,
  tags,
  tokenize = 'unicode61'
);
