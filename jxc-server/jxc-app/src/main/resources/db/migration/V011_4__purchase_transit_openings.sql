ALTER TABLE pur_order ADD COLUMN opening_ref varchar(100),ADD COLUMN cutoff_date date,ADD COLUMN import_row_id jxc_safe_id;
ALTER TABLE pur_order ADD CONSTRAINT pur_opening_origin CHECK(num_nonnulls(opening_ref,cutoff_date,import_row_id) IN (0,3));
ALTER TABLE pur_order ADD FOREIGN KEY(country_id,import_row_id) REFERENCES sys_import_row(country_id,id);
CREATE UNIQUE INDEX pur_opening_ref ON pur_order(country_id,opening_ref) WHERE opening_ref IS NOT NULL;
ALTER TABLE lgs_shipment ADD COLUMN opening_ref varchar(100),ADD COLUMN cutoff_date date,ADD COLUMN opening_source_date date,ADD COLUMN import_row_id jxc_safe_id;
ALTER TABLE lgs_shipment ADD CONSTRAINT lgs_opening_origin CHECK(num_nonnulls(opening_ref,cutoff_date,opening_source_date,import_row_id) IN (0,4) AND (opening_source_date IS NULL OR opening_source_date<=cutoff_date));
ALTER TABLE lgs_shipment ADD FOREIGN KEY(country_id,import_row_id) REFERENCES sys_import_row(country_id,id);
CREATE UNIQUE INDEX lgs_opening_ref ON lgs_shipment(country_id,opening_ref) WHERE opening_ref IS NOT NULL;
ALTER TABLE lgs_shipment_line DROP CONSTRAINT lgs_shipment_line_source_type_check;
ALTER TABLE lgs_shipment_line ADD CONSTRAINT lgs_shipment_line_source_type_check CHECK(source_type IN ('EXPORT_NODE_LINE','DOMESTIC_RECEIPT_LINE','OPENING_PURCHASE_LINE'));

