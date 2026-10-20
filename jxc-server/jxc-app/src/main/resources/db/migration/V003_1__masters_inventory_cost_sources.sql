-- M2 physical inventory and immutable valuation source facts. No demo/opening balances.
CREATE TABLE md_category (
 id jxc_safe_id PRIMARY KEY DEFAULT nextval('jxc_id_seq'),code varchar(64) NOT NULL UNIQUE,name varchar(200) NOT NULL,parent_id jxc_safe_id REFERENCES md_category(id),level int NOT NULL DEFAULT 1 CHECK(level>0),status varchar(16) NOT NULL DEFAULT 'ENABLED',version int NOT NULL DEFAULT 1
);
CREATE TABLE md_product (
 id jxc_safe_id PRIMARY KEY DEFAULT nextval('jxc_id_seq'),product_code varchar(64) NOT NULL UNIQUE,name varchar(200) NOT NULL,base_unit varchar(32) NOT NULL DEFAULT 'PCS',category_id jxc_safe_id REFERENCES md_category(id),
 brand varchar(100) NOT NULL DEFAULT '',spec varchar(200) NOT NULL DEFAULT '',barcode_text varchar(100) NOT NULL DEFAULT '',
 status varchar(16) NOT NULL DEFAULT 'ENABLED' CHECK(status IN ('ENABLED','DISABLED')),version int NOT NULL DEFAULT 1 CHECK(version>0)
);
CREATE TABLE md_country_sku (
 id jxc_safe_id PRIMARY KEY DEFAULT nextval('jxc_id_seq'),country_id jxc_safe_id NOT NULL REFERENCES sys_country(id),product_id jxc_safe_id NOT NULL,
 local_name varchar(200) NOT NULL DEFAULT '',tax_category varchar(64) NOT NULL DEFAULT '',status varchar(16) NOT NULL DEFAULT 'ENABLED' CHECK(status IN ('ENABLED','DISABLED')),version int NOT NULL DEFAULT 1,
 UNIQUE(country_id,id),UNIQUE(country_id,product_id),FOREIGN KEY(product_id) REFERENCES md_product(id)
);
CREATE TABLE md_product_unit (
 id jxc_safe_id PRIMARY KEY DEFAULT nextval('jxc_id_seq'),product_id jxc_safe_id NOT NULL REFERENCES md_product(id),unit varchar(32) NOT NULL,factor_to_base numeric(20,8) NOT NULL CHECK(factor_to_base>0),is_purchase_default boolean NOT NULL DEFAULT false,is_sales_default boolean NOT NULL DEFAULT false,version int NOT NULL DEFAULT 1,UNIQUE(product_id,unit)
);
CREATE TABLE md_product_unit_used (product_id jxc_safe_id NOT NULL,unit varchar(32) NOT NULL,PRIMARY KEY(product_id,unit),FOREIGN KEY(product_id,unit) REFERENCES md_product_unit(product_id,unit));
CREATE FUNCTION jxc_guard_used_unit() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
 IF NEW.factor_to_base<>OLD.factor_to_base AND EXISTS(SELECT 1 FROM md_product_unit_used WHERE product_id=OLD.product_id AND unit=OLD.unit) THEN RAISE EXCEPTION 'MD_UNIT_REFERENCED'; END IF; RETURN NEW; END $$;
