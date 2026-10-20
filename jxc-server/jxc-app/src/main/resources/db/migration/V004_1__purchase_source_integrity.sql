-- AP provenance retains the original purchase identity after bill void. Generated
-- typed references prevent polymorphic source IDs from outliving their facts.
ALTER TABLE ap_bill_line
 ADD purchase_order_source_id bigint GENERATED ALWAYS AS (CASE WHEN source_type='PUR_ORDER_LINE' THEN source_id END) STORED,
 ADD purchase_receipt_source_id bigint GENERATED ALWAYS AS (CASE WHEN source_type='PUR_RECEIPT_LINE' THEN source_id END) STORED,
 ADD canonical_purchase_source_id bigint GENERATED ALWAYS AS (CASE WHEN canonical_source_type='PUR_ORDER_LINE_BASE' THEN canonical_source_id END) STORED,
 ADD CONSTRAINT ap_bill_purchase_order_source_fk FOREIGN KEY(country_id,purchase_order_source_id) REFERENCES pur_order_line(country_id,id),
 ADD CONSTRAINT ap_bill_purchase_receipt_source_fk FOREIGN KEY(country_id,purchase_receipt_source_id) REFERENCES pur_domestic_receipt_line(country_id,id),
 ADD CONSTRAINT ap_bill_canonical_purchase_source_fk FOREIGN KEY(country_id,canonical_purchase_source_id) REFERENCES pur_order_line(country_id,id);
ALTER TABLE ap_source_claim
 ADD purchase_order_source_id bigint GENERATED ALWAYS AS (CASE WHEN source_type IN ('PUR_ORDER_LINE','PUR_ORDER_LINE_BASE') THEN source_id END) STORED,
 ADD purchase_receipt_source_id bigint GENERATED ALWAYS AS (CASE WHEN source_type='PUR_RECEIPT_LINE' THEN source_id END) STORED,
 ADD CONSTRAINT ap_claim_purchase_order_source_fk FOREIGN KEY(country_id,purchase_order_source_id) REFERENCES pur_order_line(country_id,id),
 ADD CONSTRAINT ap_claim_purchase_receipt_source_fk FOREIGN KEY(country_id,purchase_receipt_source_id) REFERENCES pur_domestic_receipt_line(country_id,id);
CREATE INDEX ap_bill_purchase_history ON ap_bill_line(country_id,canonical_purchase_source_id);
CREATE INDEX ap_claim_purchase_history ON ap_source_claim(country_id,purchase_order_source_id);
CREATE INDEX ap_claim_receipt_usage ON ap_source_claim(country_id,purchase_receipt_source_id) WHERE effective;

-- These AP-owned predicates are shared by SourceUsageApi and the SQL guards.
CREATE FUNCTION jxc_ap_purchase_order_has_history(c bigint,s bigint) RETURNS boolean LANGUAGE sql AS $$
 SELECT EXISTS(SELECT 1 FROM ap_source_claim WHERE country_id=c AND purchase_order_source_id=s)
     OR EXISTS(SELECT 1 FROM ap_bill_line WHERE country_id=c AND (purchase_order_source_id=s OR canonical_purchase_source_id=s))
$$;
CREATE FUNCTION jxc_ap_receipt_has_effective_claims(c bigint,s bigint) RETURNS boolean LANGUAGE sql AS $$
 SELECT EXISTS(SELECT 1 FROM ap_source_claim WHERE country_id=c AND purchase_receipt_source_id=s AND effective)
$$;
CREATE FUNCTION jxc_ap_receipt_has_history(c bigint,s bigint) RETURNS boolean LANGUAGE sql AS $$
 SELECT EXISTS(SELECT 1 FROM ap_source_claim WHERE country_id=c AND purchase_receipt_source_id=s)
     OR EXISTS(SELECT 1 FROM ap_bill_line WHERE country_id=c AND purchase_receipt_source_id=s)
