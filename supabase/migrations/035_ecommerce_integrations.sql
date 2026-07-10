-- ============================================================
-- E-commerce Integrations (Shopify/WooCommerce)
--
-- This migration adds support for e-commerce platform integrations:
-- - Platform connection management (Shopify, WooCommerce)
-- - Product synchronization
-- - Order synchronization with contact linking
-- ============================================================

-- ============================================================
-- ECOMMERCE_INTEGRATIONS table
-- ============================================================
CREATE TABLE IF NOT EXISTS ecommerce_integrations (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id UUID NOT NULL,
  platform TEXT NOT NULL CHECK (platform IN ('shopify', 'woocommerce')),
  store_url TEXT NOT NULL,
  api_key TEXT,
  api_secret TEXT,
  access_token TEXT,
  status TEXT NOT NULL DEFAULT 'disconnected' CHECK (status IN ('connected', 'disconnected', 'error')),
  last_sync_at TIMESTAMPTZ,
  sync_error TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(account_id, platform)
);

CREATE INDEX IF NOT EXISTS idx_ecommerce_integrations_account ON ecommerce_integrations(account_id);

ALTER TABLE ecommerce_integrations ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Account members can view e-commerce integrations" ON ecommerce_integrations;
DROP POLICY IF EXISTS "Account members can manage e-commerce integrations" ON ecommerce_integrations;

CREATE POLICY "Account members can view e-commerce integrations" ON ecommerce_integrations FOR SELECT
  USING (is_account_member(account_id));

CREATE POLICY "Account members can manage e-commerce integrations" ON ecommerce_integrations FOR ALL
  USING (is_account_member(account_id, 'admin'))
  WITH CHECK (is_account_member(account_id, 'admin'));

-- ============================================================
-- ECOMMERCE_PRODUCTS table
-- ============================================================
CREATE TABLE IF NOT EXISTS ecommerce_products (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  integration_id UUID NOT NULL REFERENCES ecommerce_integrations(id) ON DELETE CASCADE,
  external_product_id TEXT NOT NULL,
  name TEXT NOT NULL,
  description TEXT,
  price NUMERIC(12,2) NOT NULL,
  currency TEXT NOT NULL DEFAULT 'USD',
  image_url TEXT,
  product_url TEXT NOT NULL,
  inventory_count INTEGER DEFAULT 0,
  sync_at TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(integration_id, external_product_id)
);

CREATE INDEX IF NOT EXISTS idx_ecommerce_products_integration ON ecommerce_products(integration_id);
CREATE INDEX IF NOT EXISTS idx_ecommerce_products_external ON ecommerce_products(external_product_id);

ALTER TABLE ecommerce_products ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Account members can view e-commerce products" ON ecommerce_products;
DROP POLICY IF EXISTS "Account members can insert e-commerce products" ON ecommerce_products;

CREATE POLICY "Account members can view e-commerce products" ON ecommerce_products FOR SELECT
  USING (
    EXISTS (
      SELECT 1 FROM ecommerce_integrations
      WHERE ecommerce_integrations.id = ecommerce_products.integration_id
      AND is_account_member(ecommerce_integrations.account_id)
    )
  );

CREATE POLICY "Account members can insert e-commerce products" ON ecommerce_products FOR INSERT
  WITH CHECK (
    EXISTS (
      SELECT 1 FROM ecommerce_integrations
      WHERE ecommerce_integrations.id = ecommerce_products.integration_id
      AND is_account_member(ecommerce_integrations.account_id, 'agent')
    )
  );

-- ============================================================
-- ECOMMERCE_ORDERS table
-- ============================================================
CREATE TABLE IF NOT EXISTS ecommerce_orders (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  integration_id UUID NOT NULL REFERENCES ecommerce_integrations(id) ON DELETE CASCADE,
  external_order_id TEXT NOT NULL,
  contact_id UUID REFERENCES contacts(id) ON DELETE SET NULL,
  total_amount NUMERIC(12,2) NOT NULL,
  currency TEXT NOT NULL DEFAULT 'USD',
  status TEXT NOT NULL,
  order_url TEXT NOT NULL,
  sync_at TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(integration_id, external_order_id)
);

CREATE INDEX IF NOT EXISTS idx_ecommerce_orders_integration ON ecommerce_orders(integration_id);
CREATE INDEX IF NOT EXISTS idx_ecommerce_orders_contact ON ecommerce_orders(contact_id);
CREATE INDEX IF NOT EXISTS idx_ecommerce_orders_external ON ecommerce_orders(external_order_id);

ALTER TABLE ecommerce_orders ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Account members can view e-commerce orders" ON ecommerce_orders;
DROP POLICY IF EXISTS "Account members can insert e-commerce orders" ON ecommerce_orders;

CREATE POLICY "Account members can view e-commerce orders" ON ecommerce_orders FOR SELECT
  USING (
    EXISTS (
      SELECT 1 FROM ecommerce_integrations
      WHERE ecommerce_integrations.id = ecommerce_orders.integration_id
      AND is_account_member(ecommerce_integrations.account_id)
    )
  );

CREATE POLICY "Account members can insert e-commerce orders" ON ecommerce_orders FOR INSERT
  WITH CHECK (
    EXISTS (
      SELECT 1 FROM ecommerce_integrations
      WHERE ecommerce_integrations.id = ecommerce_orders.integration_id
      AND is_account_member(ecommerce_integrations.account_id, 'agent')
    )
  );

-- ============================================================
-- Updated_at triggers
-- ============================================================
DROP TRIGGER IF EXISTS set_updated_at_ecommerce_integrations ON ecommerce_integrations;
CREATE TRIGGER set_updated_at_ecommerce_integrations
  BEFORE UPDATE ON ecommerce_integrations
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();
