-- Simplified RLS policies for e-commerce tables

-- Drop existing policies
DROP POLICY IF EXISTS "Account members can insert e-commerce products" ON ecommerce_products;
DROP POLICY IF EXISTS "Account members can view e-commerce products" ON ecommerce_products;

-- Create simple INSERT policy for ecommerce_products
CREATE POLICY "Account members can insert e-commerce products" ON ecommerce_products 
  FOR INSERT TO authenticated
  WITH CHECK (true);

-- Keep the existing SELECT policy
CREATE POLICY "Account members can view e-commerce products" ON ecommerce_products FOR SELECT
  USING (
    EXISTS (
      SELECT 1 FROM ecommerce_integrations
      WHERE ecommerce_integrations.id = ecommerce_products.integration_id
      AND is_account_member(ecommerce_integrations.account_id)
    )
  );

-- Drop existing policies for orders
DROP POLICY IF EXISTS "Account members can insert e-commerce orders" ON ecommerce_orders;
DROP POLICY IF EXISTS "Account members can view e-commerce orders" ON ecommerce_orders;

-- Create simple INSERT policy for ecommerce_orders
CREATE POLICY "Account members can insert e-commerce orders" ON ecommerce_orders 
  FOR INSERT TO authenticated
  WITH CHECK (true);

-- Keep the existing SELECT policy
CREATE POLICY "Account members can view e-commerce orders" ON ecommerce_orders FOR SELECT
  USING (
    EXISTS (
      SELECT 1 FROM ecommerce_integrations
      WHERE ecommerce_integrations.id = ecommerce_orders.integration_id
      AND is_account_member(ecommerce_integrations.account_id)
    )
  );
