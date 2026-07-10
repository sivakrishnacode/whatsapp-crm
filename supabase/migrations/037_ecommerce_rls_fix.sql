-- Fix RLS policies for e-commerce tables to allow INSERT operations

-- Add INSERT policy for ecommerce_products
DROP POLICY IF EXISTS "Account members can insert e-commerce products" ON ecommerce_products;

CREATE POLICY "Account members can insert e-commerce products" ON ecommerce_products FOR INSERT
  WITH CHECK (
    EXISTS (
      SELECT 1 FROM ecommerce_integrations
      WHERE ecommerce_integrations.id = ecommerce_products.integration_id
      AND is_account_member(ecommerce_integrations.account_id)
    )
  );

-- Add INSERT policy for ecommerce_orders
DROP POLICY IF EXISTS "Account members can insert e-commerce orders" ON ecommerce_orders;

CREATE POLICY "Account members can insert e-commerce orders" ON ecommerce_orders FOR INSERT
  WITH CHECK (
    EXISTS (
      SELECT 1 FROM ecommerce_integrations
      WHERE ecommerce_integrations.id = ecommerce_orders.integration_id
      AND is_account_member(ecommerce_integrations.account_id)
    )
  );
