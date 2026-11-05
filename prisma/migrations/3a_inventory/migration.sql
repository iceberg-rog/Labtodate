-- Inventory: private supplier list, per-product stock record (SKU, part number,
-- supplier, purchase cost, location, notes, low-stock threshold) and a change
-- history. Adds tables only: no existing table or row is changed, and rows in
-- ProductInventory are created on the first edit of an item.

-- CreateTable
CREATE TABLE "Supplier" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "contactName" TEXT,
    "email" TEXT,
    "phone" TEXT,
    "website" TEXT,
    "notes" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Supplier_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ProductInventory" (
    "productId" TEXT NOT NULL,
    "sku" TEXT,
    "mpn" TEXT,
    "supplierId" TEXT,
    "costCents" INTEGER,
    "quotePriceCents" INTEGER,
    "location" TEXT,
    "notes" TEXT,
    "lowStockAt" INTEGER,
    "lowStockAlertedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ProductInventory_pkey" PRIMARY KEY ("productId")
);

-- CreateTable
CREATE TABLE "InventoryEvent" (
    "id" TEXT NOT NULL,
    "productId" TEXT,
    "label" TEXT,
    "field" TEXT NOT NULL,
    "oldValue" TEXT,
    "newValue" TEXT,
    "source" TEXT NOT NULL,
    "batchId" TEXT,
    "actorEmail" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "InventoryEvent_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "Supplier_name_key" ON "Supplier"("name");

-- CreateIndex
CREATE UNIQUE INDEX "ProductInventory_sku_key" ON "ProductInventory"("sku");

-- CreateIndex
CREATE INDEX "ProductInventory_supplierId_idx" ON "ProductInventory"("supplierId");

-- CreateIndex
CREATE INDEX "ProductInventory_mpn_idx" ON "ProductInventory"("mpn");

-- CreateIndex
CREATE INDEX "InventoryEvent_productId_createdAt_idx" ON "InventoryEvent"("productId", "createdAt");

-- CreateIndex
CREATE INDEX "InventoryEvent_batchId_idx" ON "InventoryEvent"("batchId");

-- CreateIndex
CREATE INDEX "InventoryEvent_createdAt_idx" ON "InventoryEvent"("createdAt");

-- AddForeignKey
ALTER TABLE "ProductInventory" ADD CONSTRAINT "ProductInventory_productId_fkey" FOREIGN KEY ("productId") REFERENCES "Product"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ProductInventory" ADD CONSTRAINT "ProductInventory_supplierId_fkey" FOREIGN KEY ("supplierId") REFERENCES "Supplier"("id") ON DELETE SET NULL ON UPDATE CASCADE;

