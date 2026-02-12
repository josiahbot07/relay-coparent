-- Migration 001: Add decree and legal content types to memory table
-- Run this in Supabase SQL Editor or via Supabase MCP
--
-- Adds 'decree' and 'legal' types so the bot can store divorce decree
-- sections and Utah family law statutes for semantic search.

-- Expand the type constraint to include new document types
ALTER TABLE memory DROP CONSTRAINT IF EXISTS memory_type_check;
ALTER TABLE memory ADD CONSTRAINT memory_type_check
  CHECK (type IN ('fact', 'goal', 'completed_goal', 'preference', 'agreement', 'decree', 'legal'));

-- Track where content came from (e.g., "decree.pdf", "utah-81-9-302")
ALTER TABLE memory ADD COLUMN IF NOT EXISTS source TEXT;
