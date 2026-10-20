-- Preserve the reviewed opening source while allowing a later known native container closure.
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
 -- The initial opening container has a technical active_from default, not a known entry instant.
 -- Closing it is a later native logistics fact; its actual country day must be an ordinary open period.
 IF TG_TABLE_NAME='lgs_container' AND TG_OP='UPDATE' THEN
  IF NEW.active_to IS DISTINCT FROM OLD.active_to THEN
  SELECT * INTO head FROM lgs_shipment WHERE country_id=OLD.country_id AND id=OLD.shipment_id;
  IF head.opening_ref IS NOT NULL AND OLD.biz_date=head.cutoff_date THEN
   basis:=jxc_supply_opening_basis(to_jsonb(head),'SHIPMENT',true);
   IF OLD.book_id IS DISTINCT FROM head.book_id
    OR OLD.container_no IS DISTINCT FROM basis->>'containerNo' OR OLD.seal_no IS DISTINCT FROM basis->>'sealNo'
    OR OLD.active_to IS NOT NULL OR NEW.active_to IS NULL OR NEW.version<>OLD.version+1
    OR (to_jsonb(NEW)-ARRAY['active_to','version']) IS DISTINCT FROM (to_jsonb(OLD)-ARRAY['active_to','version']) THEN
    RAISE EXCEPTION 'SYS_IMPORT_SOURCE_IMMUTABLE';
   END IF;
   IF (NEW.active_to AT TIME ZONE (SELECT timezone FROM sys_country WHERE id=OLD.country_id))::date < head.cutoff_date THEN
    RAISE EXCEPTION 'SYS_IMPORT_SOURCE_MISMATCH';
   END IF;
   PERFORM jxc_assert_period_open(OLD.country_id,OLD.book_id,(NEW.active_to AT TIME ZONE (SELECT timezone FROM sys_country WHERE id=OLD.country_id))::date);
   RETURN NEW;
  END IF;
  END IF;
 END IF;
 IF TG_TABLE_NAME='lgs_container' AND TG_OP='INSERT' THEN
  SELECT * INTO head FROM lgs_shipment WHERE country_id=NEW.country_id AND id=NEW.shipment_id;
  IF head.opening_ref IS NOT NULL AND NEW.biz_date=head.cutoff_date THEN basis:=jxc_supply_opening_basis(to_jsonb(head),'SHIPMENT');IF NEW.container_no IS DISTINCT FROM basis->>'containerNo' OR NEW.seal_no IS DISTINCT FROM basis->>'sealNo' THEN RAISE EXCEPTION 'SYS_IMPORT_SOURCE_MISMATCH';END IF;PERFORM jxc_assert_country_trade(NEW.country_id,NEW.biz_date);PERFORM jxc_assert_opening_cutoff_period(NEW.country_id,NEW.book_id,NEW.biz_date);RETURN NEW;END IF;
 END IF;
 IF TG_OP='UPDATE' AND (to_jsonb(NEW)-ignored)=(to_jsonb(OLD)-ignored) THEN RETURN NEW;END IF;
 IF TG_OP<>'INSERT' THEN PERFORM jxc_assert_period_open(OLD.country_id,OLD.book_id,OLD.biz_date);END IF;
 IF TG_OP<>'DELETE' THEN PERFORM jxc_assert_period_open(NEW.country_id,NEW.book_id,NEW.biz_date);RETURN NEW;END IF;RETURN OLD;
END $$;