CREATE TRIGGER md_used_unit_guard BEFORE UPDATE ON md_product_unit FOR EACH ROW EXECUTE FUNCTION jxc_guard_used_unit();
CREATE TABLE md_product_barcode (
 id jxc_safe_id PRIMARY KEY DEFAULT nextval('jxc_id_seq'),product_id jxc_safe_id NOT NULL REFERENCES md_product(id),unit varchar(32) NOT NULL,barcode varchar(100) NOT NULL UNIQUE CHECK(btrim(barcode)<>''),FOREIGN KEY(product_id,unit) REFERENCES md_product_unit(product_id,unit)
);
CREATE TABLE md_exchange_rate (
 id jxc_safe_id PRIMARY KEY DEFAULT nextval('jxc_id_seq'),country_id jxc_safe_id NOT NULL REFERENCES sys_country(id),from_ccy varchar(3) NOT NULL,to_ccy varchar(3) NOT NULL,rate_date date NOT NULL,
 scope varchar(32) NOT NULL,rate numeric(18,8) NOT NULL CHECK(rate>0),version_no int NOT NULL DEFAULT 1 CHECK(version_no>0),status varchar(16) NOT NULL DEFAULT 'DRAFT' CHECK(status IN ('DRAFT','CONFIRMED','RETIRED')),confirmed_by jxc_safe_id REFERENCES sys_user(id),confirmed_at timestamptz,version int NOT NULL DEFAULT 1,
 UNIQUE(country_id,id),UNIQUE(country_id,from_ccy,to_ccy,rate_date,scope,version_no),CHECK(from_ccy ~ '^[A-Z]{3}$' AND to_ccy ~ '^[A-Z]{3}$')
);
CREATE TABLE cst_method_config (
 id jxc_safe_id PRIMARY KEY DEFAULT nextval('jxc_id_seq'),country_id jxc_safe_id NOT NULL REFERENCES sys_country(id),book_id jxc_safe_id NOT NULL,method varchar(20) NOT NULL CHECK(method IN ('FIFO','BATCH_SPECIFIC','MOVING_AVG')),version_no int NOT NULL DEFAULT 1,status varchar(16) NOT NULL DEFAULT 'ACTIVE',effective_from date NOT NULL,
 UNIQUE(country_id,id),UNIQUE(country_id,book_id),FOREIGN KEY(country_id,book_id) REFERENCES fin_book(country_id,id)
);
CREATE TABLE inv_batch (
 id jxc_safe_id PRIMARY KEY DEFAULT nextval('jxc_id_seq'),country_id jxc_safe_id NOT NULL REFERENCES sys_country(id),book_id jxc_safe_id NOT NULL, product_id jxc_safe_id NOT NULL,batch_no varchar(100) NOT NULL,source_type varchar(64) NOT NULL,source_id jxc_safe_id NOT NULL,source_line_id jxc_safe_id NOT NULL,shipment_id jxc_safe_id,po_line_id jxc_safe_id,first_inbound_date date NOT NULL,request_hash varchar(64),cost_snapshot_id jxc_safe_id,
 UNIQUE(country_id,id),UNIQUE(country_id,id,product_id),UNIQUE(country_id,batch_no),UNIQUE(country_id,source_type,source_line_id),FOREIGN KEY(country_id,book_id) REFERENCES fin_book(country_id,id),FOREIGN KEY(country_id,product_id) REFERENCES md_country_sku(country_id,product_id)
);
CREATE TABLE inv_warehouse_sku_guard (
 country_id jxc_safe_id NOT NULL,warehouse_id jxc_safe_id NOT NULL,product_id jxc_safe_id NOT NULL,stocktake_id jxc_safe_id,
 PRIMARY KEY(country_id,warehouse_id,product_id),FOREIGN KEY(country_id,warehouse_id) REFERENCES org_warehouse(country_id,id),FOREIGN KEY(country_id,product_id) REFERENCES md_country_sku(country_id,product_id)
);
CREATE TABLE inv_stock_summary (
 id jxc_safe_id PRIMARY KEY DEFAULT nextval('jxc_id_seq'),country_id jxc_safe_id NOT NULL,warehouse_id jxc_safe_id NOT NULL,product_id jxc_safe_id NOT NULL,on_hand_qty numeric(20,4) NOT NULL DEFAULT 0,reserved_qty numeric(20,4) NOT NULL DEFAULT 0,frozen_qty numeric(20,4) NOT NULL DEFAULT 0,version int NOT NULL DEFAULT 1,
 UNIQUE(country_id,id),UNIQUE(country_id,warehouse_id,product_id),FOREIGN KEY(country_id,warehouse_id) REFERENCES org_warehouse(country_id,id),FOREIGN KEY(country_id,product_id) REFERENCES md_country_sku(country_id,product_id),CHECK(on_hand_qty>=0 AND reserved_qty>=0 AND frozen_qty>=0 AND on_hand_qty>=reserved_qty+frozen_qty)
);
CREATE TABLE inv_batch_balance (
 id jxc_safe_id PRIMARY KEY DEFAULT nextval('jxc_id_seq'),country_id jxc_safe_id NOT NULL,warehouse_id jxc_safe_id NOT NULL,product_id jxc_safe_id NOT NULL,batch_id jxc_safe_id NOT NULL,on_hand_qty numeric(20,4) NOT NULL DEFAULT 0,frozen_qty numeric(20,4) NOT NULL DEFAULT 0,version int NOT NULL DEFAULT 1,
 UNIQUE(country_id,id),UNIQUE(country_id,warehouse_id,batch_id),FOREIGN KEY(country_id,warehouse_id,product_id) REFERENCES inv_stock_summary(country_id,warehouse_id,product_id),FOREIGN KEY(country_id,batch_id,product_id) REFERENCES inv_batch(country_id,id,product_id),CHECK(on_hand_qty>=0 AND frozen_qty>=0 AND on_hand_qty>=frozen_qty)
);
CREATE TABLE inv_stock_txn (
 id jxc_safe_id PRIMARY KEY DEFAULT nextval('jxc_id_seq'),country_id jxc_safe_id NOT NULL,book_id jxc_safe_id NOT NULL,warehouse_id jxc_safe_id NOT NULL,product_id jxc_safe_id NOT NULL,batch_id jxc_safe_id NOT NULL,txn_type varchar(40) NOT NULL,on_hand_change numeric(20,4) NOT NULL,frozen_change numeric(20,4) NOT NULL,source_type varchar(64) NOT NULL,source_id jxc_safe_id NOT NULL,source_line_id jxc_safe_id NOT NULL,source_no varchar(100) NOT NULL DEFAULT '',seq int NOT NULL DEFAULT 1 CHECK(seq>0),biz_date date NOT NULL,occurred_at timestamptz NOT NULL DEFAULT clock_timestamp(),operator_id jxc_safe_id NOT NULL REFERENCES sys_user(id),unit_cost numeric(20,4),
 UNIQUE(country_id,id),UNIQUE(country_id,source_type,source_line_id,txn_type,seq),FOREIGN KEY(country_id,book_id) REFERENCES fin_book(country_id,id),FOREIGN KEY(country_id,warehouse_id,product_id) REFERENCES inv_stock_summary(country_id,warehouse_id,product_id),FOREIGN KEY(country_id,batch_id,product_id) REFERENCES inv_batch(country_id,id,product_id)
);
CREATE TABLE inv_reservation (
 id jxc_safe_id PRIMARY KEY DEFAULT nextval('jxc_id_seq'),country_id jxc_safe_id NOT NULL,book_id jxc_safe_id NOT NULL,warehouse_id jxc_safe_id NOT NULL,product_id jxc_safe_id NOT NULL,order_id jxc_safe_id NOT NULL,order_line_id jxc_safe_id NOT NULL,alloc_id jxc_safe_id NOT NULL,approval_version bigint NOT NULL DEFAULT 1 CHECK(approval_version>0),approval_qty numeric(20,4) NOT NULL CHECK(approval_qty>0),qty numeric(20,4) NOT NULL CHECK(qty>0),consumed_qty numeric(20,4) NOT NULL DEFAULT 0,released_qty numeric(20,4) NOT NULL DEFAULT 0,status varchar(16) NOT NULL DEFAULT 'ACTIVE',biz_date date NOT NULL,
 UNIQUE(country_id,id),UNIQUE(country_id,alloc_id),FOREIGN KEY(country_id,book_id) REFERENCES fin_book(country_id,id),FOREIGN KEY(country_id,warehouse_id,product_id) REFERENCES inv_stock_summary(country_id,warehouse_id,product_id),CHECK(consumed_qty>=0 AND released_qty>=0 AND consumed_qty+released_qty<=qty)
);
CREATE TABLE inv_freeze (
 id jxc_safe_id PRIMARY KEY DEFAULT nextval('jxc_id_seq'),country_id jxc_safe_id NOT NULL,book_id jxc_safe_id NOT NULL,warehouse_id jxc_safe_id NOT NULL,product_id jxc_safe_id NOT NULL,batch_id jxc_safe_id NOT NULL,freeze_type varchar(32) NOT NULL CHECK(freeze_type IN ('DAMAGED','PENDING_INSPECT','RETURN_PENDING','MANUAL')),qty numeric(20,4) NOT NULL CHECK(qty>0),released_qty numeric(20,4) NOT NULL DEFAULT 0,reason varchar(1000) NOT NULL,source_type varchar(64) NOT NULL,source_id jxc_safe_id NOT NULL,source_line_id jxc_safe_id NOT NULL,biz_date date NOT NULL,status varchar(16) NOT NULL DEFAULT 'ACTIVE',version int NOT NULL DEFAULT 1,
 UNIQUE(country_id,id),UNIQUE(country_id,source_type,source_line_id,freeze_type,batch_id),FOREIGN KEY(country_id,book_id) REFERENCES fin_book(country_id,id),FOREIGN KEY(country_id,warehouse_id,product_id) REFERENCES inv_stock_summary(country_id,warehouse_id,product_id),FOREIGN KEY(country_id,batch_id,product_id) REFERENCES inv_batch(country_id,id,product_id),CHECK(released_qty>=0 AND released_qty<=qty)
);
CREATE TABLE cst_inbound_cost (
 id jxc_safe_id PRIMARY KEY DEFAULT nextval('jxc_id_seq'),country_id jxc_safe_id NOT NULL,book_id jxc_safe_id NOT NULL,warehouse_id jxc_safe_id NOT NULL,product_id jxc_safe_id NOT NULL,batch_id jxc_safe_id NOT NULL,source_type varchar(64) NOT NULL,source_line_id jxc_safe_id NOT NULL,qty numeric(20,4) NOT NULL CHECK(qty>0),po_id jxc_safe_id,po_line_id jxc_safe_id,src_currency varchar(3) NOT NULL,src_unit_price numeric(20,4),src_amount numeric(20,4),purchase_original_amount numeric(20,4),purchase_base_qty numeric(20,4),src_unit varchar(32),src_factor numeric(18,8),base_currency varchar(3) NOT NULL,rate_id jxc_safe_id,rate numeric(18,8),rate_date date,rate_version int,base_purchase_amount numeric(20,4),unit_cost numeric(20,4),status varchar(32) NOT NULL CHECK(status IN ('PENDING_RATE','PENDING_SOURCE_COST','ESTIMATED','CONFIRMED')),original_outbound_line_id jxc_safe_id,source_cost_id jxc_safe_id,biz_date date NOT NULL,method varchar(20) NOT NULL,method_version int NOT NULL,created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 UNIQUE(country_id,id),UNIQUE(country_id,batch_id),UNIQUE(country_id,source_type,source_line_id),FOREIGN KEY(country_id,book_id) REFERENCES fin_book(country_id,id),FOREIGN KEY(country_id,batch_id,product_id) REFERENCES inv_batch(country_id,id,product_id),FOREIGN KEY(country_id,warehouse_id) REFERENCES org_warehouse(country_id,id),FOREIGN KEY(country_id,rate_id) REFERENCES md_exchange_rate(country_id,id),CHECK(src_unit_price IS NULL OR src_unit_price>=0),CHECK(unit_cost IS NULL OR unit_cost>=0),CHECK((rate IS NULL)=(rate_date IS NULL)),CHECK(status<>'PENDING_RATE' OR (rate IS NULL AND base_purchase_amount IS NULL AND unit_cost IS NULL))
);
ALTER TABLE cst_inbound_cost ADD FOREIGN KEY(country_id,source_cost_id) REFERENCES cst_inbound_cost(country_id,id);
ALTER TABLE inv_batch ADD FOREIGN KEY(country_id,cost_snapshot_id) REFERENCES cst_inbound_cost(country_id,id);
CREATE TABLE cst_cogs (
 id jxc_safe_id PRIMARY KEY DEFAULT nextval('jxc_id_seq'),country_id jxc_safe_id NOT NULL,book_id jxc_safe_id NOT NULL,warehouse_id jxc_safe_id NOT NULL,product_id jxc_safe_id NOT NULL,source_type varchar(64) NOT NULL,source_line_id jxc_safe_id NOT NULL,qty numeric(20,4) NOT NULL CHECK(qty>0),amount numeric(20,4),unit_cost numeric(20,4),method varchar(20) NOT NULL,method_version int NOT NULL,status varchar(32) NOT NULL CHECK(status IN ('PENDING_SOURCE_COST','ESTIMATED','CONFIRMED')),biz_date date NOT NULL,original_cogs_id jxc_safe_id,created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 UNIQUE(country_id,id),UNIQUE(country_id,source_type,source_line_id),FOREIGN KEY(country_id,book_id) REFERENCES fin_book(country_id,id),FOREIGN KEY(country_id,warehouse_id) REFERENCES org_warehouse(country_id,id),FOREIGN KEY(country_id,product_id) REFERENCES md_country_sku(country_id,product_id),FOREIGN KEY(country_id,original_cogs_id) REFERENCES cst_cogs(country_id,id),CHECK((amount IS NULL)=(unit_cost IS NULL)),CHECK(status<>'PENDING_SOURCE_COST' OR amount IS NULL)
);
CREATE TABLE cst_cogs_part (
 id jxc_safe_id PRIMARY KEY DEFAULT nextval('jxc_id_seq'),country_id jxc_safe_id NOT NULL,cogs_id jxc_safe_id NOT NULL,batch_id jxc_safe_id NOT NULL,part_type varchar(16) NOT NULL CHECK(part_type IN ('CONSUMED','VALUATION_POOL')),qty numeric(20,4) NOT NULL CHECK(qty>0),cost_id jxc_safe_id,unit_cost numeric(20,4),cost_status varchar(32) NOT NULL,
 UNIQUE(country_id,id),UNIQUE(country_id,cogs_id,part_type,batch_id),FOREIGN KEY(country_id,cogs_id) REFERENCES cst_cogs(country_id,id),FOREIGN KEY(country_id,batch_id) REFERENCES inv_batch(country_id,id),FOREIGN KEY(country_id,cost_id) REFERENCES cst_inbound_cost(country_id,id)
);