$$;

CREATE FUNCTION jxc_purchase_order_source_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE claimed_q numeric; claimed_a numeric;
BEGIN
 IF TG_OP='DELETE' OR (to_jsonb(NEW)-ARRAY['cancelled_qty','qualified_qty','pending_inspect_qty','damaged_qty','exported_qty','shipped_qty','arrived_mx_qty','returned_qty','domestic_returned_qty','overseas_returned_qty','version']) IS DISTINCT FROM (to_jsonb(OLD)-ARRAY['cancelled_qty','qualified_qty','pending_inspect_qty','damaged_qty','exported_qty','shipped_qty','arrived_mx_qty','returned_qty','domestic_returned_qty','overseas_returned_qty','version']) THEN
  IF jxc_ap_purchase_order_has_history(OLD.country_id,OLD.id) THEN RAISE EXCEPTION 'PUR_SOURCE_IN_USE: original purchase economics have AP history' USING ERRCODE='23514'; END IF;
 END IF;
 IF TG_OP='UPDATE' AND NEW.cancelled_qty IS DISTINCT FROM OLD.cancelled_qty THEN
  SELECT coalesce(sum(qty),0),coalesce(sum(amount),0) INTO claimed_q,claimed_a FROM ap_source_claim WHERE country_id=OLD.country_id AND source_type='PUR_ORDER_LINE_BASE' AND source_id=OLD.id AND effective;
  IF claimed_q>NEW.base_qty-NEW.cancelled_qty OR claimed_a>round((NEW.base_qty-NEW.cancelled_qty)*NEW.unit_price/NEW.factor,4) THEN
   RAISE EXCEPTION 'PUR_SOURCE_IN_USE: cancellation would remove an effective payable quantity or amount' USING ERRCODE='23514';
  END IF;
 END IF;
 IF TG_OP='DELETE' THEN RETURN OLD; END IF;RETURN NEW;
END $$;
CREATE TRIGGER pur_order_ap_source BEFORE UPDATE OR DELETE ON pur_order_line FOR EACH ROW EXECUTE FUNCTION jxc_purchase_order_source_guard();

CREATE FUNCTION jxc_purchase_order_header_source_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE source record;
BEGIN
 IF TG_OP='UPDATE' AND ROW(NEW.id,NEW.country_id,NEW.book_id,NEW.entity_id,NEW.supplier_id,NEW.currency,NEW.doc_no,NEW.source_country,NEW.order_date,NEW.biz_date,NEW.expected_date,NEW.payment_terms,NEW.prepay_ratio,NEW.term_days,NEW.total_qty,NEW.total_amount,NEW.tax_amount) IS NOT DISTINCT FROM ROW(OLD.id,OLD.country_id,OLD.book_id,OLD.entity_id,OLD.supplier_id,OLD.currency,OLD.doc_no,OLD.source_country,OLD.order_date,OLD.biz_date,OLD.expected_date,OLD.payment_terms,OLD.prepay_ratio,OLD.term_days,OLD.total_qty,OLD.total_amount,OLD.tax_amount) AND (NEW.status=OLD.status OR NEW.status IN ('CONFIRMED','PARTIAL_DELIVERED','DELIVERED','CLOSED')) THEN RETURN NEW;END IF;
 -- Header edits race AP through exactly the source rows locked by SupplyApi.
 FOR source IN SELECT id FROM pur_order_line WHERE country_id=OLD.country_id AND order_id=OLD.id ORDER BY id FOR UPDATE LOOP
  IF jxc_ap_purchase_order_has_history(OLD.country_id,source.id) THEN RAISE EXCEPTION 'PUR_SOURCE_IN_USE: original purchase document has AP history' USING ERRCODE='23514';END IF;
 END LOOP;
 IF TG_OP='DELETE' THEN RETURN OLD;END IF;RETURN NEW;
