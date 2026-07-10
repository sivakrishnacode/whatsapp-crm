-- ============================================================
-- Click-to-WhatsApp Ads (CTWA) Campaign Support
--
-- This migration adds support for tracking CTWA campaigns:
-- - Campaign management with Meta ad IDs
-- - Click tracking and attribution
-- - Conversion tracking from CTWA to conversations
-- ============================================================

-- ============================================================
-- CTWA_CAMPAIGNS table
-- ============================================================
CREATE TABLE IF NOT EXISTS ctwa_campaigns (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id UUID NOT NULL,
  name TEXT NOT NULL,
  meta_ad_id TEXT,
  meta_campaign_id TEXT,
  pre_filled_message TEXT,
  deep_link_url TEXT,
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'paused', 'archived')),
  click_count INTEGER DEFAULT 0,
  conversation_count INTEGER DEFAULT 0,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_ctwa_campaigns_account ON ctwa_campaigns(account_id);
CREATE INDEX IF NOT EXISTS idx_ctwa_campaigns_meta_ad ON ctwa_campaigns(meta_ad_id);

ALTER TABLE ctwa_campaigns ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Account members can view CTWA campaigns" ON ctwa_campaigns;
DROP POLICY IF EXISTS "Account members can manage CTWA campaigns" ON ctwa_campaigns;

CREATE POLICY "Account members can view CTWA campaigns" ON ctwa_campaigns FOR SELECT
  USING (is_account_member(account_id));

CREATE POLICY "Account members can manage CTWA campaigns" ON ctwa_campaigns FOR ALL
  USING (is_account_member(account_id, 'admin'))
  WITH CHECK (is_account_member(account_id, 'admin'));

-- ============================================================
-- CTWA_CLICKS table - tracks individual ad clicks
-- ============================================================
CREATE TABLE IF NOT EXISTS ctwa_clicks (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  campaign_id UUID NOT NULL REFERENCES ctwa_campaigns(id) ON DELETE CASCADE,
  contact_id UUID REFERENCES contacts(id) ON DELETE SET NULL,
  conversation_id UUID REFERENCES conversations(id) ON DELETE SET NULL,
  click_timestamp TIMESTAMPTZ DEFAULT NOW(),
  user_agent TEXT,
  referrer TEXT,
  ip_address TEXT,
  converted BOOLEAN DEFAULT FALSE,
  converted_at TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_ctwa_clicks_campaign ON ctwa_clicks(campaign_id);
CREATE INDEX IF NOT EXISTS idx_ctwa_clicks_contact ON ctwa_clicks(contact_id);
CREATE INDEX IF NOT EXISTS idx_ctwa_clicks_conversation ON ctwa_clicks(conversation_id);

ALTER TABLE ctwa_clicks ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Account members can view CTWA clicks" ON ctwa_clicks;
CREATE POLICY "Account members can view CTWA clicks" ON ctwa_clicks FOR SELECT
  USING (
    EXISTS (
      SELECT 1 FROM ctwa_campaigns
      WHERE ctwa_campaigns.id = ctwa_clicks.campaign_id
      AND is_account_member(ctwa_campaigns.account_id)
    )
  );

-- ============================================================
-- Updated_at trigger for ctwa_campaigns
-- ============================================================
DROP TRIGGER IF EXISTS set_updated_at_ctwa_campaigns ON ctwa_campaigns;
CREATE TRIGGER set_updated_at_ctwa_campaigns
  BEFORE UPDATE ON ctwa_campaigns
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

-- ============================================================
-- Function to increment click count
-- ============================================================
CREATE OR REPLACE FUNCTION increment_ctwa_click_count()
RETURNS TRIGGER AS $$
BEGIN
  UPDATE ctwa_campaigns
  SET click_count = click_count + 1,
      updated_at = NOW()
  WHERE id = NEW.campaign_id;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;

DROP TRIGGER IF EXISTS ctwa_click_insert_trigger ON ctwa_clicks;
CREATE TRIGGER ctwa_click_insert_trigger
  AFTER INSERT ON ctwa_clicks
  FOR EACH ROW EXECUTE FUNCTION increment_ctwa_click_count();

-- ============================================================
-- Function to increment conversation count on conversion
-- ============================================================
CREATE OR REPLACE FUNCTION increment_ctwa_conversation_count()
RETURNS TRIGGER AS $$
BEGIN
  IF NEW.converted = true AND (OLD.converted IS DISTINCT FROM NEW.converted OR OLD IS NULL) THEN
    UPDATE ctwa_campaigns
    SET conversation_count = conversation_count + 1,
        updated_at = NOW()
    WHERE id = NEW.campaign_id;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;

DROP TRIGGER IF EXISTS ctwa_click_update_trigger ON ctwa_clicks;
CREATE TRIGGER ctwa_click_update_trigger
  AFTER UPDATE ON ctwa_clicks
  FOR EACH ROW EXECUTE FUNCTION increment_ctwa_conversation_count();
