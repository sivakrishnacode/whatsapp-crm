-- ============================================================
-- Native WhatsApp Commerce (Products & Orders)
-- ============================================================

-- 1. WHATSAPP_PRODUCTS table
CREATE TABLE IF NOT EXISTS whatsapp_products (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id UUID NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  retailer_id TEXT NOT NULL, -- SKU / retailer identifier used on Meta Catalog
  name TEXT NOT NULL,
  description TEXT,
  price NUMERIC(12,2) NOT NULL,
  currency TEXT NOT NULL DEFAULT 'INR',
  image_url TEXT,
  is_active BOOLEAN DEFAULT TRUE,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(account_id, retailer_id)
);

CREATE INDEX IF NOT EXISTS idx_whatsapp_products_account ON whatsapp_products(account_id);
CREATE INDEX IF NOT EXISTS idx_whatsapp_products_retailer ON whatsapp_products(retailer_id);

ALTER TABLE whatsapp_products ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS whatsapp_products_select ON whatsapp_products;
DROP POLICY IF EXISTS whatsapp_products_insert ON whatsapp_products;
DROP POLICY IF EXISTS whatsapp_products_update ON whatsapp_products;
DROP POLICY IF EXISTS whatsapp_products_delete ON whatsapp_products;

CREATE POLICY whatsapp_products_select ON whatsapp_products FOR SELECT
  USING (is_account_member(account_id));

CREATE POLICY whatsapp_products_insert ON whatsapp_products FOR INSERT
  WITH CHECK (is_account_member(account_id, 'agent'));

CREATE POLICY whatsapp_products_update ON whatsapp_products FOR UPDATE
  USING (is_account_member(account_id, 'agent'));

CREATE POLICY whatsapp_products_delete ON whatsapp_products FOR DELETE
  USING (is_account_member(account_id, 'agent'));

-- 2. WHATSAPP_ORDERS table
CREATE TABLE IF NOT EXISTS whatsapp_orders (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id UUID NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  contact_id UUID REFERENCES contacts(id) ON DELETE SET NULL,
  whatsapp_message_id TEXT UNIQUE, -- Meta's unique ID for the incoming cart message
  total_amount NUMERIC(12,2) NOT NULL,
  currency TEXT NOT NULL DEFAULT 'INR',
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'confirmed', 'cancelled', 'fulfilled')),
  notes TEXT, -- Customer message/notes attached to the cart
  items JSONB NOT NULL DEFAULT '[]'::jsonb, -- Array of items ordered
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_whatsapp_orders_account ON whatsapp_orders(account_id);
CREATE INDEX IF NOT EXISTS idx_whatsapp_orders_contact ON whatsapp_orders(contact_id);

ALTER TABLE whatsapp_orders ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS whatsapp_orders_select ON whatsapp_orders;
DROP POLICY IF EXISTS whatsapp_orders_insert ON whatsapp_orders;
DROP POLICY IF EXISTS whatsapp_orders_update ON whatsapp_orders;
DROP POLICY IF EXISTS whatsapp_orders_delete ON whatsapp_orders;

CREATE POLICY whatsapp_orders_select ON whatsapp_orders FOR SELECT
  USING (is_account_member(account_id));

CREATE POLICY whatsapp_orders_insert ON whatsapp_orders FOR INSERT
  WITH CHECK (is_account_member(account_id, 'agent'));

CREATE POLICY whatsapp_orders_update ON whatsapp_orders FOR UPDATE
  USING (is_account_member(account_id, 'agent'));

CREATE POLICY whatsapp_orders_delete ON whatsapp_orders FOR DELETE
  USING (is_account_member(account_id, 'agent'));

-- Triggers for updated_at column
DROP TRIGGER IF EXISTS set_updated_at_whatsapp_products ON whatsapp_products;
CREATE TRIGGER set_updated_at_whatsapp_products
  BEFORE UPDATE ON whatsapp_products
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

DROP TRIGGER IF EXISTS set_updated_at_whatsapp_orders ON whatsapp_orders;
CREATE TRIGGER set_updated_at_whatsapp_orders
  BEFORE UPDATE ON whatsapp_orders
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();
