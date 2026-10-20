-- Native source proof for historical opening drafts and in-transit facts. No date-only trade exception.
CREATE FUNCTION jxc_supply_opening_basis(doc jsonb,target_kind text,completed_only boolean DEFAULT false)
RETURNS jsonb LANGUAGE plpgsql VOLATILE AS $$
DECLARE p record; expected_type text; setting text; in_batch boolean; field text;
BEGIN
 expected_type:=CASE target_kind WHEN 'PURCHASE_ORDER' THEN 'OPENING_PURCHASE' WHEN 'SHIPMENT' THEN 'OPENING_TRANSIT' ELSE NULL END;
 IF expected_type IS NULL OR doc->>'opening_ref' IS NULL OR doc->>'cutoff_date' IS NULL OR doc->>'import_row_id' IS NULL THEN RAISE EXCEPTION 'SYS_IMPORT_SOURCE_MISMATCH';END IF;
 SELECT r.normalized,r.target_type,r.target_id,b.id batch_id,b.status,b.import_type,b.cutoff_date,b.requested_by INTO p
 FROM sys_import_row r JOIN sys_import_batch b ON b.country_id=r.country_id AND b.id=r.batch_id
 JOIN sys_import_source s ON s.country_id=r.country_id AND s.row_id=r.id AND s.import_type=b.import_type AND s.source_key=r.source_key
 WHERE r.country_id=(doc->>'country_id')::bigint AND r.id=(doc->>'import_row_id')::bigint AND r.errors='[]'::jsonb;
 IF NOT FOUND OR p.import_type IS DISTINCT FROM expected_type OR p.cutoff_date IS DISTINCT FROM (doc->>'cutoff_date')::date
  OR (p.normalized->>'bookId')::bigint IS DISTINCT FROM (doc->>'book_id')::bigint
  OR p.normalized->>'refNo' IS DISTINCT FROM doc->>'opening_ref' OR (doc->>'biz_date')::date IS DISTINCT FROM p.cutoff_date
  OR (p.normalized->>'sourceDate')::date>p.cutoff_date OR (doc->>'created_by')::bigint IS DISTINCT FROM p.requested_by OR (doc->>'entity_id')::bigint IS DISTINCT FROM (SELECT entity_id FROM fin_book WHERE country_id=(doc->>'country_id')::bigint AND id=(doc->>'book_id')::bigint) THEN RAISE EXCEPTION 'SYS_IMPORT_SOURCE_MISMATCH';END IF;
 setting:=current_setting('app.opening_import_batch',true);
 in_batch:=coalesce(setting ~ '^[1-9][0-9]{0,15}$',false) AND setting=p.batch_id::text AND p.status='VALIDATED' AND NOT completed_only;
 IF NOT in_batch AND NOT (p.status='COMPLETED' AND p.target_type=target_kind AND p.target_id=(doc->>'id')::bigint) THEN RAISE EXCEPTION 'SYS_IMPORT_SOURCE_MISMATCH';END IF;
 IF target_kind='PURCHASE_ORDER' THEN
  IF (p.normalized->>'supplierId')::bigint IS DISTINCT FROM (doc->>'supplier_id')::bigint OR (p.normalized->>'entityId')::bigint IS DISTINCT FROM (doc->>'entity_id')::bigint OR p.normalized->>'currency' IS DISTINCT FROM doc->>'currency' OR (p.normalized->>'sourceDate')::date IS DISTINCT FROM (doc->>'order_date')::date OR (p.normalized->>'expectedDate')::date IS DISTINCT FROM (doc->>'expected_date')::date THEN RAISE EXCEPTION 'SYS_IMPORT_SOURCE_MISMATCH';END IF;
 ELSE
  IF (p.normalized->>'carrierId')::bigint IS DISTINCT FROM (doc->>'carrier_id')::bigint OR (p.normalized->>'destWarehouseId')::bigint IS DISTINCT FROM (doc->>'dest_warehouse_id')::bigint OR p.normalized->>'transportMode' IS DISTINCT FROM doc->>'transport_mode' OR (p.normalized->>'sourceDate')::date IS DISTINCT FROM (doc->>'opening_source_date')::date THEN RAISE EXCEPTION 'SYS_IMPORT_SOURCE_MISMATCH';END IF;
  FOR field IN SELECT unnest(CASE WHEN p.normalized->>'transportMode'='SEA' THEN ARRAY['vessel','voyage','blNo','containerNo','sealNo'] ELSE ARRAY['awbNo','flightNo'] END) LOOP
   IF field IN ('containerNo','sealNo') AND NOT in_batch THEN CONTINUE;END IF;
   IF p.normalized->>field IS DISTINCT FROM doc->>(CASE field WHEN 'blNo' THEN 'bl_no' WHEN 'containerNo' THEN 'current_container_no' WHEN 'sealNo' THEN 'current_seal_no' WHEN 'awbNo' THEN 'awb_no' WHEN 'flightNo' THEN 'flight_no' ELSE field END) THEN RAISE EXCEPTION 'SYS_IMPORT_SOURCE_MISMATCH';END IF;
  END LOOP;
 END IF;
 RETURN p.normalized;