CREATE OR REPLACE FUNCTION jxc_supply_source_identity() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE p record; source record; po record;
BEGIN
 IF TG_TABLE_NAME='pur_domestic_receipt_line' THEN
  SELECT r.order_id,l.order_id actual_order,l.product_id INTO p FROM pur_domestic_receipt r JOIN pur_order_line l ON l.country_id=r.country_id WHERE r.country_id=NEW.country_id AND r.id=NEW.receipt_id AND l.id=NEW.order_line_id;
  IF NOT FOUND OR p.order_id<>p.actual_order OR p.product_id<>NEW.product_id THEN RAISE EXCEPTION 'PUR_RECEIPT_SOURCE_MISMATCH'; END IF;
 ELSIF TG_TABLE_NAME='pur_export_node_line' THEN
  SELECT r.order_line_id,r.product_id,d.book_id,d.entity_id INTO source FROM pur_domestic_receipt_line r JOIN pur_domestic_receipt d ON d.country_id=r.country_id AND d.id=r.receipt_id WHERE r.country_id=NEW.country_id AND r.id=NEW.receipt_line_id;
  SELECT book_id,entity_id INTO p FROM pur_export_node WHERE country_id=NEW.country_id AND id=NEW.export_node_id;
  IF source IS NULL OR source.order_line_id<>NEW.order_line_id OR source.product_id<>NEW.product_id OR source.book_id<>p.book_id OR source.entity_id<>p.entity_id THEN RAISE EXCEPTION 'PUR_EXPORT_SOURCE_MISMATCH'; END IF;
 ELSIF TG_TABLE_NAME='lgs_shipment_line' THEN
  IF NEW.source_type='EXPORT_NODE_LINE' THEN SELECT l.order_line_id,l.product_id,d.book_id,d.entity_id INTO source FROM pur_export_node_line l JOIN pur_export_node d ON d.country_id=l.country_id AND d.id=l.export_node_id WHERE l.country_id=NEW.country_id AND l.id=NEW.source_line_id;
  ELSIF NEW.source_type='OPENING_PURCHASE_LINE' THEN SELECT l.id AS order_line_id,l.product_id,d.book_id,d.entity_id INTO source FROM pur_order_line l JOIN pur_order d ON d.country_id=l.country_id AND d.id=l.order_id WHERE l.country_id=NEW.country_id AND l.id=NEW.source_line_id AND d.opening_ref IS NOT NULL AND d.id=NEW.po_id;
  ELSE SELECT l.order_line_id,l.product_id,d.book_id,d.entity_id INTO source FROM pur_domestic_receipt_line l JOIN pur_domestic_receipt d ON d.country_id=l.country_id AND d.id=l.receipt_id WHERE l.country_id=NEW.country_id AND l.id=NEW.source_line_id; END IF;
  SELECT book_id,entity_id INTO p FROM lgs_shipment WHERE country_id=NEW.country_id AND id=NEW.shipment_id;
  IF source IS NULL OR source.order_line_id<>NEW.po_line_id OR source.product_id<>NEW.product_id OR source.book_id<>p.book_id OR source.entity_id<>p.entity_id THEN RAISE EXCEPTION 'LGS_SHIPMENT_SOURCE_MISMATCH'; END IF;
 ELSIF TG_TABLE_NAME='lgs_delivery_line' THEN
  SELECT s.shipment_id,s.product_id,s.po_line_id INTO source FROM lgs_shipment_line s WHERE s.country_id=NEW.country_id AND s.id=NEW.shipment_line_id;
  SELECT shipment_id INTO p FROM lgs_delivery WHERE country_id=NEW.country_id AND id=NEW.delivery_id;
  IF source IS NULL OR source.shipment_id<>p.shipment_id OR source.product_id<>NEW.product_id OR source.po_line_id<>NEW.po_line_id THEN RAISE EXCEPTION 'LGS_DELIVERY_SOURCE_MISMATCH'; END IF;
 ELSIF TG_TABLE_NAME='lgs_receipt_line' THEN
  SELECT l.delivery_id,l.shipment_line_id,l.product_id,l.dispatch_qty INTO source FROM lgs_delivery_line l WHERE l.country_id=NEW.country_id AND l.id=NEW.delivery_line_id;
  SELECT delivery_id,status INTO p FROM lgs_receipt WHERE country_id=NEW.country_id AND id=NEW.receipt_id;
  IF source IS NULL OR source.delivery_id<>p.delivery_id OR source.shipment_line_id<>NEW.shipment_line_id OR source.product_id<>NEW.product_id OR source.dispatch_qty<>NEW.dispatch_qty THEN RAISE EXCEPTION 'LGS_RECEIPT_SOURCE_MISMATCH'; END IF;
  IF p.status='CONFIRMED' AND NEW.good_qty+NEW.damaged_qty+NEW.pending_inspect_qty+NEW.short_qty<>NEW.dispatch_qty THEN RAISE EXCEPTION 'LGS_RECEIPT_QTY_MISMATCH'; END IF;
 END IF;
 RETURN NEW;
END $$;
ALTER TABLE inv_batch ADD COLUMN opening_batch_no varchar(100),ADD COLUMN opening_warehouse_id jxc_safe_id,ADD COLUMN cutoff_date date;
ALTER TABLE inv_batch ADD FOREIGN KEY(country_id,opening_warehouse_id) REFERENCES org_warehouse(country_id,id);
ALTER TABLE inv_batch ADD CONSTRAINT inv_opening_origin CHECK(num_nonnulls(opening_batch_no,opening_warehouse_id,cutoff_date) IN (0,3));
CREATE UNIQUE INDEX inv_opening_source_key ON inv_batch(country_id,cutoff_date,opening_warehouse_id,product_id,opening_batch_no) WHERE source_type='OPENING_STOCK';