DO $$ DECLARE t text; BEGIN FOREACH t IN ARRAY ARRAY['md_country_sku','md_exchange_rate','cst_method_config','inv_batch','inv_warehouse_sku_guard','inv_stock_summary','inv_batch_balance','inv_stock_txn','inv_reservation','inv_freeze','cst_inbound_cost','cst_cogs','cst_cogs_part'] LOOP
 EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY',t);
 EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY',t);
 EXECUTE format('CREATE POLICY country_isolation ON %I USING(country_id=jxc_current_country_id()) WITH CHECK(country_id=jxc_current_country_id())',t);
 END LOOP; END $$;
GRANT SELECT,INSERT,UPDATE ON md_category,md_product_unit_used,md_product,md_country_sku,md_product_unit,md_product_barcode,md_exchange_rate,cst_method_config,inv_batch,inv_warehouse_sku_guard,inv_stock_summary,inv_batch_balance,inv_stock_txn,inv_reservation,inv_freeze,cst_inbound_cost,cst_cogs,cst_cogs_part TO "${runtimeRole}";
REVOKE UPDATE ON cst_inbound_cost,cst_cogs,cst_cogs_part FROM "${runtimeRole}";

CREATE TABLE inv_transfer (
 id jxc_safe_id PRIMARY KEY DEFAULT nextval('jxc_id_seq'),country_id jxc_safe_id NOT NULL,book_id jxc_safe_id NOT NULL,doc_no varchar(100) NOT NULL,from_warehouse_id jxc_safe_id NOT NULL,to_warehouse_id jxc_safe_id NOT NULL,biz_date date NOT NULL,status varchar(24) NOT NULL DEFAULT 'DRAFT' CHECK(status IN ('DRAFT','PENDING_APPROVAL','APPROVED','IN_TRANSIT','PARTIAL_RECEIVED','RECEIVED','CLOSED')),shipped_at timestamptz,received_at timestamptz,remark varchar(1000) NOT NULL DEFAULT '',version int NOT NULL DEFAULT 1,created_by jxc_safe_id NOT NULL REFERENCES sys_user(id),UNIQUE(country_id,id),UNIQUE(country_id,doc_no),FOREIGN KEY(country_id,book_id) REFERENCES fin_book(country_id,id),FOREIGN KEY(country_id,from_warehouse_id) REFERENCES org_warehouse(country_id,id),FOREIGN KEY(country_id,to_warehouse_id) REFERENCES org_warehouse(country_id,id),CHECK(from_warehouse_id<>to_warehouse_id)
);
CREATE TABLE inv_transfer_line (
 id jxc_safe_id PRIMARY KEY DEFAULT nextval('jxc_id_seq'),country_id jxc_safe_id NOT NULL,transfer_id jxc_safe_id NOT NULL,product_id jxc_safe_id NOT NULL,qty numeric(20,4) NOT NULL CHECK(qty>0),shipped_qty numeric(20,4) NOT NULL DEFAULT 0,received_qty numeric(20,4) NOT NULL DEFAULT 0,batch_id jxc_safe_id,UNIQUE(country_id,id),UNIQUE(country_id,transfer_id,product_id),FOREIGN KEY(country_id,transfer_id) REFERENCES inv_transfer(country_id,id),FOREIGN KEY(country_id,product_id) REFERENCES md_country_sku(country_id,product_id),FOREIGN KEY(country_id,batch_id,product_id) REFERENCES inv_batch(country_id,id,product_id),CHECK(received_qty>=0 AND received_qty<=shipped_qty AND shipped_qty<=qty)
);
CREATE TABLE inv_stocktake (
 id jxc_safe_id PRIMARY KEY DEFAULT nextval('jxc_id_seq'),country_id jxc_safe_id NOT NULL,book_id jxc_safe_id NOT NULL,warehouse_id jxc_safe_id NOT NULL,doc_no varchar(100) NOT NULL,biz_date date NOT NULL,status varchar(24) NOT NULL DEFAULT 'DRAFT' CHECK(status IN ('DRAFT','COUNTING','SUBMITTED','APPROVED','POSTED','CANCELLED')),scope jsonb NOT NULL DEFAULT '{}',snapshot_at timestamptz,posted_at timestamptz,remark varchar(1000) NOT NULL DEFAULT '',version int NOT NULL DEFAULT 1,created_by jxc_safe_id NOT NULL REFERENCES sys_user(id),UNIQUE(country_id,id),UNIQUE(country_id,doc_no),FOREIGN KEY(country_id,book_id) REFERENCES fin_book(country_id,id),FOREIGN KEY(country_id,warehouse_id) REFERENCES org_warehouse(country_id,id)
);
CREATE TABLE inv_stocktake_line (
 id jxc_safe_id PRIMARY KEY DEFAULT nextval('jxc_id_seq'),country_id jxc_safe_id NOT NULL,stocktake_id jxc_safe_id NOT NULL,product_id jxc_safe_id NOT NULL,batch_id jxc_safe_id,book_qty numeric(20,4) NOT NULL DEFAULT 0 CHECK(book_qty>=0),counted_qty numeric(20,4) CHECK(counted_qty>=0),unit_cost numeric(20,4),reason varchar(1000) NOT NULL DEFAULT '',UNIQUE(country_id,id),FOREIGN KEY(country_id,stocktake_id) REFERENCES inv_stocktake(country_id,id),FOREIGN KEY(country_id,product_id) REFERENCES md_country_sku(country_id,product_id),FOREIGN KEY(country_id,batch_id,product_id) REFERENCES inv_batch(country_id,id,product_id)
);
CREATE TABLE inv_stock_limit (
 id jxc_safe_id PRIMARY KEY DEFAULT nextval('jxc_id_seq'),country_id jxc_safe_id NOT NULL,warehouse_id jxc_safe_id NOT NULL,product_id jxc_safe_id NOT NULL,min_qty numeric(20,4),max_qty numeric(20,4),alert_enabled boolean NOT NULL DEFAULT true,owner_id jxc_safe_id REFERENCES sys_user(id),version int NOT NULL DEFAULT 1,UNIQUE(country_id,id),UNIQUE(country_id,warehouse_id,product_id),FOREIGN KEY(country_id,warehouse_id) REFERENCES org_warehouse(country_id,id),FOREIGN KEY(country_id,product_id) REFERENCES md_country_sku(country_id,product_id),CHECK((min_qty IS NULL OR min_qty>=0) AND (max_qty IS NULL OR max_qty>=0) AND (min_qty IS NULL OR max_qty IS NULL OR max_qty>=min_qty))
);
CREATE TABLE inv_stock_alert (
 id jxc_safe_id PRIMARY KEY DEFAULT nextval('jxc_id_seq'),country_id jxc_safe_id NOT NULL,warehouse_id jxc_safe_id NOT NULL,product_id jxc_safe_id NOT NULL,alert_type varchar(24) NOT NULL,status varchar(16) NOT NULL DEFAULT 'OPEN',available_qty numeric(20,4) NOT NULL,threshold numeric(20,4),first_triggered_at timestamptz NOT NULL DEFAULT clock_timestamp(),last_evaluated_at timestamptz NOT NULL DEFAULT clock_timestamp(),closed_at timestamptz,UNIQUE(country_id,id),FOREIGN KEY(country_id,warehouse_id) REFERENCES org_warehouse(country_id,id),FOREIGN KEY(country_id,product_id) REFERENCES md_country_sku(country_id,product_id)
);
CREATE UNIQUE INDEX inv_stock_alert_open ON inv_stock_alert(country_id,warehouse_id,product_id,alert_type) WHERE status='OPEN';
DO $$ DECLARE t text; BEGIN FOREACH t IN ARRAY ARRAY['inv_transfer','inv_transfer_line','inv_stocktake','inv_stocktake_line','inv_stock_limit','inv_stock_alert'] LOOP
 EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY',t);EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY',t);EXECUTE format('CREATE POLICY country_isolation ON %I USING(country_id=jxc_current_country_id()) WITH CHECK(country_id=jxc_current_country_id())',t);
 END LOOP;END $$;