END $$;
CREATE FUNCTION jxc_assert_imported_opening_source_period(selected_country bigint,selected_book bigint,cutoff date,target_kind text,target_id bigint)
RETURNS void LANGUAGE plpgsql VOLATILE AS $$
DECLARE doc jsonb;
BEGIN
 IF target_kind='PURCHASE_ORDER' THEN SELECT to_jsonb(p) INTO doc FROM pur_order p WHERE p.country_id=selected_country AND p.id=target_id;
 ELSIF target_kind='SHIPMENT' THEN SELECT to_jsonb(s) INTO doc FROM lgs_shipment s WHERE s.country_id=selected_country AND s.id=target_id;
 ELSE RAISE EXCEPTION 'SYS_IMPORT_SOURCE_MISMATCH';END IF;
 IF doc IS NULL OR (doc->>'book_id')::bigint IS DISTINCT FROM selected_book OR (doc->>'cutoff_date')::date IS DISTINCT FROM cutoff THEN RAISE EXCEPTION 'SYS_IMPORT_SOURCE_MISMATCH';END IF;
 PERFORM jxc_supply_opening_basis(doc,target_kind,true);
 PERFORM jxc_assert_country_trade(selected_country,NULL);
 PERFORM jxc_assert_opening_cutoff_period(selected_country,selected_book,cutoff);
