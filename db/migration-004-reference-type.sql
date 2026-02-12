-- Migration 004: Add "reference" type to memory table
-- Allows storing reference documents (e.g., guidebooks, manuals) alongside legal docs

ALTER TABLE memory DROP CONSTRAINT IF EXISTS memory_type_check;
ALTER TABLE memory ADD CONSTRAINT memory_type_check
  CHECK (type IN ('fact', 'goal', 'completed_goal', 'preference', 'agreement', 'decree', 'legal', 'reference'));
