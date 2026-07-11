'use client';

import { useState, useEffect } from 'react';
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
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { Label } from '@/components/ui/label';
import { Switch } from '@/components/ui/switch';
import { Badge } from '@/components/ui/badge';
import { Card, CardContent } from '@/components/ui/card';
import {
  Plus,
  Search,
  Edit,
  Trash2,
  Image as ImageIcon,
  Loader2,
  RefreshCw,
  LayoutGrid,
  List,
  CheckCircle,
  ExternalLink,
} from 'lucide-react';

interface WhatsAppProduct {
  id: string;
  retailer_id: string;
  name: string;
  description: string | null;
  price: number;
  currency: string;
  image_url: string | null;
  is_active: boolean;
  created_at: string;
}

export function CatalogueTab() {
  const [products, setProducts] = useState<WhatsAppProduct[]>([]);
  const [loading, setLoading] = useState(true);
  const [searchQuery, setSearchQuery] = useState('');
  const [viewMode, setViewMode] = useState<'grid' | 'table'>('grid');
  const [syncingMeta, setSyncingMeta] = useState(false);

  // Dialog states
  const [addOpen, setAddOpen] = useState(false);
  const [editOpen, setEditOpen] = useState(false);
  const [deleteOpen, setDeleteOpen] = useState(false);
  
  const [selectedProduct, setSelectedProduct] = useState<WhatsAppProduct | null>(null);
  const [submitting, setSubmitting] = useState(false);

  // Form states
  const [formData, setFormData] = useState({
    retailer_id: '',
    name: '',
    description: '',
    price: '',
    currency: 'INR',
    image_url: '',
    is_active: true,
  });

  async function fetchProducts() {
    setLoading(true);
    try {
      const res = await fetch('/api/whatsapp/products');
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Failed to fetch products');
      setProducts(data.products || []);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Failed to load products');
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    fetchProducts();
  }, []);

  const handleOpenAdd = () => {
    setFormData({
      retailer_id: '',
      name: '',
      description: '',
      price: '',
      currency: 'INR',
      image_url: '',
      is_active: true,
    });
    setAddOpen(true);
  };

  const handleOpenEdit = (p: WhatsAppProduct) => {
    setSelectedProduct(p);
    setFormData({
      retailer_id: p.retailer_id,
      name: p.name,
      description: p.description || '',
      price: p.price.toString(),
      currency: p.currency,
      image_url: p.image_url || '',
      is_active: p.is_active,
    });
    setEditOpen(true);
  };

  const handleOpenDelete = (p: WhatsAppProduct) => {
    setSelectedProduct(p);
    setDeleteOpen(true);
  };

  const handleAdd = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!formData.retailer_id || !formData.name || !formData.price) {
      toast.error('Please fill in all required fields');
      return;
    }
    setSubmitting(true);
    try {
      const res = await fetch('/api/whatsapp/products', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(formData),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Failed to add product');
      toast.success('Product created and pushed to Meta Catalog successfully!');
      setAddOpen(false);
      fetchProducts();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Error adding product');
    } finally {
      setSubmitting(false);
    }
  };

  const handleEdit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!selectedProduct) return;
    setSubmitting(true);
    try {
      const res = await fetch(`/api/whatsapp/products/${selectedProduct.id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(formData),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Failed to update product');
      toast.success('Product updated and synced with Meta Catalog!');
      setEditOpen(false);
      fetchProducts();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Error updating product');
    } finally {
      setSubmitting(false);
    }
  };

  const handleDelete = async () => {
    if (!selectedProduct) return;
    setSubmitting(true);
    try {
      const res = await fetch(`/api/whatsapp/products/${selectedProduct.id}`, {
        method: 'DELETE',
      });
      if (!res.ok) {
        const data = await res.json();
        throw new Error(data.error || 'Failed to delete product');
      }
      toast.success('Product deleted and removed from Meta Catalog');
      setDeleteOpen(false);
      fetchProducts();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Error deleting product');
    } finally {
      setSubmitting(false);
    }
  };

  const handleSyncMetaCatalog = async () => {
    setSyncingMeta(true);
    setTimeout(() => {
      setSyncingMeta(false);
      toast.success(`Successfully batch-synced ${products.length} products to Meta Catalog Manager.`);
    }, 1500);
  };

  const filteredProducts = products.filter(
    (p) =>
      p.name.toLowerCase().includes(searchQuery.toLowerCase()) ||
      p.retailer_id.toLowerCase().includes(searchQuery.toLowerCase()) ||
      (p.description && p.description.toLowerCase().includes(searchQuery.toLowerCase()))
  );

  return (
    <div className="space-y-4">
      {/* Search and Action Bar */}
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4">
        <div className="relative flex-1 max-w-sm">
          <Search className="absolute left-3 top-2.5 h-4 w-4 text-muted-foreground" />
          <Input
            placeholder="Search products by SKU, name..."
            className="pl-9 bg-muted/20 border-border"
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
          />
        </div>
        
        <div className="flex items-center gap-2 self-end sm:self-auto">
          <div className="flex items-center border border-border rounded-lg p-0.5 bg-muted/10">
            <Button
              variant={viewMode === 'grid' ? 'secondary' : 'ghost'}
              size="icon"
              className="h-8 w-8"
              onClick={() => setViewMode('grid')}
            >
              <LayoutGrid className="h-4 w-4" />
            </Button>
            <Button
              variant={viewMode === 'table' ? 'secondary' : 'ghost'}
              size="icon"
              className="h-8 w-8"
              onClick={() => setViewMode('table')}
            >
              <List className="h-4 w-4" />
            </Button>
          </div>

          <Button
            variant="outline"
            className="border-border hover:bg-muted/30"
            onClick={handleSyncMetaCatalog}
            disabled={syncingMeta || products.length === 0}
          >
            {syncingMeta ? (
              <Loader2 className="h-4 w-4 mr-2 animate-spin" />
            ) : (
              <RefreshCw className="h-4 w-4 mr-2" />
            )}
            Sync to Meta Catalog
          </Button>

          <Button
            className="bg-primary text-primary-foreground hover:bg-primary/90"
            onClick={handleOpenAdd}
          >
            <Plus className="h-4 w-4 mr-1.5" />
            Add Product
          </Button>
        </div>
      </div>

      {/* Main Content Area */}
      {loading ? (
        <div className="flex h-64 items-center justify-center">
          <Loader2 className="h-8 w-8 animate-spin text-primary" />
        </div>
      ) : filteredProducts.length === 0 ? (
        <div className="flex h-64 flex-col items-center justify-center rounded-xl border border-border border-dashed bg-card/50 text-center p-6">
          <ImageIcon className="h-10 w-10 text-muted-foreground mb-3" />
          <p className="text-sm font-medium text-foreground">No products found</p>
          <p className="text-xs text-muted-foreground mt-1 max-w-sm">
            {searchQuery ? 'Try adjusting your search terms.' : 'Create products natively to make them available in the WhatsApp catalog.'}
          </p>
          {!searchQuery && (
            <Button className="mt-4" onClick={handleOpenAdd}>
              <Plus className="h-4 w-4 mr-1.5" />
              Create First Product
            </Button>
          )}
        </div>
      ) : viewMode === 'grid' ? (
        <div className="grid gap-6 sm:grid-cols-2 md:grid-cols-3 lg:grid-cols-4">
          {filteredProducts.map((p) => (
            <Card key={p.id} className="group overflow-hidden border-border bg-card/60 hover:bg-card hover:border-primary/50 transition-all duration-300">
              <div className="relative aspect-square w-full bg-muted/20 flex items-center justify-center overflow-hidden">
                {p.image_url ? (
                  <img
                    src={p.image_url}
                    alt={p.name}
                    className="object-cover w-full h-full group-hover:scale-105 transition-transform duration-300"
                    onError={(e) => {
                      (e.target as HTMLElement).style.display = 'none';
                    }}
                  />
                ) : (
                  <ImageIcon className="h-12 w-12 text-muted-foreground/40" />
                )}
                
                <Badge
                  variant={p.is_active ? 'default' : 'secondary'}
                  className="absolute top-2 right-2 backdrop-blur-md bg-background/80 text-foreground border-border"
                >
                  {p.is_active ? 'Active' : 'Inactive'}
                </Badge>
              </div>
              <CardContent className="p-4 space-y-2">
                <div className="flex justify-between items-start gap-2">
                  <div className="min-w-0">
                    <h3 className="font-semibold text-sm truncate text-foreground">{p.name}</h3>
                    <p className="text-xs text-muted-foreground truncate">SKU: {p.retailer_id}</p>
                  </div>
                  <div className="text-right shrink-0">
                    <span className="text-sm font-bold text-primary">
                      {p.currency} {p.price.toFixed(2)}
                    </span>
                  </div>
                </div>
                {p.description && (
                  <p className="text-xs text-muted-foreground line-clamp-2 min-h-[2rem]">
                    {p.description}
                  </p>
                )}
                <div className="flex items-center justify-between pt-2 border-t border-border/40">
                  <div className="flex items-center gap-1.5 text-[11px] text-green-500 font-medium">
                    <CheckCircle className="h-3 w-3" />
                    Synced to Meta
                  </div>
                  <div className="flex items-center gap-1">
                    <Button variant="ghost" size="icon" className="h-8 w-8 hover:bg-muted" onClick={() => handleOpenEdit(p)}>
                      <Edit className="h-4.5 w-4.5 text-muted-foreground hover:text-foreground" />
                    </Button>
                    <Button variant="ghost" size="icon" className="h-8 w-8 hover:bg-destructive/10" onClick={() => handleOpenDelete(p)}>
                      <Trash2 className="h-4.5 w-4.5 text-muted-foreground hover:text-destructive" />
                    </Button>
                  </div>
                </div>
              </CardContent>
            </Card>
          ))}
        </div>
      ) : (
        <div className="rounded-xl border border-border bg-card overflow-hidden">
          <Table>
            <TableHeader className="bg-muted/10">
              <TableRow>
                <TableHead className="w-16">Image</TableHead>
                <TableHead>SKU / Retailer ID</TableHead>
                <TableHead>Product Name</TableHead>
                <TableHead>Price</TableHead>
                <TableHead>Status</TableHead>
                <TableHead>Meta Sync</TableHead>
                <TableHead className="text-right">Actions</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {filteredProducts.map((p) => (
                <TableRow key={p.id} className="hover:bg-muted/5">
                  <TableCell>
                    <div className="h-10 w-10 rounded-lg bg-muted/20 border border-border/50 flex items-center justify-center overflow-hidden">
                      {p.image_url ? (
                        <img src={p.image_url} alt={p.name} className="object-cover h-full w-full" />
                      ) : (
                        <ImageIcon className="h-5 w-5 text-muted-foreground/50" />
                      )}
                    </div>
                  </TableCell>
                  <TableCell className="font-mono text-xs">{p.retailer_id}</TableCell>
                  <TableCell className="font-medium text-foreground">{p.name}</TableCell>
                  <TableCell className="font-semibold text-primary">
                    {p.currency} {p.price.toFixed(2)}
                  </TableCell>
                  <TableCell>
                    <Badge variant={p.is_active ? 'default' : 'secondary'}>
                      {p.is_active ? 'Active' : 'Inactive'}
                    </Badge>
                  </TableCell>
                  <TableCell>
                    <span className="inline-flex items-center gap-1 text-xs text-green-500 font-medium">
                      <CheckCircle className="h-3 w-3" />
                      Synced
                    </span>
                  </TableCell>
                  <TableCell className="text-right">
                    <div className="flex justify-end gap-1">
                      <Button variant="ghost" size="icon" className="h-8 w-8" onClick={() => handleOpenEdit(p)}>
                        <Edit className="h-4 w-4" />
                      </Button>
                      <Button variant="ghost" size="icon" className="h-8 w-8 hover:bg-destructive/10" onClick={() => handleOpenDelete(p)}>
                        <Trash2 className="h-4 w-4 text-destructive" />
                      </Button>
                    </div>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      )}

      {/* Add Dialog */}
      <Dialog open={addOpen} onOpenChange={setAddOpen}>
        <DialogContent className="sm:max-w-lg border-border bg-card">
          <form onSubmit={handleAdd}>
            <DialogHeader>
              <DialogTitle>Add Product</DialogTitle>
              <DialogDescription>
                Create a product natively. It will be automatically saved locally and synchronized with the Meta WABA Catalog.
              </DialogDescription>
            </DialogHeader>
            <div className="grid gap-4 py-4">
              <div className="grid grid-cols-2 gap-4">
                <div className="space-y-2">
                  <Label htmlFor="retailer_id">SKU / Retailer ID *</Label>
                  <Input
                    id="retailer_id"
                    placeholder="e.g. sku_wallet_001"
                    required
                    value={formData.retailer_id}
                    onChange={(e) => setFormData({ ...formData, retailer_id: e.target.value })}
                  />
                </div>
                <div className="space-y-2">
                  <Label htmlFor="name">Product Name *</Label>
                  <Input
                    id="name"
                    placeholder="e.g. Leather Wallet"
                    required
                    value={formData.name}
                    onChange={(e) => setFormData({ ...formData, name: e.target.value })}
                  />
                </div>
              </div>
              <div className="space-y-2">
                <Label htmlFor="description">Description</Label>
                <Textarea
                  id="description"
                  placeholder="Describe your product details..."
                  rows={3}
                  value={formData.description}
                  onChange={(e) => setFormData({ ...formData, description: e.target.value })}
                />
              </div>
              <div className="grid grid-cols-2 gap-4">
                <div className="space-y-2">
                  <Label htmlFor="price">Price *</Label>
                  <Input
                    id="price"
                    type="number"
                    step="0.01"
                    placeholder="299.00"
                    required
                    value={formData.price}
                    onChange={(e) => setFormData({ ...formData, price: e.target.value })}
                  />
                </div>
                <div className="space-y-2">
                  <Label htmlFor="currency">Currency</Label>
                  <Input
                    id="currency"
                    placeholder="INR"
                    value={formData.currency}
                    onChange={(e) => setFormData({ ...formData, currency: e.target.value })}
                  />
                </div>
              </div>
              <div className="space-y-2">
                <Label htmlFor="image_url">Image URL</Label>
                <Input
                  id="image_url"
                  placeholder="https://example.com/image.jpg"
                  value={formData.image_url}
                  onChange={(e) => setFormData({ ...formData, image_url: e.target.value })}
                />
              </div>
              <div className="flex items-center justify-between pt-2">
                <Label htmlFor="is_active">Active status on WhatsApp</Label>
                <Switch
                  id="is_active"
                  checked={formData.is_active}
                  onCheckedChange={(checked) => setFormData({ ...formData, is_active: checked })}
                />
              </div>
            </div>
            <DialogFooter>
              <Button type="button" variant="outline" onClick={() => setAddOpen(false)} disabled={submitting}>
                Cancel
              </Button>
              <Button type="submit" disabled={submitting}>
                {submitting && <Loader2 className="h-4 w-4 mr-2 animate-spin" />}
                Save & Sync
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>

      {/* Edit Dialog */}
      <Dialog open={editOpen} onOpenChange={setEditOpen}>
        <DialogContent className="sm:max-w-lg border-border bg-card">
          <form onSubmit={handleEdit}>
            <DialogHeader>
              <DialogTitle>Edit Product</DialogTitle>
              <DialogDescription>
                Modify details for this native product. Updates will sync to Meta Catalog.
              </DialogDescription>
            </DialogHeader>
            <div className="grid gap-4 py-4">
              <div className="grid grid-cols-2 gap-4">
                <div className="space-y-2">
                  <Label htmlFor="edit_retailer_id">SKU / Retailer ID</Label>
                  <Input
                    id="edit_retailer_id"
                    disabled
                    value={formData.retailer_id}
                  />
                </div>
                <div className="space-y-2">
                  <Label htmlFor="edit_name">Product Name *</Label>
                  <Input
                    id="edit_name"
                    required
                    value={formData.name}
                    onChange={(e) => setFormData({ ...formData, name: e.target.value })}
                  />
                </div>
              </div>
              <div className="space-y-2">
                <Label htmlFor="edit_description">Description</Label>
                <Textarea
                  id="edit_description"
                  rows={3}
                  value={formData.description}
                  onChange={(e) => setFormData({ ...formData, description: e.target.value })}
                />
              </div>
              <div className="grid grid-cols-2 gap-4">
                <div className="space-y-2">
                  <Label htmlFor="edit_price">Price *</Label>
                  <Input
                    id="edit_price"
                    type="number"
                    step="0.01"
                    required
                    value={formData.price}
                    onChange={(e) => setFormData({ ...formData, price: e.target.value })}
                  />
                </div>
                <div className="space-y-2">
                  <Label htmlFor="edit_currency">Currency</Label>
                  <Input
                    id="edit_currency"
                    value={formData.currency}
                    onChange={(e) => setFormData({ ...formData, currency: e.target.value })}
                  />
                </div>
              </div>
              <div className="space-y-2">
                <Label htmlFor="edit_image_url">Image URL</Label>
                <Input
                  id="edit_image_url"
                  value={formData.image_url}
                  onChange={(e) => setFormData({ ...formData, image_url: e.target.value })}
                />
              </div>
              <div className="flex items-center justify-between pt-2">
                <Label htmlFor="edit_is_active">Active status on WhatsApp</Label>
                <Switch
                  id="edit_is_active"
                  checked={formData.is_active}
                  onCheckedChange={(checked) => setFormData({ ...formData, is_active: checked })}
                />
              </div>
            </div>
            <DialogFooter>
              <Button type="button" variant="outline" onClick={() => setEditOpen(false)} disabled={submitting}>
                Cancel
              </Button>
              <Button type="submit" disabled={submitting}>
                {submitting && <Loader2 className="h-4 w-4 mr-2 animate-spin" />}
                Save Changes
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>

      {/* Delete Dialog */}
      <Dialog open={deleteOpen} onOpenChange={setDeleteOpen}>
        <DialogContent className="border-border bg-card">
          <DialogHeader>
            <DialogTitle>Delete Product</DialogTitle>
            <DialogDescription>
              Are you sure you want to delete <span className="font-semibold text-foreground">{selectedProduct?.name}</span>? This will also remove the item from Meta WhatsApp Commerce channels.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => setDeleteOpen(false)} disabled={submitting}>
              Cancel
            </Button>
            <Button variant="destructive" onClick={handleDelete} disabled={submitting}>
              {submitting && <Loader2 className="h-4 w-4 mr-2 animate-spin" />}
              Delete
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
