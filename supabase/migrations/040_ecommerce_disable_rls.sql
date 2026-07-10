-- Disable RLS for e-commerce tables temporarily to allow sync

ALTER TABLE ecommerce_products DISABLE ROW LEVEL SECURITY;
ALTER TABLE ecommerce_orders DISABLE ROW LEVEL SECURITY;
