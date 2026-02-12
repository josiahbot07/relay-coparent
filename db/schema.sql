-- Supabase Schema for Persistent Memory
-- Run this in Supabase SQL Editor (or via Supabase MCP)
-- This enables: conversation history, semantic search, goals tracking
--
-- After running this, set up the embed Edge Function and database webhook
-- so embeddings are generated automatically on every INSERT.

-- Required extensions
CREATE EXTENSION IF NOT EXISTS vector;
CREATE EXTENSION IF NOT EXISTS pg_net;

-- ============================================================
-- MESSAGES TABLE (Bot Chat History — Saia <-> Bot on Telegram)
-- ============================================================
CREATE TABLE IF NOT EXISTS messages (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  role TEXT NOT NULL CHECK (role IN ('user', 'assistant', 'system')),
  content TEXT NOT NULL,
  channel TEXT DEFAULT 'telegram',
  sender TEXT,
  metadata JSONB DEFAULT '{}',
  embedding VECTOR(1536)
);

CREATE INDEX IF NOT EXISTS idx_messages_created_at ON messages(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_messages_channel ON messages(channel);

-- ============================================================
-- EXCHANGES TABLE (iMessage History — Saia <-> Hong)
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

-- ============================================================
-- MEMORY TABLE (Facts & Goals)
-- ============================================================
CREATE TABLE IF NOT EXISTS memory (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW(),
  type TEXT NOT NULL CHECK (type IN ('fact', 'goal', 'completed_goal', 'preference', 'agreement', 'decree', 'legal')),
  content TEXT NOT NULL,
  source TEXT,
  deadline TIMESTAMPTZ,
  completed_at TIMESTAMPTZ,
  priority INTEGER DEFAULT 0,
  metadata JSONB DEFAULT '{}',
  embedding VECTOR(1536)
);

CREATE INDEX IF NOT EXISTS idx_memory_type ON memory(type);
CREATE INDEX IF NOT EXISTS idx_memory_created_at ON memory(created_at DESC);

-- ============================================================
-- LOGS TABLE (Observability - Optional)
-- ============================================================
CREATE TABLE IF NOT EXISTS logs (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  level TEXT DEFAULT 'info' CHECK (level IN ('debug', 'info', 'warn', 'error')),
  event TEXT NOT NULL,
  message TEXT,
  metadata JSONB DEFAULT '{}',
  session_id TEXT,
  duration_ms INTEGER
);

CREATE INDEX IF NOT EXISTS idx_logs_created_at ON logs(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_logs_level ON logs(level);

-- ============================================================
-- ROW LEVEL SECURITY
-- ============================================================
ALTER TABLE messages ENABLE ROW LEVEL SECURITY;
ALTER TABLE exchanges ENABLE ROW LEVEL SECURITY;
ALTER TABLE memory ENABLE ROW LEVEL SECURITY;
ALTER TABLE logs ENABLE ROW LEVEL SECURITY;

-- Allow all for service role (your bot uses service key)
CREATE POLICY "Allow all for service role" ON messages FOR ALL USING (true);
CREATE POLICY "Allow all for service role" ON exchanges FOR ALL USING (true);
CREATE POLICY "Allow all for service role" ON memory FOR ALL USING (true);
CREATE POLICY "Allow all for service role" ON logs FOR ALL USING (true);

-- ============================================================
-- HELPER FUNCTIONS
-- ============================================================

-- Get recent messages for context
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

-- Get active goals
CREATE OR REPLACE FUNCTION get_active_goals()
RETURNS TABLE (
  id UUID,
  content TEXT,
  deadline TIMESTAMPTZ,
  priority INTEGER
) AS $$
BEGIN
  RETURN QUERY
  SELECT m.id, m.content, m.deadline, m.priority
  FROM memory m
  WHERE m.type = 'goal'
  ORDER BY m.priority DESC, m.created_at DESC;
END;
$$ LANGUAGE plpgsql;

-- Get all facts
CREATE OR REPLACE FUNCTION get_facts()
RETURNS TABLE (
  id UUID,
  content TEXT
) AS $$
BEGIN
  RETURN QUERY
  SELECT m.id, m.content
  FROM memory m
  WHERE m.type = 'fact'
  ORDER BY m.created_at DESC;
END;
$$ LANGUAGE plpgsql;

-- Get all agreements
CREATE OR REPLACE FUNCTION get_agreements()
RETURNS TABLE (
  id UUID,
  content TEXT,
  created_at TIMESTAMPTZ
) AS $$
BEGIN
  RETURN QUERY
  SELECT m.id, m.content, m.created_at
  FROM memory m
  WHERE m.type = 'agreement'
  ORDER BY m.created_at DESC;
END;
$$ LANGUAGE plpgsql;

-- ============================================================
-- SEMANTIC SEARCH
-- ============================================================
-- Embeddings are generated automatically by the embed Edge Function
-- via database webhook. The search Edge Function calls these RPCs.

-- Match messages by embedding similarity
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
    m.id,
    m.content,
    m.role,
    m.sender,
    m.created_at,
    1 - (m.embedding <=> query_embedding) AS similarity
  FROM messages m
  WHERE m.embedding IS NOT NULL
    AND 1 - (m.embedding <=> query_embedding) > match_threshold
  ORDER BY m.embedding <=> query_embedding
  LIMIT match_count;
END;
$$ LANGUAGE plpgsql;

-- Match exchanges by embedding similarity (for future use when embeddings are enabled)
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
    e.id,
    e.content,
    e.sender,
    e.created_at,
    1 - (e.embedding <=> query_embedding) AS similarity
  FROM exchanges e
  WHERE e.embedding IS NOT NULL
    AND 1 - (e.embedding <=> query_embedding) > match_threshold
  ORDER BY e.embedding <=> query_embedding
  LIMIT match_count;
END;
$$ LANGUAGE plpgsql;

-- Match memory entries by embedding similarity
CREATE OR REPLACE FUNCTION match_memory(
  query_embedding VECTOR(1536),
  match_threshold FLOAT DEFAULT 0.7,
  match_count INT DEFAULT 10
)
RETURNS TABLE (
  id UUID,
  content TEXT,
  type TEXT,
  created_at TIMESTAMPTZ,
  similarity FLOAT
) AS $$
BEGIN
  RETURN QUERY
  SELECT
    m.id,
    m.content,
    m.type,
    m.created_at,
    1 - (m.embedding <=> query_embedding) AS similarity
  FROM memory m
  WHERE m.embedding IS NOT NULL
    AND 1 - (m.embedding <=> query_embedding) > match_threshold
  ORDER BY m.embedding <=> query_embedding
  LIMIT match_count;
END;
$$ LANGUAGE plpgsql;
