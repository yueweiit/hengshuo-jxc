-- Explicit AP-owned purchase-cost matching. Monetary interpretation remains in
-- the source owner and AccountingAmounts; SQL protects provenance and capacity.
ALTER TABLE ap_bill ADD CONSTRAINT ap_bill_country_book_id UNIQUE(country_id,book_id,id);

CREATE TABLE ap_cost_assignment (
 id jxc_safe_id PRIMARY KEY DEFAULT nextval('jxc_id_seq'),
 country_id jxc_safe_id NOT NULL REFERENCES sys_country(id),book_id jxc_safe_id NOT NULL,cost_id jxc_safe_id NOT NULL,
 version bigint NOT NULL DEFAULT 0 CHECK(version>=0),
 status varchar(16) NOT NULL DEFAULT 'DRAFT' CHECK(status IN('DRAFT','FROZEN')),
 source_basis jsonb NOT NULL CHECK(jsonb_typeof(source_basis)='object' AND jxc_json_ids_safe(source_basis)),
 frozen_event_id jxc_safe_id,frozen_at timestamptz,
 created_by jxc_safe_id NOT NULL REFERENCES sys_user(id),created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 UNIQUE(country_id,id),UNIQUE(country_id,book_id,id),UNIQUE(country_id,book_id,id,cost_id),UNIQUE(country_id,cost_id),UNIQUE(country_id,frozen_event_id),
 FOREIGN KEY(country_id,book_id,cost_id) REFERENCES cst_inbound_cost(country_id,book_id,id),
 FOREIGN KEY(country_id,book_id,frozen_event_id) REFERENCES sys_biz_event(country_id,book_id,id),
 CHECK((status='DRAFT' AND frozen_event_id IS NULL AND frozen_at IS NULL) OR (status='FROZEN' AND frozen_event_id IS NOT NULL AND frozen_at IS NOT NULL))
);
CREATE TABLE ap_cost_assignment_line (
 id jxc_safe_id PRIMARY KEY DEFAULT nextval('jxc_id_seq'),
 country_id jxc_safe_id NOT NULL,book_id jxc_safe_id NOT NULL,assignment_id jxc_safe_id NOT NULL,cost_id jxc_safe_id NOT NULL,
 bill_id jxc_safe_id NOT NULL,bill_line_id jxc_safe_id NOT NULL,
 canonical_source_type varchar(32) NOT NULL CHECK(canonical_source_type='PUR_ORDER_LINE_BASE'),canonical_source_id jxc_safe_id NOT NULL,
 base_qty numeric(24,6) NOT NULL CHECK(base_qty>0),
 principal_amount numeric(24,4) CHECK(principal_amount>=0),economic_basis jsonb CHECK(jsonb_typeof(economic_basis)='object' AND jxc_json_ids_safe(economic_basis)),
 UNIQUE(country_id,id),UNIQUE(country_id,assignment_id,bill_line_id),
 FOREIGN KEY(country_id,book_id,assignment_id,cost_id) REFERENCES ap_cost_assignment(country_id,book_id,id,cost_id),
 FOREIGN KEY(country_id,book_id,cost_id) REFERENCES cst_inbound_cost(country_id,book_id,id),
 FOREIGN KEY(country_id,book_id,bill_id) REFERENCES ap_bill(country_id,book_id,id),
 FOREIGN KEY(country_id,bill_id,bill_line_id) REFERENCES ap_bill_line(country_id,bill_id,id),
 FOREIGN KEY(country_id,canonical_source_type,canonical_source_id) REFERENCES ap_source_capacity(country_id,source_type,source_id),
 FOREIGN KEY(country_id,canonical_source_id) REFERENCES pur_order_line(country_id,id),
 CHECK((principal_amount IS NULL)=(economic_basis IS NULL))
);
CREATE INDEX ap_cost_assignment_bill_usage ON ap_cost_assignment_line(country_id,bill_id,bill_line_id);

-- Shared by the original application commands before their existing row locks.
-- The advisory lock conveys no data or monetary authority.
CREATE FUNCTION jxc_ap_cost_basis_lock(selected_country bigint,selected_book bigint) RETURNS void LANGUAGE plpgsql VOLATILE AS $$
BEGIN
 IF selected_country IS NULL OR selected_book IS NULL OR NOT EXISTS(SELECT 1 FROM fin_book WHERE country_id=selected_country AND id=selected_book) THEN RAISE EXCEPTION 'AP_COST_ASSIGNMENT_SOURCE_INVALID';END IF;
 PERFORM pg_advisory_xact_lock(hashtextextended('AP_COST_BASIS:'||selected_country||':'||selected_book,0));
