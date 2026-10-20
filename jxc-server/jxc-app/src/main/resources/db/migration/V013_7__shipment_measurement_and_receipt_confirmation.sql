-- Existing rows remain unknown. New native drafts freeze dimensions per master base unit.
ALTER TABLE lgs_shipment_line
 ADD COLUMN boxes numeric(20,4) CHECK(boxes>=0),
 ADD COLUMN unit_weight numeric(20,4) CHECK(unit_weight>=0),
 ADD COLUMN unit_volume numeric(20,4) CHECK(unit_volume>=0);
ALTER TABLE lgs_receipt
 ADD COLUMN confirmed_by jxc_safe_id REFERENCES sys_user(id),
 ADD COLUMN confirmed_at timestamptz,
 ADD CONSTRAINT lgs_receipt_confirmation_pair CHECK((confirmed_by IS NULL)=(confirmed_at IS NULL));

CREATE OR REPLACE FUNCTION lgs_shipment_line_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE p record;basis jsonb;
BEGIN
 IF TG_OP='UPDATE' AND ROW(NEW.country_id,NEW.shipment_id,NEW.source_type,NEW.source_line_id,NEW.po_id,NEW.po_line_id,NEW.product_id,NEW.base_qty,NEW.boxes,NEW.unit_weight,NEW.unit_volume) IS NOT DISTINCT FROM ROW(OLD.country_id,OLD.shipment_id,OLD.source_type,OLD.source_line_id,OLD.po_id,OLD.po_line_id,OLD.product_id,OLD.base_qty,OLD.boxes,OLD.unit_weight,OLD.unit_volume) THEN RETURN NEW;END IF;
 IF TG_OP='UPDATE' AND ROW(NEW.boxes,NEW.unit_weight,NEW.unit_volume) IS DISTINCT FROM ROW(OLD.boxes,OLD.unit_weight,OLD.unit_volume) THEN
  SELECT * INTO p FROM lgs_shipment WHERE country_id=OLD.country_id AND id=OLD.shipment_id;
  IF p.status<>'DRAFT' OR p.opening_ref IS NOT NULL THEN RAISE EXCEPTION 'BUSINESS_FACT_IMMUTABLE';END IF;
 END IF;
 IF TG_OP<>'INSERT' THEN SELECT * INTO p FROM lgs_shipment WHERE country_id=OLD.country_id AND id=OLD.shipment_id;IF p.opening_ref IS NOT NULL THEN RAISE EXCEPTION 'SYS_IMPORT_SOURCE_IMMUTABLE';END IF;END IF;
 SELECT * INTO p FROM lgs_shipment WHERE country_id=coalesce(NEW.country_id,OLD.country_id) AND id=coalesce(NEW.shipment_id,OLD.shipment_id);
 IF p.opening_ref IS NOT NULL THEN
  IF TG_OP<>'INSERT' THEN RAISE EXCEPTION 'SYS_IMPORT_SOURCE_IMMUTABLE';END IF;
  basis:=jxc_supply_opening_basis(to_jsonb(p),'SHIPMENT');
  IF NEW.boxes IS NOT NULL OR NEW.unit_weight IS NOT NULL OR NEW.unit_volume IS NOT NULL OR NOT EXISTS(SELECT 1 FROM jsonb_array_elements(basis->'lines') l WHERE l->>'sourceType'=NEW.source_type AND (l->>'sourceLineId')::bigint=NEW.source_line_id AND (l->>'baseQty')::numeric=NEW.base_qty) THEN RAISE EXCEPTION 'SYS_IMPORT_SOURCE_MISMATCH';END IF;
  PERFORM jxc_assert_country_trade(p.country_id,p.biz_date);PERFORM jxc_assert_opening_cutoff_period(p.country_id,p.book_id,p.cutoff_date);RETURN NEW;
 END IF;
 IF TG_OP<>'INSERT' THEN SELECT * INTO p FROM lgs_shipment WHERE country_id=OLD.country_id AND id=OLD.shipment_id;PERFORM jxc_assert_period_open(p.country_id,p.book_id,p.biz_date);END IF;IF TG_OP<>'DELETE' THEN SELECT * INTO p FROM lgs_shipment WHERE country_id=NEW.country_id AND id=NEW.shipment_id;PERFORM jxc_assert_period_open(p.country_id,p.book_id,p.biz_date);RETURN NEW;END IF;RETURN OLD;
END $$;

CREATE FUNCTION jxc_lgs_receipt_confirmation_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF OLD.status='CONFIRMED' AND ROW(NEW.status,NEW.confirmed_by,NEW.confirmed_at) IS DISTINCT FROM ROW(OLD.status,OLD.confirmed_by,OLD.confirmed_at) THEN RAISE EXCEPTION 'BUSINESS_FACT_IMMUTABLE';END IF;
 IF NEW.status='CONFIRMED' AND OLD.status<>'CONFIRMED' AND (OLD.status<>'DRAFT' OR NEW.confirmed_by IS NULL OR NEW.confirmed_at IS NULL) THEN RAISE EXCEPTION 'LGS_RECEIPT_CONFIRMATION_REQUIRED';END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER lgs_receipt_confirmation_history BEFORE UPDATE ON lgs_receipt FOR EACH ROW EXECUTE FUNCTION jxc_lgs_receipt_confirmation_guard();
