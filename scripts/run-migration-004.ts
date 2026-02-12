/**
 * Run migration-004: Add "reference" type to memory table.
 * Usage: bun run scripts/run-migration-004.ts
 */

import { createClient } from "@supabase/supabase-js";

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_ANON_KEY = process.env.SUPABASE_ANON_KEY;

if (!SUPABASE_URL || !SUPABASE_ANON_KEY) {
  console.error("SUPABASE_URL and SUPABASE_ANON_KEY must be set in .env");
  process.exit(1);
}

const supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY);

console.log("Running migration-004: Adding 'reference' type to memory table...");

const { data, error } = await supabase.rpc("exec_sql", {
  sql: `
    ALTER TABLE memory DROP CONSTRAINT IF EXISTS memory_type_check;
    ALTER TABLE memory ADD CONSTRAINT memory_type_check
      CHECK (type IN ('fact', 'goal', 'completed_goal', 'preference', 'agreement', 'decree', 'legal', 'reference'));
  `,
});

if (error) {
  console.error("Migration failed via RPC. You may need to run this SQL manually in the Supabase SQL Editor:");
  console.error(error.message);
  console.log("\nSQL to run manually:");
  console.log(`ALTER TABLE memory DROP CONSTRAINT IF EXISTS memory_type_check;`);
  console.log(`ALTER TABLE memory ADD CONSTRAINT memory_type_check`);
  console.log(`  CHECK (type IN ('fact', 'goal', 'completed_goal', 'preference', 'agreement', 'decree', 'legal', 'reference'));`);
  process.exit(1);
} else {
  console.log("Migration applied successfully!");
}