END $$;
REVOKE ALL ON FUNCTION jxc_ap_cost_basis_lock(bigint,bigint) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION jxc_ap_cost_basis_lock(bigint,bigint) TO "${runtimeRole}";

-- This is a comparison against original stored fields, never a cost calculation.
CREATE FUNCTION jxc_ap_cost_source_basis(selected_country bigint,selected_book bigint,selected_cost bigint) RETURNS jsonb LANGUAGE sql STABLE AS $$
 SELECT jsonb_build_object('costId',c.id,'bookId',c.book_id,'warehouseId',c.warehouse_id,'productId',c.product_id,'batchId',c.batch_id,
  'poId',c.po_id,'poLineId',c.po_line_id,'qty',c.qty,'srcCurrency',c.src_currency,'srcAmount',c.src_amount,
  'baseCurrency',c.base_currency,'basePurchaseAmount',f.base_purchase_amount,'rate',f.rate,'rateId',f.rate_id,'rateDate',f.rate_date,'rateVersion',f.rate_version,'confirmedBizDate',f.biz_date)
 FROM cst_inbound_cost c JOIN cst_cost_confirmation f ON f.country_id=c.country_id AND f.book_id=c.book_id AND f.cost_id=c.id
 JOIN pur_order_line l ON l.country_id=c.country_id AND l.id=c.po_line_id AND l.order_id=c.po_id AND l.product_id=c.product_id
 JOIN pur_order p ON p.country_id=l.country_id AND p.id=l.order_id AND p.book_id=c.book_id AND p.currency=c.src_currency
 WHERE c.country_id=selected_country AND c.book_id=selected_book AND c.id=selected_cost AND c.po_id IS NOT NULL AND c.po_line_id IS NOT NULL;
$$;

CREATE FUNCTION jxc_ap_cost_current_intent(selected_country bigint,selected_book bigint,selected_cost bigint,selected_event bigint) RETURNS boolean LANGUAGE sql STABLE AS $$
 SELECT EXISTS(SELECT 1 FROM sys_biz_event e JOIN sys_biz_event_consume c ON c.country_id=e.country_id AND c.book_id=e.book_id AND c.event_id=e.id
 WHERE e.country_id=selected_country AND e.book_id=selected_book AND e.id=selected_event
  AND e.event_type='CST_INBOUND_COST_CONFIRMED' AND e.source_type='CST_INBOUND_COST' AND e.source_id=selected_cost
  AND c.consumer='FIN_VOUCHER' AND c.status='PROCESSING' AND c.xmin::text::numeric=mod(pg_current_xact_id()::text::numeric,4294967296));
$$;

CREATE FUNCTION jxc_ap_cost_assignment_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE selected_value jsonb;expected_basis jsonb;
BEGIN
 selected_value:=CASE WHEN TG_OP='DELETE' THEN to_jsonb(OLD) ELSE to_jsonb(NEW) END;
 PERFORM jxc_ap_cost_basis_lock((selected_value->>'country_id')::bigint,(selected_value->>'book_id')::bigint);
 expected_basis:=jxc_ap_cost_source_basis((selected_value->>'country_id')::bigint,(selected_value->>'book_id')::bigint,(selected_value->>'cost_id')::bigint);
 IF expected_basis IS NULL OR selected_value->'source_basis' IS DISTINCT FROM expected_basis THEN RAISE EXCEPTION 'AP_COST_ASSIGNMENT_SOURCE_CHANGED';END IF;
 PERFORM jxc_assert_period_open((selected_value->>'country_id')::bigint,(selected_value->>'book_id')::bigint,(expected_basis->>'confirmedBizDate')::date);
 IF EXISTS(SELECT 1 FROM fin_event_result r JOIN sys_biz_event e ON e.country_id=r.country_id AND e.id=r.event_id WHERE e.country_id=(selected_value->>'country_id')::bigint AND e.book_id=(selected_value->>'book_id')::bigint AND e.source_type='CST_INBOUND_COST' AND e.source_id=(selected_value->>'cost_id')::bigint AND e.event_type='CST_INBOUND_COST_CONFIRMED') THEN RAISE EXCEPTION 'AP_COST_ASSIGNMENT_LEGACY_RESULT';END IF;
 IF TG_OP='INSERT' THEN
  IF NEW.status<>'DRAFT' OR NEW.version<>0 THEN RAISE EXCEPTION 'AP_COST_ASSIGNMENT_STATE_INVALID';END IF;
  RETURN NEW;
 END IF;
 IF OLD.status='FROZEN' THEN RAISE EXCEPTION 'AP_COST_ASSIGNMENT_IMMUTABLE';END IF;
 IF TG_OP='DELETE' THEN RETURN OLD;END IF;
 IF (to_jsonb(NEW)-ARRAY['status','version','frozen_event_id','frozen_at']) IS DISTINCT FROM (to_jsonb(OLD)-ARRAY['status','version','frozen_event_id','frozen_at']) OR NEW.version<>OLD.version+1 THEN RAISE EXCEPTION 'AP_COST_ASSIGNMENT_IMMUTABLE';END IF;
 IF NEW.status='FROZEN' AND NOT jxc_ap_cost_current_intent(NEW.country_id,NEW.book_id,NEW.cost_id,NEW.frozen_event_id) THEN RAISE EXCEPTION 'AP_COST_ASSIGNMENT_INTENT_REQUIRED';END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER ap_cost_assignment_guard BEFORE INSERT OR UPDATE OR DELETE ON ap_cost_assignment FOR EACH ROW EXECUTE FUNCTION jxc_ap_cost_assignment_guard();

