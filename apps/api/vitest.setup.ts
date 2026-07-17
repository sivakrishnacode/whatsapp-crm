import 'dotenv/config';

// Dummy fallbacks for the pure/mocked test tier, which never touches a
// real Meta/Supabase service — only used when no real apps/api/.env is
// present (e.g. CI). Real values from .env (loaded above) always win.
process.env.ENCRYPTION_KEY ??= '0'.repeat(64);
process.env.SUPABASE_URL ??= 'https://test-project.supabase.co';
process.env.SUPABASE_JWT_ALG ??= 'ES256';