GRANT SELECT,INSERT,UPDATE,DELETE ON inv_transfer,inv_transfer_line,inv_stocktake,inv_stocktake_line,inv_stock_limit,inv_stock_alert TO "${runtimeRole}";
-- Deferred checks allow the unique writer to update all participating rows atomically.
CREATE FUNCTION jxc_inventory_conservation() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE c bigint;w bigint;p bigint;hand numeric;frozen numeric;reserved numeric;batch_hand numeric;batch_frozen numeric;reservation_qty numeric;
BEGIN
 c:=COALESCE(NEW.country_id,OLD.country_id);w:=COALESCE(NEW.warehouse_id,OLD.warehouse_id);p:=COALESCE(NEW.product_id,OLD.product_id);
 SELECT on_hand_qty,frozen_qty,reserved_qty INTO hand,frozen,reserved FROM inv_stock_summary WHERE country_id=c AND warehouse_id=w AND product_id=p;
 SELECT coalesce(sum(on_hand_qty),0),coalesce(sum(frozen_qty),0) INTO batch_hand,batch_frozen FROM inv_batch_balance WHERE country_id=c AND warehouse_id=w AND product_id=p;
 SELECT coalesce(sum(qty-consumed_qty-released_qty),0) INTO reservation_qty FROM inv_reservation WHERE country_id=c AND warehouse_id=w AND product_id=p;
 IF hand IS NOT NULL AND (hand<>batch_hand OR frozen<>batch_frozen OR reserved<>reservation_qty) THEN RAISE EXCEPTION 'INV_CONSERVATION_VIOLATION';END IF;RETURN NULL;