CREATE FUNCTION jxc_ap_cost_assignment_line_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE selected_value jsonb;parent ap_cost_assignment;parent_xid numeric;cost cst_inbound_cost;bill ap_bill;bill_line ap_bill_line;claim ap_source_claim;expected_basis jsonb;used_qty numeric;selected_line bigint;
BEGIN
 selected_value:=CASE WHEN TG_OP='DELETE' THEN to_jsonb(OLD) ELSE to_jsonb(NEW) END;
 PERFORM jxc_ap_cost_basis_lock((selected_value->>'country_id')::bigint,(selected_value->>'book_id')::bigint);
 SELECT * INTO parent FROM ap_cost_assignment WHERE country_id=(selected_value->>'country_id')::bigint AND book_id=(selected_value->>'book_id')::bigint AND id=(selected_value->>'assignment_id')::bigint FOR UPDATE;
 SELECT xmin::text::numeric INTO parent_xid FROM ap_cost_assignment WHERE country_id=parent.country_id AND id=parent.id;
 IF parent.id IS NULL OR parent.cost_id IS DISTINCT FROM (selected_value->>'cost_id')::bigint THEN RAISE EXCEPTION 'AP_COST_ASSIGNMENT_SOURCE_INVALID';END IF;
 IF parent.status='DRAFT' AND EXISTS(SELECT 1 FROM fin_event_result r JOIN sys_biz_event e ON e.country_id=r.country_id AND e.id=r.event_id WHERE e.country_id=parent.country_id AND e.book_id=parent.book_id AND e.source_type='CST_INBOUND_COST' AND e.source_id=parent.cost_id AND e.event_type='CST_INBOUND_COST_CONFIRMED') THEN RAISE EXCEPTION 'AP_COST_ASSIGNMENT_LEGACY_RESULT';END IF;
 IF TG_OP='DELETE' THEN
  IF parent.status<>'DRAFT' THEN RAISE EXCEPTION 'AP_COST_ASSIGNMENT_IMMUTABLE';END IF;
  PERFORM jxc_assert_period_open(parent.country_id,parent.book_id,(parent.source_basis->>'confirmedBizDate')::date);
  RETURN OLD;
 END IF;
 IF TG_OP='INSERT' THEN
  IF parent.status<>'DRAFT' OR NEW.principal_amount IS NOT NULL OR NEW.economic_basis IS NOT NULL THEN RAISE EXCEPTION 'AP_COST_ASSIGNMENT_STATE_INVALID';END IF;
 ELSE
  IF parent.status<>'FROZEN' OR parent_xid<>mod(pg_current_xact_id()::text::numeric,4294967296)
    OR OLD.principal_amount IS NOT NULL OR OLD.economic_basis IS NOT NULL OR NEW.principal_amount IS NULL OR NEW.economic_basis IS NULL
    OR (to_jsonb(NEW)-ARRAY['principal_amount','economic_basis']) IS DISTINCT FROM (to_jsonb(OLD)-ARRAY['principal_amount','economic_basis'])
    OR NOT jxc_ap_cost_current_intent(parent.country_id,parent.book_id,parent.cost_id,parent.frozen_event_id) THEN RAISE EXCEPTION 'AP_COST_ASSIGNMENT_IMMUTABLE';END IF;
 END IF;
 SELECT * INTO cost FROM cst_inbound_cost WHERE country_id=NEW.country_id AND book_id=NEW.book_id AND id=NEW.cost_id;
 SELECT * INTO bill FROM ap_bill WHERE country_id=NEW.country_id AND book_id=NEW.book_id AND id=NEW.bill_id FOR UPDATE;
 SELECT * INTO bill_line FROM ap_bill_line WHERE country_id=NEW.country_id AND bill_id=NEW.bill_id AND id=NEW.bill_line_id FOR UPDATE;
 SELECT * INTO claim FROM ap_source_claim WHERE country_id=NEW.country_id AND bill_id=NEW.bill_id AND bill_line_id=NEW.bill_line_id AND source_type='PUR_ORDER_LINE_BASE' AND source_id=NEW.canonical_source_id AND effective FOR UPDATE;
 IF bill.id IS NULL OR bill_line.id IS NULL OR claim.id IS NULL OR bill.status NOT IN('CONFIRMED','PARTIAL_PAID','PAID') OR bill.valuation_status<>'READY'
  OR bill.partner_type<>'SUPPLIER' OR bill.bill_type<>'PURCHASE' OR bill.currency IS DISTINCT FROM cost.src_currency OR bill.base_currency IS DISTINCT FROM cost.base_currency
  OR bill.rate IS NULL OR parent.source_basis->>'rate' IS NULL OR bill.rate IS DISTINCT FROM (parent.source_basis->>'rate')::numeric
  OR bill.partner_id IS DISTINCT FROM (SELECT supplier_id FROM pur_order WHERE country_id=cost.country_id AND id=cost.po_id)
  OR bill_line.product_id IS DISTINCT FROM cost.product_id OR bill_line.canonical_source_type IS DISTINCT FROM NEW.canonical_source_type OR bill_line.canonical_source_id IS DISTINCT FROM NEW.canonical_source_id
  OR NEW.canonical_source_type<>'PUR_ORDER_LINE_BASE' OR NEW.canonical_source_id IS DISTINCT FROM cost.po_line_id
  OR jxc_ap_cost_source_basis(parent.country_id,parent.book_id,parent.cost_id) IS DISTINCT FROM parent.source_basis THEN RAISE EXCEPTION 'AP_COST_ASSIGNMENT_SOURCE_CHANGED';END IF;
 PERFORM jxc_assert_period_open(parent.country_id,parent.book_id,(parent.source_basis->>'confirmedBizDate')::date);
 selected_line:=NEW.id;
 SELECT coalesce(sum(base_qty),0) INTO used_qty FROM ap_cost_assignment_line WHERE country_id=NEW.country_id AND bill_line_id=NEW.bill_line_id AND id<>selected_line;
 IF used_qty+NEW.base_qty>claim.qty THEN RAISE EXCEPTION 'AP_COST_ASSIGNMENT_CAPACITY_EXCEEDED';END IF;
 SELECT coalesce(sum(base_qty),0) INTO used_qty FROM ap_cost_assignment_line WHERE country_id=NEW.country_id AND assignment_id=NEW.assignment_id AND id<>selected_line;
 IF used_qty+NEW.base_qty>cost.qty THEN RAISE EXCEPTION 'AP_COST_ASSIGNMENT_CAPACITY_EXCEEDED';END IF;
 IF NEW.economic_basis IS NOT NULL THEN
  expected_basis:=jsonb_build_object('billId',bill.id,'billLineId',bill_line.id,'bookId',bill.book_id,'partnerId',bill.partner_id,'currency',bill.currency,'baseCurrency',bill.base_currency,
   'billAmount',bill.amount,'billBaseAmount',bill.base_amount,'rate',bill.rate,'rateId',bill.rate_id,'rateDate',bill.rate_date,'lineAmount',bill_line.amount,
   'canonicalSourceType',NEW.canonical_source_type,'canonicalSourceId',NEW.canonical_source_id,'canonicalQty',claim.qty,'baseQty',NEW.base_qty,'principalAmount',NEW.principal_amount);
  IF NEW.economic_basis IS DISTINCT FROM expected_basis THEN RAISE EXCEPTION 'AP_COST_ASSIGNMENT_SOURCE_CHANGED';END IF;
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER ap_cost_assignment_line_guard BEFORE INSERT OR UPDATE OR DELETE ON ap_cost_assignment_line FOR EACH ROW EXECUTE FUNCTION jxc_ap_cost_assignment_line_guard();

