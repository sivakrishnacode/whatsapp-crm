export interface ShopifyProduct {
  id: string;
  title: string;
  description?: string;
  variants: Array<{
    id: string;
    price: string;
    inventoryQuantity?: number;
  }>;
  images: Array<{
    url: string;
  }>;
  handle: string;
  createdAt: string;
  updatedAt: string;
}

export interface ShopifyOrder {
  id: string;
  name: string;
  totalPriceSet: {
    shopMoney: {
      amount: string;
      currencyCode: string;
    };
  };
  displayFinancialStatus: string;
  createdAt: string;
  updatedAt: string;
  customer?: {
    id: string;
    firstName?: string;
    lastName?: string;
    email?: string;
    phone?: string;
  };
}

export class ShopifyClient {
  private storeUrl: string;
  private apiKey: string;
  private apiPassword: string;
  private accessToken: string;

  constructor(storeUrl: string, apiKey: string, apiPassword: string, accessToken?: string) {
    // Ensure store URL has protocol
    if (!storeUrl.startsWith('http://') && !storeUrl.startsWith('https://')) {
      storeUrl = `https://${storeUrl}`;
    }
    this.storeUrl = storeUrl.replace(/\/$/, '');
    this.apiKey = apiKey;
    this.apiPassword = apiPassword;
    this.accessToken = accessToken || '';
  }

  private get authHeader(): string {
    if (this.accessToken) {
      return this.accessToken;
    }
    return Buffer.from(`${this.apiKey}:${this.apiPassword}`).toString('base64');
  }

  private async request(query: string, variables?: Record<string, any>): Promise<any> {
    const url = `${this.storeUrl}/admin/api/2024-01/graphql.json`;
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
    };

    if (this.accessToken) {
      headers['X-Shopify-Access-Token'] = this.accessToken;
      console.log('[Shopify] Using OAuth token');
    } else {
      headers['Authorization'] = `Basic ${this.authHeader}`;
      console.log('[Shopify] Using Basic auth with key:', this.apiKey ? '***' : 'missing');
    }

    console.log('[Shopify] GraphQL Query:', query.substring(0, 100) + '...');
    const response = await fetch(url, {
      method: 'POST',
      headers,
      body: JSON.stringify({ query, variables }),
    });

    if (!response.ok) {
      console.error('[Shopify] Request failed:', response.status, response.statusText);
      throw new Error(`Shopify API error: ${response.status} ${response.statusText}`);
    }

    const data = await response.json();
    if (data.errors) {
      console.error('[Shopify] GraphQL errors:', data.errors);
      throw new Error(`GraphQL errors: ${JSON.stringify(data.errors)}`);
    }

    return data.data;
  }

  async getProducts(limit = 50): Promise<ShopifyProduct[]> {
    const query = `
      query getProducts($first: Int!) {
        products(first: $first) {
          nodes {
            id
            title
            description
            handle
            createdAt
            updatedAt
            images(first: 1) {
              nodes {
                url
              }
            }
            variants(first: 1) {
              nodes {
                id
                price
                inventoryQuantity
              }
            }
          }
        }
      }
    `;

    const data = await this.request(query, { first: limit });
    return data?.products?.nodes || [];
  }

  async getOrders(limit = 50, status = 'any'): Promise<ShopifyOrder[]> {
    const query = `
      query getOrders($first: Int!, $query: String) {
        orders(first: $first, query: $query) {
          nodes {
            id
            name
            totalPriceSet {
              shopMoney {
                amount
                currencyCode
              }
            }
            displayFinancialStatus
            createdAt
            updatedAt
            customer {
              id
            }
          }
        }
      }
    `;

    const statusQuery = status === 'any' ? '' : `status:${status}`;
    const data = await this.request(query, { first: limit, query: statusQuery });
    return data?.orders?.nodes || [];
  }

  async getCustomer(customerId: string): Promise<{ email?: string; phone?: string; firstName?: string; lastName?: string } | null> {
    const query = `
      query getCustomer($id: ID!) {
        customer(id: $id) {
          firstName
          lastName
          email
          phone
        }
      }
    `;

    try {
      const data = await this.request(query, { id: customerId });
      return data?.customer || null;
    } catch {
      return null;
    }
  }
}