END $$;
CREATE CONSTRAINT TRIGGER inv_summary_conservation AFTER INSERT OR UPDATE OR DELETE ON inv_stock_summary DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION jxc_inventory_conservation();
CREATE CONSTRAINT TRIGGER inv_batch_conservation AFTER INSERT OR UPDATE OR DELETE ON inv_batch_balance DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION jxc_inventory_conservation();
CREATE CONSTRAINT TRIGGER inv_reservation_conservation AFTER INSERT OR UPDATE OR DELETE ON inv_reservation DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION jxc_inventory_conservation();
CREATE UNIQUE INDEX md_rate_one_draft ON md_exchange_rate(country_id,from_ccy,to_ccy,rate_date,scope) WHERE status='DRAFT';
CREATE UNIQUE INDEX md_rate_one_confirmed ON md_exchange_rate(country_id,from_ccy,to_ccy,rate_date,scope) WHERE status='CONFIRMED';
GRANT DELETE ON md_product_barcode TO "${runtimeRole}";
CREATE FUNCTION jxc_inventory_dated_fact_guard() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
 PERFORM jxc_assert_period_open(NEW.country_id,NEW.book_id,NEW.biz_date);RETURN NEW;END $$;
CREATE TRIGGER inv_stock_txn_date BEFORE INSERT ON inv_stock_txn FOR EACH ROW EXECUTE FUNCTION jxc_inventory_dated_fact_guard();
CREATE TRIGGER inv_reservation_date BEFORE INSERT ON inv_reservation FOR EACH ROW EXECUTE FUNCTION jxc_inventory_dated_fact_guard();
CREATE TRIGGER cst_inbound_date BEFORE INSERT ON cst_inbound_cost FOR EACH ROW EXECUTE FUNCTION jxc_inventory_dated_fact_guard();
CREATE TRIGGER cst_cogs_date BEFORE INSERT ON cst_cogs FOR EACH ROW EXECUTE FUNCTION jxc_inventory_dated_fact_guard();
CREATE TRIGGER inv_stock_txn_immutable BEFORE UPDATE OR DELETE ON inv_stock_txn FOR EACH ROW EXECUTE FUNCTION jxc_append_only();
CREATE TRIGGER cst_inbound_immutable BEFORE UPDATE OR DELETE ON cst_inbound_cost FOR EACH ROW EXECUTE FUNCTION jxc_append_only();
CREATE TRIGGER cst_cogs_immutable BEFORE UPDATE OR DELETE ON cst_cogs FOR EACH ROW EXECUTE FUNCTION jxc_append_only();
CREATE TRIGGER cst_cogs_part_immutable BEFORE UPDATE OR DELETE ON cst_cogs_part FOR EACH ROW EXECUTE FUNCTION jxc_append_only();