CREATE FUNCTION jxc_ap_cost_assignment_final() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE selected_value jsonb;selected_assignment bigint;parent ap_cost_assignment;total_qty numeric;line_count bigint;
BEGIN
 selected_value:=CASE WHEN TG_OP='DELETE' THEN to_jsonb(OLD) ELSE to_jsonb(NEW) END;
 selected_assignment:=(selected_value->>CASE WHEN TG_TABLE_NAME='ap_cost_assignment' THEN 'id' ELSE 'assignment_id' END)::bigint;
 SELECT * INTO parent FROM ap_cost_assignment WHERE country_id=(selected_value->>'country_id')::bigint AND id=selected_assignment;
 IF parent.id IS NULL THEN RETURN NULL;END IF;
 IF parent.status='DRAFT' THEN
  IF EXISTS(SELECT 1 FROM ap_cost_assignment_line WHERE country_id=parent.country_id AND assignment_id=parent.id AND (principal_amount IS NOT NULL OR economic_basis IS NOT NULL)) THEN RAISE EXCEPTION 'AP_COST_ASSIGNMENT_STATE_INVALID';END IF;
  RETURN NULL;
 END IF;
 SELECT count(*),coalesce(sum(base_qty),0) INTO line_count,total_qty FROM ap_cost_assignment_line WHERE country_id=parent.country_id AND assignment_id=parent.id;
 IF line_count=0 OR total_qty IS DISTINCT FROM (parent.source_basis->>'qty')::numeric
  OR EXISTS(SELECT 1 FROM ap_cost_assignment_line WHERE country_id=parent.country_id AND assignment_id=parent.id AND (principal_amount IS NULL OR economic_basis IS NULL))
  OR NOT EXISTS(SELECT 1 FROM fin_event_result r JOIN sys_biz_event e ON e.country_id=r.country_id AND e.book_id=r.book_id AND e.id=r.event_id
   JOIN sys_biz_event_consume c ON c.country_id=e.country_id AND c.book_id=e.book_id AND c.event_id=e.id
   WHERE r.country_id=parent.country_id AND r.book_id=parent.book_id AND r.event_id=parent.frozen_event_id AND r.status IN('GENERATED','NO_VOUCHER')
    AND e.event_type='CST_INBOUND_COST_CONFIRMED' AND e.source_type='CST_INBOUND_COST' AND e.source_id=parent.cost_id
    AND c.consumer='FIN_VOUCHER' AND c.status IN('PROCESSING','DONE') AND c.xmin::text::numeric=mod(pg_current_xact_id()::text::numeric,4294967296)) THEN RAISE EXCEPTION 'AP_COST_ASSIGNMENT_RESULT_REQUIRED';END IF;
 RETURN NULL;
