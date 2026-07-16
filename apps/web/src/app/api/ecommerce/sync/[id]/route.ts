import { NextRequest, NextResponse } from 'next/server';
import { createClient } from '@/lib/supabase/server';
import { ShopifyClient } from '@/lib/ecommerce/shopify';
import { WooCommerceClient } from '@/lib/ecommerce/woocommerce';

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  
  try {
    const supabase = await createClient();
    const {
      data: { user },
    } = await supabase.auth.getUser();
    if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

    // Fetch integration details
    const { data: integration, error: integrationError } = await supabase
      .from('ecommerce_integrations')
      .select('*')
      .eq('id', id)
      .single();

    if (integrationError || !integration) {
      return NextResponse.json({ error: 'Integration not found' }, { status: 404 });
    }

    // Get account_id from integration
    const accountId = integration.account_id;

    // Check if integration has access token (OAuth) or API credentials
    if (!integration.access_token && (!integration.api_key || !integration.api_secret)) {
      return NextResponse.json({ 
        error: 'Integration not configured. Please complete OAuth or enter API credentials.' 
      }, { status: 400 });
    }

    let productsSynced = 0;
    let ordersSynced = 0;

    if (integration.platform === 'shopify') {
      console.log('[E-commerce Sync] Shopify integration data:', {
        store_url: integration.store_url,
        has_api_key: !!integration.api_key,
        has_api_secret: !!integration.api_secret,
        has_access_token: !!integration.access_token,
      });
      
      const client = new ShopifyClient(
        integration.store_url,
        integration.api_key || '',
        integration.api_secret || '',
        integration.access_token || undefined
      );

      // Sync products
      const shopifyProducts = await client.getProducts();
      console.log('[E-commerce Sync] Fetched products:', shopifyProducts.length);
      
      for (const product of shopifyProducts) {
        const { error } = await supabase.from('ecommerce_products').upsert({
          integration_id: integration.id,
          external_product_id: product.id,
          name: product.title,
          description: product.description,
          price: parseFloat(product.variants[0]?.price || '0'),
          currency: product.variants[0]?.price ? 'USD' : 'USD',
          image_url: product.images[0]?.url,
          product_url: `${integration.store_url}/products/${product.handle}`,
          inventory_count: product.variants[0]?.inventoryQuantity,
          sync_at: new Date().toISOString(),
        }, { onConflict: 'integration_id,external_product_id' });
        
        if (error) {
          console.error('[E-commerce Sync] Product upsert error:', error);
        } else {
          productsSynced++;
        }
      }

      // Sync orders
      const shopifyOrders = await client.getOrders();
      console.log('[E-commerce Sync] Fetched orders:', shopifyOrders.length);
      
      for (const order of shopifyOrders) {
        console.log('[E-commerce Sync] Processing order:', order.id, 'customer:', order.customer);
        
        // Fetch detailed customer information if customer ID exists
        let customerEmail = order.customer?.email;
        let customerPhone = order.customer?.phone;
        let customerFirstName = order.customer?.firstName;
        let customerLastName = order.customer?.lastName;
        
        if (order.customer?.id && (!customerEmail || !customerPhone)) {
          console.log('[E-commerce Sync] Fetching detailed customer info for:', order.customer.id);
          const customerDetails = await client.getCustomer(order.customer.id);
          if (customerDetails) {
            customerEmail = customerDetails.email;
            customerPhone = customerDetails.phone;
            customerFirstName = customerDetails.firstName;
            customerLastName = customerDetails.lastName;
            console.log('[E-commerce Sync] Got customer details:', { email: customerEmail, phone: customerPhone });
          }
        }
        
        // Try to find contact by phone or email
        let contactId: string | null = null;
        const phone = customerPhone?.replace(/\D/g, '');
        const email = customerEmail;

        if (phone) {
          const { data: contact } = await supabase
            .from('contacts')
            .select('id')
            .eq('phone_normalized', phone)
            .single();
          contactId = contact?.id || null;
        } else if (email) {
          const { data: contact } = await supabase
            .from('contacts')
            .select('id')
            .eq('email', email)
            .single();
          contactId = contact?.id || null;
        }

        // Create new contact if not found and customer data exists
        if (!contactId && order.customer) {
          console.log('[E-commerce Sync] Creating new contact for order:', order.id, 'phone:', phone, 'email:', email);
          
          const customerName = customerFirstName && customerLastName 
            ? `${customerFirstName} ${customerLastName}`.trim()
            : `Shopify Customer #${order.customer.id}`;
          
          // Only create contact if we have at least email or phone
          if (email || phone) {
            const { data: newContact, error: contactError } = await supabase
              .from('contacts')
              .insert({
                account_id: accountId,
                name: customerName,
                phone: phone || null,
                email: email || null,
                user_id: user.id,
              })
              .select('id')
              .single();
            
            if (contactError) {
              console.error('[E-commerce Sync] Contact creation error:', contactError);
            } else if (newContact) {
              contactId = newContact.id;
              console.log('[E-commerce Sync] Created new contact:', contactId);
            }
          } else {
            console.log('[E-commerce Sync] Skipping contact creation - no email or phone available');
          }
        }

        const { error } = await supabase.from('ecommerce_orders').upsert({
          integration_id: integration.id,
          external_order_id: order.id,
          contact_id: contactId,
          total_amount: parseFloat(order.totalPriceSet.shopMoney.amount),
          currency: order.totalPriceSet.shopMoney.currencyCode,
          status: order.displayFinancialStatus,
          order_url: `${integration.store_url}/admin/orders/${order.id}`,
          sync_at: new Date().toISOString(),
        }, { onConflict: 'integration_id,external_order_id' });
        
        if (error) {
          console.error('[E-commerce Sync] Order upsert error:', error);
        } else {
          ordersSynced++;
        }
      }
    } else if (integration.platform === 'woocommerce') {
      const client = new WooCommerceClient(
        integration.store_url,
        integration.api_key || '',
        integration.api_secret || ''
      );

      // Sync products
      const wooProducts = await client.getAllProducts();
      for (const product of wooProducts) {
        const { error } = await supabase.from('ecommerce_products').upsert({
          integration_id: integration.id,
          external_product_id: String(product.id),
          name: product.name,
          description: product.description,
          price: parseFloat(product.price),
          currency: 'USD',
          image_url: product.images[0]?.src,
          product_url: product.permalink,
          inventory_count: product.stock_quantity,
          sync_at: new Date().toISOString(),
        }, { onConflict: 'integration_id,external_product_id' });
        
        if (!error) productsSynced++;
      }

      // Sync orders
      const wooOrders = await client.getAllOrders();
      for (const order of wooOrders) {
        // Try to find contact by phone or email
        let contactId: string | null = null;
        const phone = order.billing?.phone?.replace(/\D/g, '');
        const email = order.billing?.email;

        if (phone) {
          const { data: contact } = await supabase
            .from('contacts')
            .select('id')
            .eq('phone_normalized', phone)
            .single();
          contactId = contact?.id || null;
        } else if (email) {
          const { data: contact } = await supabase
            .from('contacts')
            .select('id')
            .eq('email', email)
            .single();
          contactId = contact?.id || null;
        }

        const { error } = await supabase.from('ecommerce_orders').upsert({
          integration_id: integration.id,
          external_order_id: String(order.id),
          contact_id: contactId,
          total_amount: parseFloat(order.total),
          currency: order.currency,
          status: order.status,
          order_url: `${integration.store_url}/wp-admin/post.php?post=${order.id}&action=edit`,
          sync_at: new Date().toISOString(),
        }, { onConflict: 'integration_id,external_order_id' });
        
        if (!error) ordersSynced++;
      }
    }

    // Update integration status and last sync time
    const { error: updateError } = await supabase
      .from('ecommerce_integrations')
      .update({
        status: 'connected',
        last_sync_at: new Date().toISOString(),
        sync_error: null,
      })
      .eq('id', id);

    if (updateError) throw updateError;

    return NextResponse.json({
      success: true,
      products_synced: productsSynced,
      orders_synced: ordersSynced,
    });
  } catch (error) {
    console.error('[E-commerce Sync]', error);
    
    // Update integration with error status
    try {
      const supabase = await createClient();
      await supabase
        .from('ecommerce_integrations')
        .update({
          status: 'error',
          sync_error: error instanceof Error ? error.message : 'Sync failed',
        })
        .eq('id', id);
    } catch {}

    return NextResponse.json(
      { error: error instanceof Error ? error.message : 'Sync failed' },
      { status: 500 }
    );
  }
}