-- M2 valuation state. Quantity and carrying value move with the inventory command;
-- original inbound/cogs facts remain append-only and are never reconstructed later.
CREATE TABLE cst_valuation_pool (
 country_id jxc_safe_id NOT NULL,book_id jxc_safe_id NOT NULL,warehouse_id jxc_safe_id NOT NULL,product_id jxc_safe_id NOT NULL,
 qty numeric(20,4) NOT NULL DEFAULT 0 CHECK(qty>=0),amount numeric(20,4) DEFAULT 0 CHECK(amount IS NULL OR amount>=0),version bigint NOT NULL DEFAULT 1,
 PRIMARY KEY(country_id,book_id,warehouse_id,product_id),FOREIGN KEY(country_id,book_id) REFERENCES fin_book(country_id,id),FOREIGN KEY(country_id,warehouse_id) REFERENCES org_warehouse(country_id,id),FOREIGN KEY(country_id,product_id) REFERENCES md_country_sku(country_id,product_id),CHECK(qty<>0 OR amount=0)
);
CREATE TABLE cst_batch_value (
 country_id jxc_safe_id NOT NULL,book_id jxc_safe_id NOT NULL,warehouse_id jxc_safe_id NOT NULL,product_id jxc_safe_id NOT NULL,batch_id jxc_safe_id NOT NULL,
 qty numeric(20,4) NOT NULL DEFAULT 0 CHECK(qty>=0),amount numeric(20,4) DEFAULT 0 CHECK(amount IS NULL OR amount>=0),
 PRIMARY KEY(country_id,book_id,warehouse_id,product_id,batch_id),FOREIGN KEY(country_id,book_id,warehouse_id,product_id) REFERENCES cst_valuation_pool(country_id,book_id,warehouse_id,product_id),FOREIGN KEY(country_id,batch_id,product_id) REFERENCES inv_batch(country_id,id,product_id),CHECK(qty<>0 OR amount=0)
);
CREATE TABLE cst_transfer_cost (
 id jxc_safe_id PRIMARY KEY DEFAULT nextval('jxc_id_seq'),country_id jxc_safe_id NOT NULL,book_id jxc_safe_id NOT NULL,warehouse_id jxc_safe_id NOT NULL,product_id jxc_safe_id NOT NULL,source_type varchar(64) NOT NULL,source_line_id jxc_safe_id NOT NULL,qty numeric(20,4) NOT NULL CHECK(qty>0),amount numeric(20,4),method varchar(20) NOT NULL,method_version int NOT NULL,pool_qty numeric(20,4) NOT NULL,pool_amount numeric(20,4),biz_date date NOT NULL,
 UNIQUE(country_id,id),UNIQUE(country_id,source_type,source_line_id),FOREIGN KEY(country_id,book_id) REFERENCES fin_book(country_id,id),FOREIGN KEY(country_id,warehouse_id) REFERENCES org_warehouse(country_id,id),FOREIGN KEY(country_id,product_id) REFERENCES md_country_sku(country_id,product_id)
);
CREATE TABLE cst_transfer_cost_part (
 id jxc_safe_id PRIMARY KEY DEFAULT nextval('jxc_id_seq'),country_id jxc_safe_id NOT NULL,transfer_cost_id jxc_safe_id NOT NULL,batch_id jxc_safe_id NOT NULL,qty numeric(20,4) NOT NULL CHECK(qty>0),amount numeric(20,4),source_amount numeric(20,4),
 UNIQUE(country_id,id),UNIQUE(country_id,transfer_cost_id,batch_id),FOREIGN KEY(country_id,transfer_cost_id) REFERENCES cst_transfer_cost(country_id,id),FOREIGN KEY(country_id,batch_id) REFERENCES inv_batch(country_id,id)
);
CREATE TABLE cst_valuation_movement (
 id jxc_safe_id PRIMARY KEY DEFAULT nextval('jxc_id_seq'),country_id jxc_safe_id NOT NULL,book_id jxc_safe_id NOT NULL,warehouse_id jxc_safe_id NOT NULL,product_id jxc_safe_id NOT NULL,batch_id jxc_safe_id,source_type varchar(64) NOT NULL,source_line_id jxc_safe_id NOT NULL,action varchar(32) NOT NULL,seq int NOT NULL DEFAULT 1,
 qty_change numeric(20,4) NOT NULL,amount_change numeric(20,4),before_qty numeric(20,4) NOT NULL,before_amount numeric(20,4),after_qty numeric(20,4) NOT NULL,after_amount numeric(20,4),cogs_id jxc_safe_id,transfer_cost_id jxc_safe_id,biz_date date NOT NULL,created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 UNIQUE(country_id,id),UNIQUE(country_id,source_type,source_line_id,action,seq),FOREIGN KEY(country_id,book_id) REFERENCES fin_book(country_id,id),FOREIGN KEY(country_id,warehouse_id) REFERENCES org_warehouse(country_id,id),FOREIGN KEY(country_id,product_id) REFERENCES md_country_sku(country_id,product_id),FOREIGN KEY(country_id,batch_id) REFERENCES inv_batch(country_id,id),FOREIGN KEY(country_id,cogs_id) REFERENCES cst_cogs(country_id,id),FOREIGN KEY(country_id,transfer_cost_id) REFERENCES cst_transfer_cost(country_id,id)
);
ALTER TABLE cst_cogs ADD pool_qty numeric(20,4),ADD pool_amount numeric(20,4);
ALTER TABLE cst_cogs_part ADD source_unit_cost numeric(20,4),ADD source_amount numeric(20,4),ADD valued_amount numeric(20,4);
ALTER TABLE cst_inbound_cost ADD original_cogs_id jxc_safe_id,ADD source_original_qty numeric(20,4),ADD source_original_amount numeric(20,4),ADD rounding_adjustment numeric(20,4) NOT NULL DEFAULT 0,ADD FOREIGN KEY(country_id,original_cogs_id) REFERENCES cst_cogs(country_id,id);
DO $$ DECLARE t text; BEGIN FOREACH t IN ARRAY ARRAY['cst_valuation_pool','cst_batch_value','cst_transfer_cost','cst_transfer_cost_part','cst_valuation_movement'] LOOP
 EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY',t);EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY',t);EXECUTE format('CREATE POLICY country_isolation ON %I USING(country_id=jxc_current_country_id()) WITH CHECK(country_id=jxc_current_country_id())',t);
 END LOOP;END $$;