END $$;
CREATE CONSTRAINT TRIGGER ap_cost_assignment_final AFTER INSERT OR UPDATE OR DELETE ON ap_cost_assignment DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION jxc_ap_cost_assignment_final();
CREATE CONSTRAINT TRIGGER ap_cost_assignment_line_final AFTER INSERT OR UPDATE OR DELETE ON ap_cost_assignment_line DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION jxc_ap_cost_assignment_final();

-- The reverse relationship also rejects an older application or a missing hook.
-- Existing results are not rewritten, and non-purchase sources keep their rules.
CREATE FUNCTION jxc_ap_cost_result_assignment_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE source_event sys_biz_event;source_cost cst_inbound_cost;
BEGIN
 SELECT * INTO source_event FROM sys_biz_event WHERE country_id=NEW.country_id AND id=NEW.event_id;
 IF source_event.event_type IS DISTINCT FROM 'CST_INBOUND_COST_CONFIRMED' OR source_event.source_type IS DISTINCT FROM 'CST_INBOUND_COST' THEN RETURN NEW;END IF;
 SELECT * INTO source_cost FROM cst_inbound_cost WHERE country_id=NEW.country_id AND id=source_event.source_id;
 IF source_cost.id IS NULL OR source_cost.book_id IS DISTINCT FROM NEW.book_id THEN RAISE EXCEPTION 'AP_COST_ASSIGNMENT_SOURCE_INVALID';END IF;
 IF source_cost.po_id IS NOT NULL THEN
  IF NOT jxc_ap_cost_current_intent(NEW.country_id,NEW.book_id,source_cost.id,NEW.event_id)
   OR NOT EXISTS(SELECT 1 FROM ap_cost_assignment a WHERE a.country_id=NEW.country_id AND a.book_id=NEW.book_id AND a.cost_id=source_cost.id AND a.status='FROZEN' AND a.frozen_event_id=NEW.event_id) THEN
   RAISE EXCEPTION 'AP_COST_ASSIGNMENT_REQUIRED';
  END IF;
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER fin_purchase_cost_assignment_guard BEFORE INSERT ON fin_event_result FOR EACH ROW EXECUTE FUNCTION jxc_ap_cost_result_assignment_guard();

