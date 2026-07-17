'use client';

import { useState, useEffect } from 'react';
import { useRouter } from 'next/navigation';
import { toast } from 'sonner';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Input } from '@/components/ui/input';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import {
  ShoppingBag,
  Search,
  MessageSquare,
  Eye,
  Loader2,
  Calendar,
  DollarSign,
  User,
  ExternalLink,
} from 'lucide-react';

interface WhatsAppOrderItem {
  retailer_id: string;
  name: string;
  quantity: number;
  unit_price: number;
  currency: string;
}

interface WhatsAppOrder {
  id: string;
  whatsapp_message_id: string;
  total_amount: number;
  currency: string;
  status: 'pending' | 'confirmed' | 'cancelled' | 'fulfilled';
  notes: string | null;
  items: WhatsAppOrderItem[];
  created_at: string;
  contact?: {
    id: string;
    name: string;
    phone: string;
  };
}

export function OrdersTab() {
  const router = useRouter();
  const [orders, setOrders] = useState<WhatsAppOrder[]>([]);
  const [loading, setLoading] = useState(true);
  const [searchQuery, setSearchQuery] = useState('');
  const [statusFilter, setStatusFilter] = useState<string>('all');
  
  // Detail Dialog State
  const [detailOpen, setDetailOpen] = useState(false);
  const [selectedOrder, setSelectedOrder] = useState<WhatsAppOrder | null>(null);
  const [updatingStatus, setUpdatingStatus] = useState<string | null>(null);

  async function fetchOrders() {
    setLoading(true);
    try {
      const res = await fetch('/api/whatsapp/orders');
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Failed to fetch orders');
      setOrders(data.orders || []);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Failed to load orders');
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    fetchOrders();
  }, []);

  const handleUpdateStatus = async (orderId: string, newStatus: string) => {
    setUpdatingStatus(orderId);
    try {
      const res = await fetch(`/api/whatsapp/orders/${orderId}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ status: newStatus }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Failed to update status');
      
      toast.success(`Order status updated to ${newStatus}!`);
      // Update local state
      setOrders(prev => prev.map(o => o.id === orderId ? { ...o, status: newStatus as any } : o));
      if (selectedOrder && selectedOrder.id === orderId) {
        setSelectedOrder(prev => prev ? { ...prev, status: newStatus as any } : null);
      }
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Error updating status');
    } finally {
      setUpdatingStatus(null);
    }
  };

  const getStatusBadge = (status: string) => {
    switch (status) {
      case 'pending':
        return <Badge className="bg-yellow-500/10 text-yellow-500 border border-yellow-500/20">Pending</Badge>;
      case 'confirmed':
        return <Badge className="bg-blue-500/10 text-blue-500 border border-blue-500/20">Confirmed</Badge>;
      case 'fulfilled':
        return <Badge className="bg-green-500/10 text-green-500 border border-green-500/20">Fulfilled</Badge>;
      case 'cancelled':
        return <Badge className="bg-red-500/10 text-red-500 border border-red-500/20">Cancelled</Badge>;
      default:
        return <Badge variant="secondary">{status}</Badge>;
    }
  };

  const handleOpenDetail = (o: WhatsAppOrder) => {
    setSelectedOrder(o);
    setDetailOpen(true);
  };

  const filteredOrders = orders.filter((o) => {
    const matchesSearch =
      (o.contact?.name && o.contact.name.toLowerCase().includes(searchQuery.toLowerCase())) ||
      (o.contact?.phone && o.contact.phone.includes(searchQuery)) ||
      o.id.includes(searchQuery);

    const matchesStatus = statusFilter === 'all' || o.status === statusFilter;

    return matchesSearch && matchesStatus;
  });

  const formatDate = (dateStr: string) => {
    const date = new Date(dateStr);
    return date.toLocaleDateString('en-IN', {
      day: 'numeric',
      month: 'short',
      year: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
    });
  };

  return (
    <div className="space-y-4">
      {/* Search and Filters */}
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4">
        <div className="flex flex-1 flex-col sm:flex-row items-stretch sm:items-center gap-3">
          <div className="relative flex-1 max-w-sm">
            <Search className="absolute left-3 top-2.5 h-4 w-4 text-muted-foreground" />
            <Input
              placeholder="Search by customer name, phone..."
              className="pl-9 bg-muted/20 border-border"
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
            />
          </div>
          
          <Select value={statusFilter} onValueChange={(val) => setStatusFilter(val || 'all')}>
            <SelectTrigger className="w-full sm:w-[160px] bg-muted/20 border-border">
              <SelectValue placeholder="All Statuses" />
            </SelectTrigger>
            <SelectContent className="bg-card border-border">
              <SelectItem value="all">All Statuses</SelectItem>
              <SelectItem value="pending">Pending</SelectItem>
              <SelectItem value="confirmed">Confirmed</SelectItem>
              <SelectItem value="fulfilled">Fulfilled</SelectItem>
              <SelectItem value="cancelled">Cancelled</SelectItem>
            </SelectContent>
          </Select>
        </div>
      </div>

      {/* Content Table */}
      {loading ? (
        <div className="flex h-64 items-center justify-center">
          <Loader2 className="h-8 w-8 animate-spin text-primary" />
        </div>
      ) : filteredOrders.length === 0 ? (
        <div className="flex h-64 flex-col items-center justify-center rounded-xl border border-border border-dashed bg-card/50 text-center p-6">
          <ShoppingBag className="h-10 w-10 text-muted-foreground mb-3" />
          <p className="text-sm font-medium text-foreground">No orders found</p>
          <p className="text-xs text-muted-foreground mt-1 max-w-sm">
            {searchQuery || statusFilter !== 'all'
              ? 'Try modifying your search or status filters.'
              : 'Incoming customer shopping carts sent on WhatsApp will automatically appear here.'}
          </p>
        </div>
      ) : (
        <div className="rounded-xl border border-border bg-card overflow-hidden">
          <Table>
            <TableHeader className="bg-muted/10">
              <TableRow>
                <TableHead>Order Date</TableHead>
                <TableHead>Customer</TableHead>
                <TableHead>Phone</TableHead>
                <TableHead>Total Amount</TableHead>
                <TableHead>Status</TableHead>
                <TableHead>Items Count</TableHead>
                <TableHead className="text-right">Actions</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {filteredOrders.map((o) => (
                <TableRow key={o.id} className="hover:bg-muted/5">
                  <TableCell className="text-xs text-muted-foreground">
                    {formatDate(o.created_at)}
                  </TableCell>
                  <TableCell className="font-semibold text-foreground">
                    {o.contact?.name || 'Unknown Contact'}
                  </TableCell>
                  <TableCell className="text-xs font-mono">
                    {o.contact?.phone || '-'}
                  </TableCell>
                  <TableCell className="font-semibold text-primary">
                    {o.currency} {o.total_amount.toFixed(2)}
                  </TableCell>
                  <TableCell>{getStatusBadge(o.status)}</TableCell>
                  <TableCell className="text-xs font-medium text-muted-foreground">
                    {o.items?.reduce((sum, item) => sum + item.quantity, 0) || 0} items
                  </TableCell>
                  <TableCell className="text-right">
                    <div className="flex justify-end items-center gap-1.5">
                      <Button
                        variant="ghost"
                        size="icon"
                        className="h-8 w-8 hover:bg-muted"
                        title="View details"
                        onClick={() => handleOpenDetail(o)}
                      >
                        <Eye className="h-4.5 w-4.5 text-muted-foreground" />
                      </Button>
                      <Button
                        variant="ghost"
                        size="icon"
                        className="h-8 w-8 hover:bg-primary/10"
                        title="Open chat"
                        onClick={() => {
                          if (o.contact?.id) {
                            router.push(`/inbox?contactId=${o.contact.id}`);
                          } else {
                            router.push('/inbox');
                          }
                        }}
                      >
                        <MessageSquare className="h-4.5 w-4.5 text-muted-foreground hover:text-primary" />
                      </Button>
                    </div>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      )}

      {/* Details Dialog */}
      <Dialog open={detailOpen} onOpenChange={setDetailOpen}>
        <DialogContent className="sm:max-w-xl border-border bg-card">
          {selectedOrder && (
            <>
              <DialogHeader>
                <div className="flex justify-between items-start gap-4 pr-6">
                  <div>
                    <DialogTitle>Order Details</DialogTitle>
                    <DialogDescription className="text-xs mt-0.5">
                      ID: {selectedOrder.id}
                    </DialogDescription>
                  </div>
                  <div className="shrink-0">
                    {getStatusBadge(selectedOrder.status)}
                  </div>
                </div>
              </DialogHeader>

              {/* Order Meta Panels */}
              <div className="grid grid-cols-2 gap-4 rounded-xl border border-border bg-muted/10 p-3.5 text-sm">
                <div className="space-y-1.5">
                  <div className="flex items-center gap-1.5 text-xs text-muted-foreground font-medium">
                    <User className="h-3.5 w-3.5" />
                    Customer Details
                  </div>
                  <p className="font-semibold text-foreground">{selectedOrder.contact?.name || 'Unknown Contact'}</p>
                  <p className="text-xs font-mono text-muted-foreground">{selectedOrder.contact?.phone || '-'}</p>
                </div>
                <div className="space-y-1.5 border-l border-border/80 pl-4">
                  <div className="flex items-center gap-1.5 text-xs text-muted-foreground font-medium">
                    <Calendar className="h-3.5 w-3.5" />
                    Order Placed
                  </div>
                  <p className="text-xs text-foreground font-medium">{formatDate(selectedOrder.created_at)}</p>
                  {selectedOrder.notes && (
                    <p className="text-xs italic text-muted-foreground mt-1 line-clamp-2">
                      "{selectedOrder.notes}"
                    </p>
                  )}
                </div>
              </div>

              {/* Order Items List */}
              <div className="space-y-2">
                <h4 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">Order items</h4>
                <div className="rounded-xl border border-border overflow-hidden">
                  <Table>
                    <TableHeader className="bg-muted/10">
                      <TableRow>
                        <TableHead>SKU</TableHead>
                        <TableHead>Product Name</TableHead>
                        <TableHead className="text-right">Price</TableHead>
                        <TableHead className="text-center">Qty</TableHead>
                        <TableHead className="text-right font-semibold">Total</TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {selectedOrder.items?.map((item, idx) => (
                        <TableRow key={idx}>
                          <TableCell className="font-mono text-xs max-w-[80px] truncate">{item.retailer_id}</TableCell>
                          <TableCell className="font-medium text-foreground max-w-[140px] truncate">{item.name}</TableCell>
                          <TableCell className="text-right text-xs">
                            {item.currency} {item.unit_price.toFixed(2)}
                          </TableCell>
                          <TableCell className="text-center text-xs font-semibold">{item.quantity}</TableCell>
                          <TableCell className="text-right text-sm font-bold text-primary">
                            {item.currency} {(item.unit_price * item.quantity).toFixed(2)}
                          </TableCell>
                        </TableRow>
                      ))}
                    </TableBody>
                  </Table>
                </div>
              </div>

              {/* Total Summary */}
              <div className="flex justify-between items-center py-2 px-1 border-t border-border/50">
                <span className="text-sm font-medium text-muted-foreground">Grand Total</span>
                <span className="text-xl font-bold text-primary">
                  {selectedOrder.currency} {selectedOrder.total_amount.toFixed(2)}
                </span>
              </div>

              <DialogFooter className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4 pt-4 border-t border-border/50">
                {/* Status action selectors */}
                <div className="flex items-center gap-2">
                  <span className="text-xs text-muted-foreground font-medium">Update Status:</span>
                  <Select
                    value={selectedOrder.status}
                    onValueChange={(val) => handleUpdateStatus(selectedOrder.id, val || 'pending')}
                    disabled={updatingStatus === selectedOrder.id}
                  >
                    <SelectTrigger className="w-[140px] h-8 bg-muted/20 border-border">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent className="bg-card border-border">
                      <SelectItem value="pending">Pending</SelectItem>
                      <SelectItem value="confirmed">Confirmed</SelectItem>
                      <SelectItem value="fulfilled">Fulfilled</SelectItem>
                      <SelectItem value="cancelled">Cancelled</SelectItem>
                    </SelectContent>
                  </Select>
                  {updatingStatus === selectedOrder.id && (
                    <Loader2 className="h-4 w-4 animate-spin text-primary" />
                  )}
                </div>

                <div className="flex gap-2">
                  <Button
                    variant="outline"
                    className="h-9"
                    onClick={() => {
                      if (selectedOrder.contact?.id) {
                        router.push(`/inbox?contactId=${selectedOrder.contact.id}`);
                      } else {
                        router.push('/inbox');
                      }
                    }}
                  >
                    <MessageSquare className="h-4 w-4 mr-1.5" />
                    Open Chat
                  </Button>
                  <Button className="h-9" onClick={() => setDetailOpen(false)}>
                    Close
                  </Button>
                </div>
              </DialogFooter>
            </>
          )}
        </DialogContent>
      </Dialog>
    </div>
  );
}
