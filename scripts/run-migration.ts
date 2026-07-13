/**
 * Script to run the subscription system migration
 * Usage: npx tsx scripts/run-migration.ts
 */

import { createClient } from '@supabase/supabase-js';
import { readFileSync } from 'fs';
import { join } from 'path';

// Load environment variables
const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL || process.env.SUPABASE_URL;
const supabaseServiceKey = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_SECRET_KEY;

if (!supabaseUrl || !supabaseServiceKey) {
  console.error('Error: Missing required environment variables');
  console.error('Required: NEXT_PUBLIC_SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY (or SUPABASE_SECRET_KEY)');
  process.exit(1);
}

const supabaseServiceKeyStr = supabaseServiceKey as string;

// Create Supabase client with service role key
const supabase = createClient(supabaseUrl, supabaseServiceKeyStr, {
  auth: {
    autoRefreshToken: false,
    persistSession: false,
  },
});

async function runMigration() {
  try {
    console.log('🚀 Running subscription system migration...');

    // Read the migration file
    const migrationPath = join(process.cwd(), 'supabase/migrations/044_subscription_system.sql');
    const migrationSQL = readFileSync(migrationPath, 'utf-8');

    console.log('📄 Migration file loaded');

    // Split SQL by semicolons and execute each statement
    const statements = migrationSQL
      .split(';')
      .map(s => s.trim())
      .filter(s => s.length > 0 && !s.startsWith('--'));

    for (let i = 0; i < statements.length; i++) {
      const statement = statements[i];
      if (statement.length < 10) continue; // Skip empty/very short statements

      try {
        const { error } = await supabase.rpc('exec_sql', { sql: statement });
        if (error) {
          console.error(`❌ Statement ${i + 1}/${statements.length} failed:`, error.message);
          console.error('Statement:', statement.substring(0, 100) + '...');
          // Continue with next statement
        }
      } catch (err) {
        console.error(`❌ Statement ${i + 1}/${statements.length} threw:`, err);
      }
    }

    console.log('✅ Migration completed!');
  } catch (error) {
    console.error('❌ Error running migration:', error);
    process.exit(1);
  }
}

runMigration();