END $$;
CREATE TRIGGER pur_order_ap_header_source BEFORE UPDATE OR DELETE ON pur_order FOR EACH ROW EXECUTE FUNCTION jxc_purchase_order_header_source_guard();

CREATE FUNCTION jxc_purchase_receipt_source_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF TG_OP='DELETE' OR ROW(NEW.id,NEW.country_id,NEW.receipt_id,NEW.order_line_id,NEW.product_id,NEW.qualified_qty,NEW.pending_inspect_qty,NEW.damaged_qty) IS DISTINCT FROM ROW(OLD.id,OLD.country_id,OLD.receipt_id,OLD.order_line_id,OLD.product_id,OLD.qualified_qty,OLD.pending_inspect_qty,OLD.damaged_qty) THEN
  IF jxc_ap_receipt_has_history(OLD.country_id,OLD.id) THEN RAISE EXCEPTION 'PUR_SOURCE_IN_USE: original receipt economics have AP history' USING ERRCODE='23514';END IF;
 END IF;
 IF TG_OP='DELETE' THEN RETURN OLD;END IF;RETURN NEW;
END $$;
CREATE TRIGGER pur_receipt_ap_source BEFORE UPDATE OR DELETE ON pur_domestic_receipt_line FOR EACH ROW EXECUTE FUNCTION jxc_purchase_receipt_source_guard();

CREATE FUNCTION jxc_purchase_receipt_header_source_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE source record; economic_change boolean;
BEGIN
 economic_change:=TG_OP='DELETE' OR ROW(NEW.id,NEW.country_id,NEW.book_id,NEW.entity_id,NEW.order_id,NEW.supplier_id,NEW.doc_no,NEW.biz_date,NEW.receipt_date) IS DISTINCT FROM ROW(OLD.id,OLD.country_id,OLD.book_id,OLD.entity_id,OLD.order_id,OLD.supplier_id,OLD.doc_no,OLD.biz_date,OLD.receipt_date);
 IF NOT economic_change AND NEW.status IS NOT DISTINCT FROM OLD.status THEN RETURN NEW;END IF;
 FOR source IN SELECT id FROM pur_domestic_receipt_line WHERE country_id=OLD.country_id AND receipt_id=OLD.id ORDER BY id FOR UPDATE LOOP
  IF (economic_change AND jxc_ap_receipt_has_history(OLD.country_id,source.id)) OR (NEW.status<>'CONFIRMED' AND jxc_ap_receipt_has_effective_claims(OLD.country_id,source.id)) THEN
   RAISE EXCEPTION 'PUR_SOURCE_IN_USE: receipt is retained by payable history or effective claims' USING ERRCODE='23514';
  END IF;
 END LOOP;
 IF TG_OP='DELETE' THEN RETURN OLD;END IF;RETURN NEW;
END $$;
CREATE TRIGGER pur_receipt_ap_header_source BEFORE UPDATE OR DELETE ON pur_domestic_receipt FOR EACH ROW EXECUTE FUNCTION jxc_purchase_receipt_header_source_guard();

