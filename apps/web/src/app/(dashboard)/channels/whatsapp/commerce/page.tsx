'use client';

import { useRouter, useSearchParams } from 'next/navigation';
import { CatalogueTab } from '@/components/whatsapp-shop/catalogue-tab';
import { OrdersTab } from '@/components/whatsapp-shop/orders-tab';
import { ShoppingBag } from 'lucide-react';

type CommerceTab = 'catalogue' | 'orders';

/**
 * WhatsApp Commerce — catalogue + orders.
 *
 * `?tab=` is the source of truth rather than local state seeded from a
 * mount-time `window.location.search` read. That mattered once the second
 * sidebar gained separate Catalog and Orders rows pointing at this same
 * page: the old mount-only effect never re-ran on a client-side
 * navigation, so going Catalog → Orders changed the URL but left the
 * catalogue rendered. `useSearchParams` is reactive, so both rows work
 * and each tab stays deep-linkable.
 */
export default function WhatsAppCommercePage() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const raw = searchParams.get('tab');
  const activeTab: CommerceTab = raw === 'orders' ? 'orders' : 'catalogue';

  const setActiveTab = (tab: CommerceTab) => {
    router.replace(`/channels/whatsapp/commerce?tab=${tab}`, { scroll: false });
  };

  return (
    <div className="space-y-6">
      <div className="flex justify-between items-start gap-4">
        <div>
          <h1 className="text-2xl font-bold text-foreground flex items-center gap-2">
            <ShoppingBag className="size-6 text-primary" />
            W-Commerce
          </h1>
          <p className="mt-1 text-sm text-muted-foreground">
            Manage your native WhatsApp product catalogs and customer shopping carts in one unified dashboard.
          </p>
        </div>
      </div>

      {/* Tabs Menu */}
      <div className="flex border-b border-border space-x-1">
        <button
          onClick={() => setActiveTab('catalogue')}
          className={`pb-3 px-4 text-sm font-semibold border-b-2 transition-all ${
            activeTab === 'catalogue'
              ? 'border-primary text-primary'
              : 'border-transparent text-muted-foreground hover:text-foreground'
          }`}
        >
          WhatsApp Catalogue
        </button>
        <button
          onClick={() => setActiveTab('orders')}
          className={`pb-3 px-4 text-sm font-semibold border-b-2 transition-all ${
            activeTab === 'orders'
              ? 'border-primary text-primary'
              : 'border-transparent text-muted-foreground hover:text-foreground'
          }`}
        >
          WhatsApp Orders
        </button>
      </div>

      {activeTab === 'catalogue' && <CatalogueTab />}
      {activeTab === 'orders' && <OrdersTab />}
    </div>
  );
}
