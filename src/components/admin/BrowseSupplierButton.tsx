'use client';

import { useState } from 'react';
import { Search, X } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { ShopBrowser } from '@/components/admin/ShopBrowser';

/**
 * Header action on /admin/companies. Opens a sanitised in-app browser
 * (ShopBrowser) pointed at a supplier URL so an admin can navigate the
 * supplier site and import products into DRAFTs via the proxy's "Add via AI"
 * toolbar. No catalogue write happens here — drafts are confirmed elsewhere.
 *
 * (Reconstructed 2026-06-09 after the source file was lost to filesystem
 * corruption; it was an untracked component referenced by companies/page.tsx.)
 */
export function BrowseSupplierButton() {
  const [open, setOpen] = useState(false);
  const [url, setUrl] = useState('');
  const [browsing, setBrowsing] = useState<string | null>(null);

  const valid = /^https?:\/\//i.test(url.trim());

  function close() {
    setOpen(false);
    setUrl('');
    setBrowsing(null);
  }

  return (
    <>
      <Button variant="outline" onClick={() => setOpen(true)} className="rounded-full font-semibold">
        <Search className="h-4 w-4" /> Browse supplier
      </Button>
      {open && (
        <div className="fixed inset-0 z-50 flex items-center justify-center" role="dialog" aria-modal>
          <button
            type="button"
            onClick={close}
            className="absolute inset-0 bg-black/55 backdrop-blur-sm"
            aria-label="Close"
          />
          <div className="relative w-full max-w-4xl bg-card border border-border rounded-2xl shadow-xl m-4 max-h-[94vh] flex flex-col">
            <div className="p-5 border-b border-border flex items-start justify-between gap-3">
              <div>
                <h3 className="text-lg font-bold">Browse a supplier site</h3>
                <p className="text-xs text-muted-foreground mt-0.5">
                  Open a supplier’s website inside a sanitised in-app browser and import products you find
                  into DRAFTs. Nothing is added to the catalogue until you confirm a draft.
                </p>
              </div>
              <button type="button" onClick={close} className="p-1.5 rounded-lg hover:bg-foreground/5">
                <X className="h-5 w-5" />
              </button>
            </div>
            <div className="p-5 overflow-auto flex-1">
              {!browsing ? (
                <form
                  onSubmit={(e) => {
                    e.preventDefault();
                    if (valid) setBrowsing(url.trim());
                  }}
                  className="space-y-3"
                >
                  <label className="block">
                    <span className="block text-sm font-semibold mb-1">Supplier URL</span>
                    <input
                      value={url}
                      onChange={(e) => setUrl(e.target.value)}
                      placeholder="https://supplier.example.com"
                      className="w-full h-10 px-3 rounded-lg border border-input bg-background text-sm focus:outline-none focus:ring-2 focus:ring-primary/30 focus:border-primary"
                    />
                  </label>
                  <Button type="submit" disabled={!valid} className="rounded-full font-semibold">
                    Open in browser
                  </Button>
                </form>
              ) : (
                <ShopBrowser initialUrl={browsing} companySlug="" />
              )}
            </div>
          </div>
        </div>
      )}
    </>
  );
}