-- Raw SQL must use the same source lock and confirmed status as the Supply API.
CREATE FUNCTION jxc_ap_purchase_claim_source_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE receipt_status text; order_status text; purchase_id bigint; purchase_line_id bigint;
BEGIN
 IF TG_OP='UPDATE' AND NOT NEW.effective THEN RETURN NEW;END IF;
 IF NEW.source_type IN ('PUR_ORDER_LINE','PUR_ORDER_LINE_BASE') THEN
  SELECT l.order_id INTO purchase_id FROM pur_order_line l WHERE l.country_id=NEW.country_id AND l.id=NEW.source_id FOR UPDATE;
  IF FOUND THEN SELECT status INTO order_status FROM pur_order WHERE country_id=NEW.country_id AND id=purchase_id;END IF;
 ELSIF NEW.source_type='PUR_RECEIPT_LINE' THEN
  SELECT r.status,l.order_line_id INTO receipt_status,purchase_line_id FROM pur_domestic_receipt_line l JOIN pur_domestic_receipt r ON r.country_id=l.country_id AND r.id=l.receipt_id WHERE l.country_id=NEW.country_id AND l.id=NEW.source_id FOR UPDATE OF l;
  IF receipt_status IS NOT NULL AND receipt_status<>'CONFIRMED' THEN RAISE EXCEPTION 'PUR_SOURCE_IN_USE: receipt is not confirmed' USING ERRCODE='23514';END IF;
  SELECT o.status INTO order_status FROM pur_order_line l JOIN pur_order o ON o.country_id=l.country_id AND o.id=l.order_id WHERE l.country_id=NEW.country_id AND l.id=purchase_line_id FOR UPDATE OF l;
 ELSE RETURN NEW;END IF;
 -- Missing rows are reported by the typed FK, preserving its exact provenance.
 IF order_status IS NOT NULL AND order_status NOT IN ('CONFIRMED','PARTIAL_DELIVERED','DELIVERED','CLOSED') THEN RAISE EXCEPTION 'PUR_SOURCE_IN_USE: purchase is not confirmed' USING ERRCODE='23514';END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER ap_purchase_source BEFORE INSERT OR UPDATE ON ap_source_claim FOR EACH ROW EXECUTE FUNCTION jxc_ap_purchase_claim_source_guard();

-- Void releases claims before changing bill status in one transaction. Check the
-- final state rather than requiring an unsafe order or allowing raw early release.
CREATE FUNCTION jxc_ap_claim_release_consistency() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE target_bill_id bigint; bill_status text;
BEGIN
 target_bill_id:=(to_jsonb(NEW)->>CASE WHEN TG_TABLE_NAME='ap_bill' THEN 'id' ELSE 'bill_id' END)::bigint;
 SELECT status INTO bill_status FROM ap_bill WHERE country_id=NEW.country_id AND id=target_bill_id;
 IF (bill_status<>'VOIDED' AND EXISTS(SELECT 1 FROM ap_source_claim WHERE country_id=NEW.country_id AND ap_source_claim.bill_id=target_bill_id AND NOT effective)) OR (bill_status='VOIDED' AND EXISTS(SELECT 1 FROM ap_source_claim WHERE country_id=NEW.country_id AND ap_source_claim.bill_id=target_bill_id AND effective)) THEN
  RAISE EXCEPTION 'AP_CLAIM_RELEASE_REQUIRES_VOID' USING ERRCODE='23514';
 END IF;
 RETURN NULL;
END $$;
CREATE CONSTRAINT TRIGGER ap_claim_release_final AFTER INSERT OR UPDATE ON ap_source_claim DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION jxc_ap_claim_release_consistency();
CREATE CONSTRAINT TRIGGER ap_bill_claim_release_final AFTER UPDATE ON ap_bill DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION jxc_ap_claim_release_consistency();

CREATE FUNCTION jxc_ap_source_balance_consistency() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE q numeric; a numeric; cap record;
BEGIN
 SELECT * INTO cap FROM ap_source_capacity WHERE country_id=NEW.country_id AND id=NEW.id;
 SELECT coalesce(sum(qty),0),coalesce(sum(amount),0) INTO q,a FROM ap_source_claim WHERE country_id=cap.country_id AND source_type=cap.source_type AND source_id=cap.source_id AND effective;
 IF cap.claimed_qty IS DISTINCT FROM q OR cap.claimed_amount IS DISTINCT FROM a THEN RAISE EXCEPTION 'AP_SOURCE_BALANCE_INCONSISTENT' USING ERRCODE='23514';END IF;
 RETURN NULL;
END $$;
CREATE CONSTRAINT TRIGGER ap_source_balance_final AFTER INSERT OR UPDATE ON ap_source_capacity DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION jxc_ap_source_balance_consistency();