END $$;
-- Keep the original source-counter whitelist; imported economic facts cannot be rewritten.
CREATE OR REPLACE FUNCTION jxc_supply_period_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE ignored text[];basis jsonb;head record;expected_total numeric;expected_qty numeric;expected_tax numeric;line_count integer;
BEGIN
 ignored:=CASE TG_TABLE_NAME WHEN 'pur_order' THEN ARRAY['status','version','approval_instance_id'] WHEN 'lgs_shipment' THEN ARRAY['status','version','actual_etd','actual_eta','current_container_no','current_seal_no'] WHEN 'lgs_delivery' THEN ARRAY['status','version','dispatched_at'] WHEN 'lgs_node' THEN ARRAY['version','corrected_by_id'] WHEN 'lgs_hold' THEN ARRAY['version','status'] WHEN 'lgs_discrepancy' THEN ARRAY['version','status','resolution','remark'] WHEN 'pur_domestic_receipt' THEN ARRAY['status','version'] WHEN 'pur_export_node' THEN ARRAY['status','version'] ELSE ARRAY['version'] END;
 IF TG_TABLE_NAME IN ('pur_order','lgs_shipment') AND (to_jsonb(NEW)->>'opening_ref' IS NOT NULL OR to_jsonb(OLD)->>'opening_ref' IS NOT NULL) THEN
  IF TG_OP='DELETE' THEN RAISE EXCEPTION 'SYS_IMPORT_SOURCE_IMMUTABLE';END IF;
  -- Current container identifiers are mutable logistics progress; the initial source identifiers remain in the sealed row.
  basis:=jxc_supply_opening_basis(CASE WHEN TG_OP='UPDATE' THEN to_jsonb(OLD) ELSE to_jsonb(NEW) END,CASE TG_TABLE_NAME WHEN 'pur_order' THEN 'PURCHASE_ORDER' ELSE 'SHIPMENT' END);
  IF TG_OP='UPDATE' AND (to_jsonb(NEW)-ignored)=(to_jsonb(OLD)-ignored) THEN RETURN NEW;END IF;
  IF TG_OP='UPDATE' THEN
   IF TG_TABLE_NAME<>'pur_order' OR (to_jsonb(NEW)-ARRAY['total_qty','total_amount','tax_amount']) IS DISTINCT FROM (to_jsonb(OLD)-ARRAY['total_qty','total_amount','tax_amount']) OR current_setting('app.opening_import_batch',true) IS DISTINCT FROM (SELECT batch_id::text FROM sys_import_row WHERE country_id=NEW.country_id AND id=(to_jsonb(NEW)->>'import_row_id')::bigint) THEN RAISE EXCEPTION 'SYS_IMPORT_SOURCE_IMMUTABLE';END IF;
   SELECT count(*),coalesce(sum(base_qty),0),coalesce(sum(amount),0),round(coalesce(sum(amount*tax_rate),0),4) INTO line_count,expected_qty,expected_total,expected_tax FROM pur_order_line WHERE country_id=NEW.country_id AND order_id=NEW.id;
   IF line_count<>jsonb_array_length(basis->'lines') OR (to_jsonb(NEW)->>'total_qty')::numeric<>expected_qty OR (to_jsonb(NEW)->>'total_amount')::numeric<>expected_total OR (to_jsonb(NEW)->>'tax_amount')::numeric<>expected_tax THEN RAISE EXCEPTION 'SYS_IMPORT_SOURCE_MISMATCH';END IF;
  ELSIF TG_TABLE_NAME='pur_order' AND ((to_jsonb(NEW)->>'total_qty')::numeric<>0 OR (to_jsonb(NEW)->>'total_amount')::numeric<>0 OR (to_jsonb(NEW)->>'tax_amount')::numeric<>0 OR NEW.status<>'DRAFT') THEN RAISE EXCEPTION 'SYS_IMPORT_SOURCE_MISMATCH';
  ELSIF TG_TABLE_NAME='lgs_shipment' AND NEW.status<>'DRAFT' THEN RAISE EXCEPTION 'SYS_IMPORT_SOURCE_MISMATCH';END IF;
  PERFORM jxc_assert_country_trade(NEW.country_id,NEW.biz_date);PERFORM jxc_assert_opening_cutoff_period(NEW.country_id,NEW.book_id,NEW.biz_date);RETURN NEW;
 END IF;
 IF TG_TABLE_NAME='lgs_container' AND TG_OP='INSERT' THEN
  SELECT * INTO head FROM lgs_shipment WHERE country_id=NEW.country_id AND id=NEW.shipment_id;
  IF head.opening_ref IS NOT NULL AND NEW.biz_date=head.cutoff_date THEN basis:=jxc_supply_opening_basis(to_jsonb(head),'SHIPMENT');IF NEW.container_no IS DISTINCT FROM basis->>'containerNo' OR NEW.seal_no IS DISTINCT FROM basis->>'sealNo' THEN RAISE EXCEPTION 'SYS_IMPORT_SOURCE_MISMATCH';END IF;PERFORM jxc_assert_country_trade(NEW.country_id,NEW.biz_date);PERFORM jxc_assert_opening_cutoff_period(NEW.country_id,NEW.book_id,NEW.biz_date);RETURN NEW;END IF;
 END IF;
 IF TG_OP='UPDATE' AND (to_jsonb(NEW)-ignored)=(to_jsonb(OLD)-ignored) THEN RETURN NEW;END IF;
 IF TG_OP<>'INSERT' THEN PERFORM jxc_assert_period_open(OLD.country_id,OLD.book_id,OLD.biz_date);END IF;
 IF TG_OP<>'DELETE' THEN PERFORM jxc_assert_period_open(NEW.country_id,NEW.book_id,NEW.biz_date);RETURN NEW;END IF;RETURN OLD;
END $$;
CREATE OR REPLACE FUNCTION pur_order_line_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE p record;basis jsonb;expected jsonb;
BEGIN
 IF TG_OP='UPDATE' AND ROW(NEW.country_id,NEW.order_id,NEW.line_no,NEW.product_id,NEW.unit,NEW.base_unit,NEW.factor,NEW.qty,NEW.base_qty,NEW.unit_price,NEW.amount,NEW.tax_rate,NEW.delivery_date) IS NOT DISTINCT FROM ROW(OLD.country_id,OLD.order_id,OLD.line_no,OLD.product_id,OLD.unit,OLD.base_unit,OLD.factor,OLD.qty,OLD.base_qty,OLD.unit_price,OLD.amount,OLD.tax_rate,OLD.delivery_date) THEN RETURN NEW;END IF;
 IF TG_OP<>'INSERT' THEN SELECT * INTO p FROM pur_order WHERE country_id=OLD.country_id AND id=OLD.order_id;IF p.opening_ref IS NOT NULL THEN RAISE EXCEPTION 'SYS_IMPORT_SOURCE_IMMUTABLE';END IF;END IF;
 SELECT * INTO p FROM pur_order WHERE country_id=coalesce(NEW.country_id,OLD.country_id) AND id=coalesce(NEW.order_id,OLD.order_id);
 IF p.opening_ref IS NOT NULL THEN
  IF TG_OP<>'INSERT' THEN RAISE EXCEPTION 'SYS_IMPORT_SOURCE_IMMUTABLE';END IF;
  basis:=jxc_supply_opening_basis(to_jsonb(p),'PURCHASE_ORDER');expected:=basis->'lines'->(NEW.line_no-1);
  IF expected IS NULL OR (expected->>'productId')::bigint IS DISTINCT FROM NEW.product_id OR expected->>'unit' IS DISTINCT FROM NEW.unit OR (expected->>'qty')::numeric IS DISTINCT FROM NEW.qty OR (expected->>'unitPrice')::numeric IS DISTINCT FROM NEW.unit_price OR (expected->>'taxRate')::numeric IS DISTINCT FROM NEW.tax_rate OR expected->>'baseUnit' IS DISTINCT FROM NEW.base_unit OR (expected->>'factor')::numeric IS DISTINCT FROM NEW.factor OR (expected->>'baseQty')::numeric IS DISTINCT FROM NEW.base_qty OR NEW.amount<>round(NEW.qty*NEW.unit_price,4) THEN RAISE EXCEPTION 'SYS_IMPORT_SOURCE_MISMATCH';END IF;
  PERFORM jxc_assert_country_trade(p.country_id,p.biz_date);PERFORM jxc_assert_opening_cutoff_period(p.country_id,p.book_id,p.cutoff_date);RETURN NEW;
 END IF;
 IF TG_OP<>'INSERT' THEN SELECT * INTO p FROM pur_order WHERE country_id=OLD.country_id AND id=OLD.order_id;PERFORM jxc_assert_period_open(p.country_id,p.book_id,p.biz_date);END IF;IF TG_OP<>'DELETE' THEN SELECT * INTO p FROM pur_order WHERE country_id=NEW.country_id AND id=NEW.order_id;PERFORM jxc_assert_period_open(p.country_id,p.book_id,p.biz_date);RETURN NEW;END IF;RETURN OLD;
