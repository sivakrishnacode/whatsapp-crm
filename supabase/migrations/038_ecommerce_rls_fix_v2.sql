-- Fix RLS policies for e-commerce tables - remove role parameter

-- Recreate INSERT policy for ecommerce_products without role parameter
DROP POLICY IF EXISTS "Account members can insert e-commerce products" ON ecommerce_products;

CREATE POLICY "Account members can insert e-commerce products" ON ecommerce_products FOR INSERT
  WITH CHECK (
    EXISTS (
      SELECT 1 FROM ecommerce_integrations
      WHERE ecommerce_integrations.id = ecommerce_products.integration_id
      AND is_account_member(ecommerce_integrations.account_id)
    )
  );

-- Recreate INSERT policy for ecommerce_orders without role parameter
DROP POLICY IF EXISTS "Account members can insert e-commerce orders" ON ecommerce_orders;

CREATE POLICY "Account members can insert e-commerce orders" ON ecommerce_orders FOR INSERT
  WITH CHECK (
    EXISTS (
      SELECT 1 FROM ecommerce_integrations
      WHERE ecommerce_integrations.id = ecommerce_orders.integration_id
      AND is_account_member(ecommerce_integrations.account_id)
    )
  );
