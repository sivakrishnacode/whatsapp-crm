-- Disable RLS permanently for e-commerce tables since sync requires it
-- Security is maintained at the integration level via the ecommerce_integrations table

ALTER TABLE ecommerce_products DISABLE ROW LEVEL SECURITY;
ALTER TABLE ecommerce_orders DISABLE ROW LEVEL SECURITY;
