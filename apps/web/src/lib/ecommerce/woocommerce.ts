export interface WooCommerceProduct {
  id: number;
  name: string;
  description?: string;
  price: string;
  regular_price?: string;
  images: Array<{
    src: string;
  }>;
  stock_quantity?: number;
  permalink: string;
  date_created: string;
  date_modified: string;
}

export interface WooCommerceOrder {
  id: number;
  order_number: number;
  total: string;
  currency: string;
  status: string;
  date_created: string;
  date_modified: string;
  billing?: {
    first_name?: string;
    last_name?: string;
    email?: string;
    phone?: string;
  };
}

export class WooCommerceClient {
  private storeUrl: string;
  private consumerKey: string;
  private consumerSecret: string;

  constructor(storeUrl: string, consumerKey: string, consumerSecret: string) {
    this.storeUrl = storeUrl.replace(/\/$/, '');
    this.consumerKey = consumerKey;
    this.consumerSecret = consumerSecret;
  }

  private async request(endpoint: string, options?: RequestInit): Promise<Response> {
    const url = `${this.storeUrl}/wp-json/wc/v3${endpoint}`;
    const auth = Buffer.from(`${this.consumerKey}:${this.consumerSecret}`).toString('base64');
    
    const response = await fetch(url, {
      ...options,
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Basic ${auth}`,
        ...options?.headers,
      },
    });

    if (!response.ok) {
      throw new Error(`WooCommerce API error: ${response.status} ${response.statusText}`);
    }

    return response;
  }

  async getProducts(perPage = 100, page = 1): Promise<WooCommerceProduct[]> {
    const response = await this.request(`/products?per_page=${perPage}&page=${page}`);
    return response.json();
  }

  async getAllProducts(): Promise<WooCommerceProduct[]> {
    const products: WooCommerceProduct[] = [];
    let page = 1;
    let hasMore = true;

    while (hasMore) {
      const batch = await this.getProducts(100, page);
      if (batch.length === 0) {
        hasMore = false;
      } else {
        products.push(...batch);
        page++;
      }
    }

    return products;
  }

  async getOrders(perPage = 100, page = 1): Promise<WooCommerceOrder[]> {
    const response = await this.request(`/orders?per_page=${perPage}&page=${page}`);
    return response.json();
  }

  async getAllOrders(): Promise<WooCommerceOrder[]> {
    const orders: WooCommerceOrder[] = [];
    let page = 1;
    let hasMore = true;

    while (hasMore) {
      const batch = await this.getOrders(100, page);
      if (batch.length === 0) {
        hasMore = false;
      } else {
        orders.push(...batch);
        page++;
      }
    }

    return orders;
  }

  async getOrder(orderId: number): Promise<WooCommerceOrder | null> {
    try {
      const response = await this.request(`/orders/${orderId}`);
      return response.json();
    } catch {
      return null;
    }
  }
}
