-- ============================================================
-- Migrations for Facebook Leads Integration
-- ============================================================

-- Create facebook_connections table
CREATE TABLE IF NOT EXISTS facebook_connections (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  fb_user_id TEXT NOT NULL,
  fb_user_name TEXT,
  access_token TEXT NOT NULL,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(user_id, fb_user_id)
);

CREATE INDEX IF NOT EXISTS idx_facebook_connections_user ON facebook_connections(user_id);

ALTER TABLE facebook_connections ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "Users can manage own connections" ON facebook_connections;
CREATE POLICY "Users can manage own connections" ON facebook_connections FOR ALL USING (auth.uid() = user_id);

-- Create facebook_pages table
CREATE TABLE IF NOT EXISTS facebook_pages (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  connection_id UUID NOT NULL REFERENCES facebook_connections(id) ON DELETE CASCADE,
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  page_id TEXT NOT NULL,
  page_name TEXT NOT NULL,
  page_access_token TEXT NOT NULL,
  is_syncing BOOLEAN NOT NULL DEFAULT false,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(user_id, page_id)
);

CREATE INDEX IF NOT EXISTS idx_facebook_pages_user ON facebook_pages(user_id);
CREATE INDEX IF NOT EXISTS idx_facebook_pages_connection ON facebook_pages(connection_id);

ALTER TABLE facebook_pages ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "Users can manage own pages" ON facebook_pages;
CREATE POLICY "Users can manage own pages" ON facebook_pages FOR ALL USING (auth.uid() = user_id);

-- Triggers for updated_at
DROP TRIGGER IF EXISTS set_updated_at ON facebook_connections;
DROP TRIGGER IF EXISTS set_updated_at ON facebook_pages;

CREATE TRIGGER set_updated_at BEFORE UPDATE ON facebook_connections FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();
CREATE TRIGGER set_updated_at BEFORE UPDATE ON facebook_pages FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();
