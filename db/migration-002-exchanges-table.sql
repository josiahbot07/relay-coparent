-- Migration 002: Separate exchanges table for iMessage tracking
-- Run in Supabase SQL Editor
--
-- This separates iMessage exchanges (Saia <-> Hong) from bot chat messages
-- (Saia <-> Bot) into two clean tables with clear sender attribution.

-- ============================================================
-- 1. CREATE EXCHANGES TABLE
-- ============================================================

CREATE TABLE IF NOT EXISTS exchanges (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  sender TEXT NOT NULL,
  content TEXT NOT NULL,
  original_timestamp TIMESTAMPTZ,
  metadata JSONB DEFAULT '{}',
  embedding VECTOR(1536)  -- exists for future use, no webhook = no cost
);

CREATE INDEX IF NOT EXISTS idx_exchanges_created_at ON exchanges(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_exchanges_sender ON exchanges(sender);

-- RLS
ALTER TABLE exchanges ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Allow all for service role" ON exchanges FOR ALL USING (true);

-- ============================================================
-- 2. ADD SENDER COLUMN TO MESSAGES
-- ============================================================

ALTER TABLE messages ADD COLUMN IF NOT EXISTS sender TEXT;

-- Backfill sender from role
UPDATE messages SET sender = CASE
  WHEN role = 'user' THEN 'Saia'
  WHEN role = 'assistant' THEN 'bot'
  WHEN role = 'system' THEN 'system'
END WHERE sender IS NULL;

-- ============================================================
-- 3. MIGRATE iMESSAGE DATA TO EXCHANGES
-- ============================================================

INSERT INTO exchanges (created_at, sender, content, original_timestamp, metadata)
SELECT
  m.created_at,
  CASE WHEN m.role = 'user' THEN 'Saia' WHEN m.role = 'system' THEN 'Hong' ELSE 'unknown' END,
  m.content,
  (m.metadata->>'original_timestamp')::timestamptz,
  m.metadata
FROM messages m
WHERE m.channel = 'imessage';

-- Remove migrated iMessage rows from messages
DELETE FROM messages WHERE channel = 'imessage';

-- Remove duplicate system-role forwards (the duplication bug)
DELETE FROM messages WHERE role = 'system' AND metadata->>'source' = 'imessage_forward';

-- ============================================================
-- 4. NEW RPCs FOR EXCHANGES
-- ============================================================

-- Get recent exchanges for context
CREATE OR REPLACE FUNCTION get_recent_exchanges(limit_count INTEGER DEFAULT 20)
RETURNS TABLE (
  id UUID,
  created_at TIMESTAMPTZ,
  sender TEXT,
  content TEXT
) AS $$
BEGIN
  RETURN QUERY
  SELECT e.id, e.created_at, e.sender, e.content
  FROM exchanges e
  ORDER BY e.created_at DESC
  LIMIT limit_count;
END;
$$ LANGUAGE plpgsql;

-- Semantic search on exchanges (for future use when embeddings are enabled)
CREATE OR REPLACE FUNCTION match_exchanges(
  query_embedding VECTOR(1536),
  match_threshold FLOAT DEFAULT 0.7,
  match_count INT DEFAULT 10
)
RETURNS TABLE (
  id UUID,
  content TEXT,
  sender TEXT,
  created_at TIMESTAMPTZ,
  similarity FLOAT
) AS $$
BEGIN
  RETURN QUERY
  SELECT
    e.id, e.content, e.sender, e.created_at,
    1 - (e.embedding <=> query_embedding) AS similarity
  FROM exchanges e
  WHERE e.embedding IS NOT NULL
    AND 1 - (e.embedding <=> query_embedding) > match_threshold
  ORDER BY e.embedding <=> query_embedding
  LIMIT match_count;
END;
$$ LANGUAGE plpgsql;

-- ============================================================
-- 5. UPDATE EXISTING RPCs TO INCLUDE SENDER
-- ============================================================

-- Must drop first — return type is changing (adding sender column)
DROP FUNCTION IF EXISTS get_recent_messages(integer);
DROP FUNCTION IF EXISTS match_messages(vector, float, int);

-- Updated: get_recent_messages now returns sender
CREATE OR REPLACE FUNCTION get_recent_messages(limit_count INTEGER DEFAULT 20)
RETURNS TABLE (
  id UUID,
  created_at TIMESTAMPTZ,
  role TEXT,
  content TEXT,
  sender TEXT
) AS $$
BEGIN
  RETURN QUERY
  SELECT m.id, m.created_at, m.role, m.content, m.sender
  FROM messages m
  ORDER BY m.created_at DESC
  LIMIT limit_count;
END;
$$ LANGUAGE plpgsql;

-- Updated: match_messages now returns sender
CREATE OR REPLACE FUNCTION match_messages(
  query_embedding VECTOR(1536),
  match_threshold FLOAT DEFAULT 0.7,
  match_count INT DEFAULT 10
)
RETURNS TABLE (
  id UUID,
  content TEXT,
  role TEXT,
  sender TEXT,
  created_at TIMESTAMPTZ,
  similarity FLOAT
) AS $$
BEGIN
  RETURN QUERY
  SELECT
    m.id, m.content, m.role, m.sender, m.created_at,
    1 - (m.embedding <=> query_embedding) AS similarity
  FROM messages m
  WHERE m.embedding IS NOT NULL
    AND 1 - (m.embedding <=> query_embedding) > match_threshold
  ORDER BY m.embedding <=> query_embedding
  LIMIT match_count;
END;
$$ LANGUAGE plpgsql;