CREATE FUNCTION jxc_ap_cost_bill_dependency() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF TG_OP='DELETE' THEN
  PERFORM jxc_ap_cost_basis_lock(OLD.country_id,OLD.book_id);
  IF EXISTS(SELECT 1 FROM ap_cost_assignment_line WHERE country_id=OLD.country_id AND bill_id=OLD.id) THEN RAISE EXCEPTION 'AP_COST_ASSIGNMENT_IN_USE';END IF;
  RETURN OLD;
 END IF;
 IF NEW.status='VOIDED' AND NEW.status IS DISTINCT FROM OLD.status THEN
  PERFORM jxc_ap_cost_basis_lock(OLD.country_id,OLD.book_id);
  IF EXISTS(SELECT 1 FROM ap_cost_assignment_line WHERE country_id=OLD.country_id AND bill_id=OLD.id) THEN RAISE EXCEPTION 'AP_COST_ASSIGNMENT_IN_USE';END IF;
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER ap_cost_bill_dependency BEFORE UPDATE OR DELETE ON ap_bill FOR EACH ROW EXECUTE FUNCTION jxc_ap_cost_bill_dependency();
CREATE FUNCTION jxc_ap_cost_claim_dependency() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE selected_book bigint;
BEGIN
 IF TG_OP='UPDATE' THEN
  IF (to_jsonb(NEW)-ARRAY['version']) IS NOT DISTINCT FROM (to_jsonb(OLD)-ARRAY['version']) THEN RETURN NEW;END IF;
 END IF;
 SELECT book_id INTO selected_book FROM ap_bill WHERE country_id=OLD.country_id AND id=OLD.bill_id;
 PERFORM jxc_ap_cost_basis_lock(OLD.country_id,selected_book);
 IF EXISTS(SELECT 1 FROM ap_cost_assignment_line WHERE country_id=OLD.country_id AND bill_id=OLD.bill_id AND bill_line_id=OLD.bill_line_id) THEN RAISE EXCEPTION 'AP_COST_ASSIGNMENT_IN_USE';END IF;
 IF TG_OP='DELETE' THEN RETURN OLD;END IF;RETURN NEW;
END $$;
CREATE TRIGGER ap_cost_claim_dependency BEFORE UPDATE OR DELETE ON ap_source_claim FOR EACH ROW EXECUTE FUNCTION jxc_ap_cost_claim_dependency();

DO $$ DECLARE target_table text;BEGIN
 FOREACH target_table IN ARRAY ARRAY['ap_cost_assignment','ap_cost_assignment_line'] LOOP
  EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY',target_table);
  EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY',target_table);
  EXECUTE format('CREATE POLICY country_isolation ON %I USING(country_id=jxc_current_country_id()) WITH CHECK(country_id=jxc_current_country_id())',target_table);
  EXECUTE format('CREATE TRIGGER jxc_write_gate BEFORE INSERT OR UPDATE OR DELETE OR TRUNCATE ON %I FOR EACH STATEMENT EXECUTE FUNCTION jxc_assert_writes_open()',target_table);
  EXECUTE format('CREATE TRIGGER jxc_country_gate BEFORE INSERT OR UPDATE OR DELETE ON %I FOR EACH ROW EXECUTE FUNCTION jxc_country_mutation_gate(''TRADE'')',target_table);
  EXECUTE format('GRANT SELECT,INSERT,UPDATE ON %I TO "${runtimeRole}"',target_table);
 END LOOP;
END $$;
GRANT DELETE ON ap_cost_assignment_line TO "${runtimeRole}";
