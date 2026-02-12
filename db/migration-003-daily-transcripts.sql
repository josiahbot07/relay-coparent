-- Migration 003: Daily transcripts for exchange compaction
-- Run in Supabase SQL Editor
--
-- Compacts individual iMessage exchanges (1 row per message) into
-- daily transcripts (1 row per day). Reduces storage ~50x and
-- produces better semantic search targets than individual messages.

-- ============================================================
-- 1. CREATE DAILY_TRANSCRIPTS TABLE
-- ============================================================

CREATE TABLE IF NOT EXISTS daily_transcripts (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  date DATE NOT NULL UNIQUE,
  transcript TEXT NOT NULL,
  message_count INTEGER NOT NULL,
  metadata JSONB DEFAULT '{}',
  embedding VECTOR(1536)
);

CREATE INDEX IF NOT EXISTS idx_daily_transcripts_date ON daily_transcripts(date DESC);

-- RLS
ALTER TABLE daily_transcripts ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Allow all for service role" ON daily_transcripts FOR ALL USING (true);

-- ============================================================
-- 2. SEMANTIC SEARCH RPC
-- ============================================================

CREATE OR REPLACE FUNCTION match_daily_transcripts(
  query_embedding VECTOR(1536),
  match_threshold FLOAT DEFAULT 0.7,
  match_count INT DEFAULT 5
)
RETURNS TABLE (
  id UUID,
  date DATE,
  transcript TEXT,
  message_count INTEGER,
  created_at TIMESTAMPTZ,
  similarity FLOAT
) AS $$
BEGIN
  RETURN QUERY
  SELECT
    dt.id, dt.date, dt.transcript, dt.message_count, dt.created_at,
    1 - (dt.embedding <=> query_embedding) AS similarity
  FROM daily_transcripts dt
  WHERE dt.embedding IS NOT NULL
    AND 1 - (dt.embedding <=> query_embedding) > match_threshold
  ORDER BY dt.embedding <=> query_embedding
  LIMIT match_count;
END;
$$ LANGUAGE plpgsql;