GRANT SELECT,INSERT,UPDATE ON cst_valuation_pool,cst_batch_value TO "${runtimeRole}";
GRANT SELECT,INSERT ON cst_transfer_cost,cst_transfer_cost_part,cst_valuation_movement TO "${runtimeRole}";
CREATE TRIGGER cst_transfer_cost_date BEFORE INSERT ON cst_transfer_cost FOR EACH ROW EXECUTE FUNCTION jxc_inventory_dated_fact_guard();
CREATE TRIGGER cst_value_movement_date BEFORE INSERT ON cst_valuation_movement FOR EACH ROW EXECUTE FUNCTION jxc_inventory_dated_fact_guard();
CREATE TRIGGER cst_transfer_cost_immutable BEFORE UPDATE OR DELETE ON cst_transfer_cost FOR EACH ROW EXECUTE FUNCTION jxc_append_only();
CREATE TRIGGER cst_transfer_part_immutable BEFORE UPDATE OR DELETE ON cst_transfer_cost_part FOR EACH ROW EXECUTE FUNCTION jxc_append_only();
CREATE TRIGGER cst_value_movement_immutable BEFORE UPDATE OR DELETE ON cst_valuation_movement FOR EACH ROW EXECUTE FUNCTION jxc_append_only();
ALTER TABLE cst_valuation_movement ADD CHECK(after_qty=before_qty+qty_change AND after_qty>=0),ADD CHECK(after_qty=0 OR before_amount IS NULL OR amount_change IS NULL OR after_amount=before_amount+amount_change);
CREATE FUNCTION jxc_cost_pool_conservation() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE c bigint;w bigint;p bigint;b bigint;pool record;physical numeric;
BEGIN
 c:=COALESCE(NEW.country_id,OLD.country_id);w:=COALESCE(NEW.warehouse_id,OLD.warehouse_id);p:=COALESCE(NEW.product_id,OLD.product_id);
 FOR pool IN SELECT book_id,qty FROM cst_valuation_pool WHERE country_id=c AND warehouse_id=w AND product_id=p LOOP
  SELECT coalesce(sum(bb.on_hand_qty),0) INTO physical FROM inv_batch_balance bb JOIN inv_batch ib ON ib.country_id=bb.country_id AND ib.id=bb.batch_id WHERE bb.country_id=c AND bb.warehouse_id=w AND bb.product_id=p AND ib.book_id=pool.book_id;
  IF pool.qty<>physical THEN RAISE EXCEPTION 'CST_POOL_QUANTITY_MISMATCH'; END IF;
 END LOOP;RETURN NULL;
END $$;
CREATE CONSTRAINT TRIGGER cst_pool_stock_qty AFTER INSERT OR UPDATE ON cst_valuation_pool DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION jxc_cost_pool_conservation();
CREATE CONSTRAINT TRIGGER inv_batch_cost_pool_qty AFTER INSERT OR UPDATE ON inv_batch_balance DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION jxc_cost_pool_conservation();

-- A transfer can close only after every shipped unit is received or disposed by approved loss.
ALTER TABLE inv_transfer DROP CONSTRAINT inv_transfer_status_check;
ALTER TABLE inv_transfer ADD CHECK(status IN ('DRAFT','PENDING_APPROVAL','APPROVED','IN_TRANSIT','PARTIAL_RECEIVED','RECEIVED','CLOSED','CANCELLED')),ADD close_reason varchar(1000),ADD closed_at timestamptz,ADD difference_id jxc_safe_id;
ALTER TABLE inv_transfer_line ADD loss_qty numeric(20,4) NOT NULL DEFAULT 0 CHECK(loss_qty>=0),ADD CHECK(received_qty+loss_qty<=shipped_qty),ADD UNIQUE(country_id,id,product_id);
CREATE TABLE inv_transfer_difference (
 id jxc_safe_id PRIMARY KEY DEFAULT nextval('jxc_id_seq'),country_id jxc_safe_id NOT NULL,book_id jxc_safe_id NOT NULL,transfer_id jxc_safe_id NOT NULL,from_warehouse_id jxc_safe_id NOT NULL,to_warehouse_id jxc_safe_id NOT NULL,biz_date date NOT NULL,reason varchar(1000) NOT NULL,resolution varchar(16) NOT NULL CHECK(resolution IN ('LOSS','FOUND')),status varchar(24) NOT NULL DEFAULT 'PENDING_APPROVAL' CHECK(status IN ('PENDING_APPROVAL','APPROVED','REJECTED','WITHDRAWN','POSTED','FOUND')),version int NOT NULL DEFAULT 1,created_by jxc_safe_id NOT NULL REFERENCES sys_user(id),created_at timestamptz NOT NULL DEFAULT clock_timestamp(),UNIQUE(country_id,id),FOREIGN KEY(country_id,book_id) REFERENCES fin_book(country_id,id),FOREIGN KEY(country_id,transfer_id) REFERENCES inv_transfer(country_id,id),FOREIGN KEY(country_id,from_warehouse_id) REFERENCES org_warehouse(country_id,id),FOREIGN KEY(country_id,to_warehouse_id) REFERENCES org_warehouse(country_id,id)
);
CREATE TABLE inv_transfer_difference_line (
 id jxc_safe_id PRIMARY KEY DEFAULT nextval('jxc_id_seq'),country_id jxc_safe_id NOT NULL,difference_id jxc_safe_id NOT NULL,transfer_line_id jxc_safe_id NOT NULL,product_id jxc_safe_id NOT NULL,batch_id jxc_safe_id NOT NULL,qty numeric(20,4) NOT NULL CHECK(qty>0),UNIQUE(country_id,id),UNIQUE(country_id,difference_id,transfer_line_id,batch_id),FOREIGN KEY(country_id,difference_id) REFERENCES inv_transfer_difference(country_id,id),FOREIGN KEY(country_id,transfer_line_id,product_id) REFERENCES inv_transfer_line(country_id,id,product_id),FOREIGN KEY(country_id,batch_id,product_id) REFERENCES inv_batch(country_id,id,product_id)
);
ALTER TABLE inv_transfer ADD FOREIGN KEY(country_id,difference_id) REFERENCES inv_transfer_difference(country_id,id);
CREATE TABLE cst_transfer_loss (
 id jxc_safe_id PRIMARY KEY DEFAULT nextval('jxc_id_seq'),country_id jxc_safe_id NOT NULL,transfer_cost_id jxc_safe_id NOT NULL,cogs_id jxc_safe_id NOT NULL,batch_id jxc_safe_id NOT NULL,qty numeric(20,4) NOT NULL CHECK(qty>0),amount numeric(20,4),UNIQUE(country_id,cogs_id,batch_id),FOREIGN KEY(country_id,transfer_cost_id) REFERENCES cst_transfer_cost(country_id,id),FOREIGN KEY(country_id,cogs_id) REFERENCES cst_cogs(country_id,id),FOREIGN KEY(country_id,batch_id) REFERENCES inv_batch(country_id,id)
);
CREATE TABLE inv_transfer_loss (
 id jxc_safe_id PRIMARY KEY DEFAULT nextval('jxc_id_seq'),country_id jxc_safe_id NOT NULL,book_id jxc_safe_id NOT NULL,warehouse_id jxc_safe_id NOT NULL,product_id jxc_safe_id NOT NULL,batch_id jxc_safe_id NOT NULL,transfer_source_type varchar(64) NOT NULL,transfer_line_id jxc_safe_id NOT NULL,source_type varchar(64) NOT NULL,source_id jxc_safe_id NOT NULL,source_line_id jxc_safe_id NOT NULL,qty numeric(20,4) NOT NULL CHECK(qty>0),cogs_id jxc_safe_id NOT NULL,biz_date date NOT NULL,UNIQUE(country_id,source_type,source_line_id,batch_id),FOREIGN KEY(country_id,book_id) REFERENCES fin_book(country_id,id),FOREIGN KEY(country_id,warehouse_id) REFERENCES org_warehouse(country_id,id),FOREIGN KEY(country_id,product_id) REFERENCES md_country_sku(country_id,product_id),FOREIGN KEY(country_id,batch_id,product_id) REFERENCES inv_batch(country_id,id,product_id),FOREIGN KEY(country_id,cogs_id) REFERENCES cst_cogs(country_id,id)
);
DO $$ DECLARE t text; BEGIN FOREACH t IN ARRAY ARRAY['inv_transfer_difference','inv_transfer_difference_line','inv_transfer_loss','cst_transfer_loss'] LOOP
 EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY',t);EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY',t);EXECUTE format('CREATE POLICY country_isolation ON %I USING(country_id=jxc_current_country_id()) WITH CHECK(country_id=jxc_current_country_id())',t);END LOOP;END $$;
