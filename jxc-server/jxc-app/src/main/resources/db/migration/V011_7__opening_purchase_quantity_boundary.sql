-- Opening in-transit occupies procurement quantity without inventing a domestic receipt.
ALTER TABLE pur_order_line ADD COLUMN opening_shipped_qty numeric(20,4) NOT NULL DEFAULT 0 CHECK(opening_shipped_qty>=0 AND opening_shipped_qty<=shipped_qty);
ALTER TABLE pur_order_line ADD CONSTRAINT pur_opening_quantity_boundary CHECK(cancelled_qty+qualified_qty+pending_inspect_qty+opening_shipped_qty<=base_qty);