END $$;
CREATE OR REPLACE FUNCTION lgs_shipment_line_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE p record;basis jsonb;
BEGIN
 IF TG_OP='UPDATE' AND ROW(NEW.country_id,NEW.shipment_id,NEW.source_type,NEW.source_line_id,NEW.po_id,NEW.po_line_id,NEW.product_id,NEW.base_qty)=ROW(OLD.country_id,OLD.shipment_id,OLD.source_type,OLD.source_line_id,OLD.po_id,OLD.po_line_id,OLD.product_id,OLD.base_qty) THEN RETURN NEW;END IF;
 IF TG_OP<>'INSERT' THEN SELECT * INTO p FROM lgs_shipment WHERE country_id=OLD.country_id AND id=OLD.shipment_id;IF p.opening_ref IS NOT NULL THEN RAISE EXCEPTION 'SYS_IMPORT_SOURCE_IMMUTABLE';END IF;END IF;
 SELECT * INTO p FROM lgs_shipment WHERE country_id=coalesce(NEW.country_id,OLD.country_id) AND id=coalesce(NEW.shipment_id,OLD.shipment_id);
 IF p.opening_ref IS NOT NULL THEN
  IF TG_OP<>'INSERT' THEN RAISE EXCEPTION 'SYS_IMPORT_SOURCE_IMMUTABLE';END IF;
  basis:=jxc_supply_opening_basis(to_jsonb(p),'SHIPMENT');
  IF NOT EXISTS(SELECT 1 FROM jsonb_array_elements(basis->'lines') l WHERE l->>'sourceType'=NEW.source_type AND (l->>'sourceLineId')::bigint=NEW.source_line_id AND (l->>'baseQty')::numeric=NEW.base_qty) THEN RAISE EXCEPTION 'SYS_IMPORT_SOURCE_MISMATCH';END IF;
  PERFORM jxc_assert_country_trade(p.country_id,p.biz_date);PERFORM jxc_assert_opening_cutoff_period(p.country_id,p.book_id,p.cutoff_date);RETURN NEW;
 END IF;
 IF TG_OP<>'INSERT' THEN SELECT * INTO p FROM lgs_shipment WHERE country_id=OLD.country_id AND id=OLD.shipment_id;PERFORM jxc_assert_period_open(p.country_id,p.book_id,p.biz_date);END IF;IF TG_OP<>'DELETE' THEN SELECT * INTO p FROM lgs_shipment WHERE country_id=NEW.country_id AND id=NEW.shipment_id;PERFORM jxc_assert_period_open(p.country_id,p.book_id,p.biz_date);RETURN NEW;END IF;RETURN OLD;
END $$;
REVOKE ALL ON FUNCTION jxc_supply_opening_basis(jsonb,text,boolean),jxc_assert_imported_opening_source_period(bigint,bigint,date,text,bigint) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION jxc_supply_opening_basis(jsonb,text,boolean),jxc_assert_imported_opening_source_period(bigint,bigint,date,text,bigint) TO "${runtimeRole}";