GRANT SELECT,INSERT ON inv_transfer_difference,inv_transfer_difference_line,inv_transfer_loss,cst_transfer_loss TO "${runtimeRole}";
GRANT UPDATE(status,version) ON inv_transfer_difference TO "${runtimeRole}";
CREATE TRIGGER inv_transfer_difference_date BEFORE INSERT ON inv_transfer_difference FOR EACH ROW EXECUTE FUNCTION jxc_inventory_dated_fact_guard();
CREATE TRIGGER inv_transfer_loss_date BEFORE INSERT ON inv_transfer_loss FOR EACH ROW EXECUTE FUNCTION jxc_inventory_dated_fact_guard();
CREATE TRIGGER inv_transfer_difference_line_immutable BEFORE UPDATE OR DELETE ON inv_transfer_difference_line FOR EACH ROW EXECUTE FUNCTION jxc_append_only();
CREATE TRIGGER inv_transfer_loss_immutable BEFORE UPDATE OR DELETE ON inv_transfer_loss FOR EACH ROW EXECUTE FUNCTION jxc_append_only();
CREATE TRIGGER cst_transfer_loss_immutable BEFORE UPDATE OR DELETE ON cst_transfer_loss FOR EACH ROW EXECUTE FUNCTION jxc_append_only();
CREATE FUNCTION jxc_transfer_header_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF TG_OP='DELETE' OR (TG_OP='UPDATE' AND (to_jsonb(NEW)-ARRAY['status','version','shipped_at','received_at','closed_at','close_reason','difference_id']) IS DISTINCT FROM (to_jsonb(OLD)-ARRAY['status','version','shipped_at','received_at','closed_at','close_reason','difference_id'])) THEN
  IF OLD.status<>'DRAFT' OR EXISTS(SELECT 1 FROM inv_transfer_line WHERE country_id=OLD.country_id AND transfer_id=OLD.id AND shipped_qty>0) THEN RAISE EXCEPTION 'transfer economic facts frozen';END IF;PERFORM jxc_assert_period_open(OLD.country_id,OLD.book_id,OLD.biz_date);
 END IF;
 IF TG_OP<>'DELETE' THEN
  IF TG_OP='INSERT' OR NEW.biz_date IS DISTINCT FROM OLD.biz_date OR NEW.book_id IS DISTINCT FROM OLD.book_id THEN PERFORM jxc_assert_period_open(NEW.country_id,NEW.book_id,NEW.biz_date);END IF;
  IF NEW.status='CLOSED' AND EXISTS(SELECT 1 FROM inv_transfer_line WHERE country_id=NEW.country_id AND transfer_id=NEW.id AND received_qty+loss_qty<>shipped_qty) THEN RAISE EXCEPTION 'unresolved transfer quantities cannot close';END IF;RETURN NEW;
 END IF;RETURN OLD;
END $$;
CREATE TRIGGER inv_transfer_economic_guard BEFORE INSERT OR UPDATE OR DELETE ON inv_transfer FOR EACH ROW EXECUTE FUNCTION jxc_transfer_header_guard();
CREATE FUNCTION jxc_transfer_line_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE t inv_transfer%ROWTYPE; c bigint; parent bigint;
BEGIN
 IF TG_OP='DELETE' THEN c:=OLD.country_id;parent:=OLD.transfer_id;ELSE c:=NEW.country_id;parent:=NEW.transfer_id;END IF;
 SELECT * INTO t FROM inv_transfer WHERE country_id=c AND id=parent FOR UPDATE;
 IF TG_OP<>'UPDATE' OR (to_jsonb(NEW)-ARRAY['shipped_qty','received_qty','loss_qty']) IS DISTINCT FROM (to_jsonb(OLD)-ARRAY['shipped_qty','received_qty','loss_qty']) THEN
  IF t.status<>'DRAFT' THEN RAISE EXCEPTION 'transfer lines frozen outside draft';END IF;PERFORM jxc_assert_period_open(t.country_id,t.book_id,t.biz_date);
 END IF;
 IF TG_OP='DELETE' THEN RETURN OLD;END IF;RETURN NEW;
END $$;
CREATE TRIGGER inv_transfer_line_economic_guard BEFORE INSERT OR UPDATE OR DELETE ON inv_transfer_line FOR EACH ROW EXECUTE FUNCTION jxc_transfer_line_guard();
