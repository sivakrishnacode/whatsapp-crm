'use client';

import { useState, useEffect } from 'react';
import { CatalogueTab } from '@/components/whatsapp-shop/catalogue-tab';
import { OrdersTab } from '@/components/whatsapp-shop/orders-tab';
import { ShoppingBag } from 'lucide-react';

export default function EcommercePage() {
  const [activeTab, setActiveTab] = useState<'catalogue' | 'orders'>('catalogue');

  useEffect(() => {
    if (typeof window !== 'undefined') {
      const params = new URLSearchParams(window.location.search);
      const tab = params.get('tab');
      if (tab === 'catalogue' || tab === 'orders') {
        setActiveTab(tab);
      }
    }
  }, []);

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
