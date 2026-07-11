"use client";

import { useState, useEffect } from "react";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { ShoppingBag, Search, Check, Tag, Info, ListPlus, Loader2 } from "lucide-react";
import { toast } from "sonner";

interface Product {
  id: string;
  retailer_id: string;
  name: string;
  description: string | null;
  price: number;
  currency: string;
  image_url: string | null;
  is_active: boolean;
}

interface ProductPickerProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onSelectProduct: (params: {
    productRetailerId: string;
    bodyText?: string;
    footerText?: string;
  }) => void;
  onSelectProductList: (params: {
    headerText: string;
    bodyText: string;
    footerText?: string;
    sections: Array<{
      title: string;
      productRetailerIds: string[];
    }>;
  }) => void;
}

export function ProductPicker({
  open,
  onOpenChange,
  onSelectProduct,
  onSelectProductList,
}: ProductPickerProps) {
  const [products, setProducts] = useState<Product[]>([]);
  const [loading, setLoading] = useState(false);
  const [search, setSearch] = useState("");
  
  // Selection state
  const [selectedProductId, setSelectedProductId] = useState<string | null>(null);
  const [selectedProductIds, setSelectedProductIds] = useState<string[]>([]);
  
  // Single Product custom texts
  const [spmBody, setSpmBody] = useState("Check out this product!");
  const [spmFooter, setSpmFooter] = useState("Tap to view details");

  // Multi Product custom texts
  const [mpmHeader, setMpmHeader] = useState("Featured Products");
  const [mpmBody, setMpmBody] = useState("Explore our curated list of items:");
  const [mpmFooter, setMpmFooter] = useState("Tap to see list");
  const [mpmSectionTitle, setMpmSectionTitle] = useState("Recommendations");

  // Fetch catalog products
  useEffect(() => {
    if (open) {
      setLoading(true);
      fetch("/api/whatsapp/products")
        .then((res) => res.json())
        .then((data) => {
          setProducts(data.products || []);
        })
        .catch(() => {
          toast.error("Failed to load catalogue products");
        })
        .finally(() => {
          setLoading(false);
        });
    }
  }, [open]);

  const filteredProducts = products.filter((p) =>
    p.name.toLowerCase().includes(search.toLowerCase()) ||
    p.retailer_id.toLowerCase().includes(search.toLowerCase())
  );

  const toggleMultiSelect = (id: string) => {
    setSelectedProductIds((prev) => {
      if (prev.includes(id)) {
        return prev.filter((item) => item !== id);
      } else {
        // Meta has a maximum limit of 30 products, and recommended limits
        if (prev.length >= 30) {
          toast.warning("You can select up to 30 products for a multi-product message.");
          return prev;
        }
        return [...prev, id];
      }
    });
  };

  const handleSendSingle = () => {
    const p = products.find((prod) => prod.id === selectedProductId);
    if (!p) {
      toast.error("Please select a product");
      return;
    }
    onSelectProduct({
      productRetailerId: p.retailer_id,
      bodyText: spmBody || undefined,
      footerText: spmFooter || undefined,
    });
    // Reset state
    setSelectedProductId(null);
    onOpenChange(false);
  };

  const handleSendList = () => {
    if (selectedProductIds.length === 0) {
      toast.error("Please select at least one product");
      return;
    }
    if (!mpmHeader.trim()) {
      toast.error("Header text is required for multi-product message");
      return;
    }
    if (!mpmBody.trim()) {
      toast.error("Body text is required for multi-product message");
      return;
    }

    const selectedSkus = products
      .filter((p) => selectedProductIds.includes(p.id))
      .map((p) => p.retailer_id);

    onSelectProductList({
      headerText: mpmHeader.trim(),
      bodyText: mpmBody.trim(),
      footerText: mpmFooter.trim() || undefined,
      sections: [
        {
          title: mpmSectionTitle.trim() || "Products",
          productRetailerIds: selectedSkus,
        },
      ],
    });
    
    // Reset state
    setSelectedProductIds([]);
    onOpenChange(false);
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-2xl bg-card border-border text-foreground overflow-hidden flex flex-col max-h-[85vh]">
        <DialogHeader className="px-1">
          <DialogTitle className="flex items-center gap-2 text-xl font-bold">
            <ShoppingBag className="h-5 w-5 text-primary" />
            WhatsApp Product Picker
          </DialogTitle>
          <DialogDescription className="text-muted-foreground text-xs">
            Send products directly from your native CRM catalogue to the customer's chat.
          </DialogDescription>
        </DialogHeader>

        <Tabs defaultValue="single" className="flex-1 flex flex-col overflow-hidden min-h-[300px]">
          <TabsList className="bg-muted border border-border/40 p-1 w-fit mb-3">
            <TabsTrigger value="single" className="text-xs font-semibold">Single Product (SPM)</TabsTrigger>
            <TabsTrigger value="multi" className="text-xs font-semibold">Multi-Product List (MPM)</TabsTrigger>
          </TabsList>

          <div className="relative mb-3">
            <Search className="absolute left-3 top-2.5 h-4 w-4 text-muted-foreground" />
            <Input
              placeholder="Search products by name or SKU/Retailer ID..."
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              className="pl-9 bg-muted/30 border-border text-sm h-9"
            />
          </div>

          <div className="flex-1 overflow-hidden grid grid-cols-1 md:grid-cols-5 gap-4 min-h-0">
            {/* Products List (Left 3 columns) */}
            <div className="md:col-span-3 border border-border rounded-xl p-2 bg-muted/10 overflow-y-auto flex flex-col gap-1">
              {loading ? (
                <div className="flex flex-col items-center justify-center py-16 gap-2">
                  <Loader2 className="h-6 w-6 animate-spin text-primary" />
                  <span className="text-xs text-muted-foreground">Loading products...</span>
                </div>
              ) : filteredProducts.length === 0 ? (
                <div className="flex flex-col items-center justify-center py-16 text-muted-foreground text-xs gap-1">
                  <Info className="h-4 w-4" />
                  <span>No products found in catalogue.</span>
                </div>
              ) : (
                <TabsContent value="single" className="m-0 space-y-1.5 focus-visible:outline-none">
                  {filteredProducts.map((p) => {
                    const isSelected = selectedProductId === p.id;
                    return (
                      <div
                        key={p.id}
                        onClick={() => setSelectedProductId(p.id)}
                        className={`flex items-center justify-between p-2.5 rounded-lg border cursor-pointer transition-all ${
                          isSelected
                            ? "bg-primary/10 border-primary shadow-sm"
                            : "bg-card/40 border-border hover:bg-muted/40"
                        }`}
                      >
                        <div className="flex items-center gap-2.5 min-w-0">
                          {p.image_url ? (
                            <img
                              src={p.image_url}
                              alt={p.name}
                              className="w-10 h-10 object-cover rounded-md border border-border/30 bg-muted/40 shrink-0"
                            />
                          ) : (
                            <div className="w-10 h-10 flex items-center justify-center rounded-md bg-muted border border-border/30 shrink-0">
                              <ShoppingBag className="h-4 w-4 text-muted-foreground/60" />
                            </div>
                          )}
                          <div className="min-w-0">
                            <h4 className="font-semibold text-xs truncate leading-tight text-foreground">{p.name}</h4>
                            <span className="text-[10px] text-muted-foreground font-mono">SKU: {p.retailer_id}</span>
                          </div>
                        </div>
                        <div className="text-right shrink-0">
                          <span className="text-xs font-bold text-primary font-mono">{p.currency} {p.price}</span>
                        </div>
                      </div>
                    );
                  })}
                </TabsContent>
              )}

              <TabsContent value="multi" className="m-0 space-y-1.5 focus-visible:outline-none">
                {filteredProducts.map((p) => {
                  const isSelected = selectedProductIds.includes(p.id);
                  return (
                    <div
                      key={p.id}
                      onClick={() => toggleMultiSelect(p.id)}
                      className={`flex items-center justify-between p-2.5 rounded-lg border cursor-pointer transition-all ${
                        isSelected
                          ? "bg-primary/10 border-primary shadow-sm"
                          : "bg-card/40 border-border hover:bg-muted/40"
                      }`}
                    >
                      <div className="flex items-center gap-2.5 min-w-0">
                        <div className={`w-4 h-4 rounded border flex items-center justify-center shrink-0 ${
                          isSelected ? "bg-primary border-primary text-primary-foreground" : "border-border bg-muted/30"
                        }`}>
                          {isSelected && <Check className="h-3 w-3 stroke-[3]" />}
                        </div>
                        {p.image_url ? (
                          <img
                            src={p.image_url}
                            alt={p.name}
                            className="w-10 h-10 object-cover rounded-md border border-border/30 bg-muted/40 shrink-0"
                          />
                        ) : (
                          <div className="w-10 h-10 flex items-center justify-center rounded-md bg-muted border border-border/30 shrink-0">
                            <ShoppingBag className="h-4 w-4 text-muted-foreground/60" />
                          </div>
                        )}
                        <div className="min-w-0">
                          <h4 className="font-semibold text-xs truncate leading-tight text-foreground">{p.name}</h4>
                          <span className="text-[10px] text-muted-foreground font-mono">SKU: {p.retailer_id}</span>
                        </div>
                      </div>
                      <div className="text-right shrink-0">
                        <span className="text-xs font-bold text-primary font-mono">{p.currency} {p.price}</span>
                      </div>
                    </div>
                  );
                })}
              </TabsContent>
            </div>

            {/* Custom Text Configuration (Right 2 columns) */}
            <div className="md:col-span-2 border border-border rounded-xl p-3 bg-muted/15 flex flex-col justify-between overflow-y-auto">
              <TabsContent value="single" className="m-0 space-y-3 focus-visible:outline-none flex-1 flex flex-col">
                <span className="text-[10px] font-bold text-muted-foreground uppercase tracking-wide">Configure Message</span>
                <div className="space-y-2">
                  <label className="text-[11px] font-semibold text-foreground">Body text (optional)</label>
                  <Input
                    placeholder="Check out this product!"
                    value={spmBody}
                    onChange={(e) => setSpmBody(e.target.value)}
                    className="bg-card border-border text-xs h-8"
                  />
                </div>
                <div className="space-y-2">
                  <label className="text-[11px] font-semibold text-foreground">Footer text (optional)</label>
                  <Input
                    placeholder="Tap to view details"
                    value={spmFooter}
                    onChange={(e) => setSpmFooter(e.target.value)}
                    className="bg-card border-border text-xs h-8"
                  />
                </div>
                <div className="flex-1" />
                <Button
                  onClick={handleSendSingle}
                  disabled={!selectedProductId}
                  className="w-full text-xs font-bold h-9 mt-4"
                >
                  <ShoppingBag className="h-3.5 w-3.5 mr-1.5" />
                  Send Single Product
                </Button>
              </TabsContent>

              <TabsContent value="multi" className="m-0 space-y-3 focus-visible:outline-none flex-1 flex flex-col">
                <span className="text-[10px] font-bold text-muted-foreground uppercase tracking-wide">Configure Collection</span>
                <div className="space-y-1.5">
                  <label className="text-[11px] font-semibold text-foreground">Header Text (required)</label>
                  <Input
                    placeholder="Featured Products"
                    value={mpmHeader}
                    onChange={(e) => setMpmHeader(e.target.value)}
                    className="bg-card border-border text-xs h-8"
                  />
                </div>
                <div className="space-y-1.5">
                  <label className="text-[11px] font-semibold text-foreground">Body Text (required)</label>
                  <Input
                    placeholder="Explore our items"
                    value={mpmBody}
                    onChange={(e) => setMpmBody(e.target.value)}
                    className="bg-card border-border text-xs h-8"
                  />
                </div>
                <div className="space-y-1.5">
                  <label className="text-[11px] font-semibold text-foreground">Section Title</label>
                  <Input
                    placeholder="Recommendations"
                    value={mpmSectionTitle}
                    onChange={(e) => setMpmSectionTitle(e.target.value)}
                    className="bg-card border-border text-xs h-8"
                  />
                </div>
                <div className="space-y-1.5">
                  <label className="text-[11px] font-semibold text-foreground">Footer Text (optional)</label>
                  <Input
                    placeholder="Tap to see list"
                    value={mpmFooter}
                    onChange={(e) => setMpmFooter(e.target.value)}
                    className="bg-card border-border text-xs h-8"
                  />
                </div>
                <div className="flex-1" />
                <Button
                  onClick={handleSendList}
                  disabled={selectedProductIds.length === 0}
                  className="w-full text-xs font-bold h-9 mt-4"
                >
                  <ListPlus className="h-3.5 w-3.5 mr-1.5" />
                  Send Collection ({selectedProductIds.length})
                </Button>
              </TabsContent>
            </div>
          </div>
        </Tabs>
      </DialogContent>
    </Dialog>
  );
}
