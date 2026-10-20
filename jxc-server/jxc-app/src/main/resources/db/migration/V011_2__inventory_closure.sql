ALTER TABLE sal_order ADD COLUMN approved_at timestamptz;
UPDATE sal_order o SET approved_at=(SELECT max(e.occurred_at) FROM sys_biz_event e WHERE e.country_id=o.country_id AND e.source_type='SALES_ORDER' AND e.source_id=o.id AND e.event_type='SAL_ORDER_APPROVED') WHERE approval_status='APPROVED';
CREATE TABLE inv_classify_rule (
 id jxc_safe_id PRIMARY KEY DEFAULT nextval('jxc_id_seq'),country_id jxc_safe_id NOT NULL REFERENCES sys_country(id),name varchar(200) NOT NULL,
 dim_type varchar(20) NOT NULL CHECK(dim_type IN ('COUNTRY','WAREHOUSE','STORE')),period_type varchar(24) NOT NULL CHECK(period_type IN ('ROLLING_DAYS','CALENDAR_MONTH','CALENDAR_WEEK')),period_days integer NOT NULL CHECK(period_days BETWEEN 1 AND 3650),
 order_metric varchar(20) NOT NULL CHECK(order_metric IN ('QTY','ORDER_COUNT')),stock_metric varchar(20) NOT NULL CHECK(stock_metric IN ('AVAILABLE','ON_HAND')),version_no integer NOT NULL DEFAULT 1,status varchar(20) NOT NULL DEFAULT 'ACTIVE',
 source_template_item_id jxc_safe_id,effective_from date NOT NULL DEFAULT current_date,conditions jsonb NOT NULL CHECK(jsonb_typeof(conditions)='array'),created_by jxc_safe_id NOT NULL REFERENCES sys_user(id),created_at timestamptz NOT NULL DEFAULT clock_timestamp(),UNIQUE(country_id,id)
);
CREATE TABLE inv_classify_result (
 id jxc_safe_id PRIMARY KEY DEFAULT nextval('jxc_id_seq'),country_id jxc_safe_id NOT NULL,rule_id jxc_safe_id NOT NULL,rule_version_no integer NOT NULL,dim_type varchar(20) NOT NULL,dim_id jxc_safe_id NOT NULL,warehouse_id jxc_safe_id,store_id jxc_safe_id,product_id jxc_safe_id NOT NULL,
 period_start date NOT NULL,period_end date NOT NULL,label varchar(64) NOT NULL,basis jsonb NOT NULL CHECK(jsonb_typeof(basis)='object'),orders jsonb NOT NULL CHECK(jsonb_typeof(orders)='array'),computed_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 UNIQUE(country_id,id),UNIQUE(country_id,rule_id,rule_version_no,dim_type,dim_id,product_id),FOREIGN KEY(country_id,rule_id) REFERENCES inv_classify_rule(country_id,id),FOREIGN KEY(country_id,warehouse_id) REFERENCES org_warehouse(country_id,id),FOREIGN KEY(country_id,store_id) REFERENCES org_store(country_id,id),FOREIGN KEY(country_id,product_id) REFERENCES md_country_sku(country_id,product_id)
);
CREATE TABLE inv_classify_result_log (
 id jxc_safe_id PRIMARY KEY DEFAULT nextval('jxc_id_seq'),country_id jxc_safe_id NOT NULL,result_id jxc_safe_id NOT NULL,old_label varchar(64),new_label varchar(64) NOT NULL,trigger varchar(20) NOT NULL,trigger_ref varchar(100),basis jsonb NOT NULL,changed_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 FOREIGN KEY(country_id,result_id) REFERENCES inv_classify_result(country_id,id)
);
CREATE TABLE inv_replenish (
 id jxc_safe_id PRIMARY KEY DEFAULT nextval('jxc_id_seq'),country_id jxc_safe_id NOT NULL,warehouse_id jxc_safe_id NOT NULL,product_id jxc_safe_id NOT NULL,alert_id jxc_safe_id,doc_no varchar(100) NOT NULL,req_qty numeric(20,4) NOT NULL CHECK(req_qty>0),need_date date,reason varchar(1000) NOT NULL DEFAULT '',suggested_source varchar(20) NOT NULL DEFAULT 'TRANSFER',decided_source varchar(20),status varchar(20) NOT NULL DEFAULT 'PENDING' CHECK(status IN ('PENDING','APPROVED','LINKED','CLOSED')),decided_by jxc_safe_id REFERENCES sys_user(id),decision_note varchar(1000) NOT NULL DEFAULT '',created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 UNIQUE(country_id,id),UNIQUE(country_id,doc_no),FOREIGN KEY(country_id,warehouse_id) REFERENCES org_warehouse(country_id,id),FOREIGN KEY(country_id,product_id) REFERENCES md_country_sku(country_id,product_id),FOREIGN KEY(country_id,alert_id) REFERENCES inv_stock_alert(country_id,id)
);
CREATE UNIQUE INDEX inv_replenish_open_alert ON inv_replenish(country_id,warehouse_id,product_id,alert_id) WHERE status<>'CLOSED';
CREATE TABLE inv_replenish_link (
 id jxc_safe_id PRIMARY KEY DEFAULT nextval('jxc_id_seq'),country_id jxc_safe_id NOT NULL,replenish_id jxc_safe_id NOT NULL,exec_doc_type varchar(20) NOT NULL CHECK(exec_doc_type IN ('INV_TRANSFER','PUR_ORDER')),exec_doc_id jxc_safe_id NOT NULL,exec_line_id jxc_safe_id NOT NULL,qty numeric(20,4) NOT NULL CHECK(qty>0),
 UNIQUE(country_id,replenish_id,exec_doc_type,exec_line_id),FOREIGN KEY(country_id,replenish_id) REFERENCES inv_replenish(country_id,id)
);
CREATE TRIGGER inv_classify_log_immutable BEFORE UPDATE OR DELETE ON inv_classify_result_log FOR EACH ROW EXECUTE FUNCTION jxc_ar_fact_immutable();
DO $$ DECLARE t text; BEGIN
 FOREACH t IN ARRAY ARRAY['inv_classify_rule','inv_classify_result','inv_classify_result_log','inv_replenish','inv_replenish_link'] LOOP
  EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY',t);
  EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY',t);
  EXECUTE format('CREATE POLICY country_isolation ON %I USING(country_id=jxc_current_country_id()) WITH CHECK(country_id=jxc_current_country_id())',t);
  EXECUTE format('CREATE TRIGGER jxc_write_gate BEFORE INSERT OR UPDATE OR DELETE OR TRUNCATE ON %I FOR EACH STATEMENT EXECUTE FUNCTION jxc_assert_writes_open()',t);
 END LOOP;
END $$;
GRANT SELECT,INSERT,UPDATE ON inv_classify_rule,inv_classify_result,inv_replenish TO "${runtimeRole}";
GRANT SELECT,INSERT ON inv_classify_result_log,inv_replenish_link TO "${runtimeRole}";

-- Preserve native full allocation conservation for both line and allocation changes.
CREATE OR REPLACE FUNCTION jxc_sales_allocation_complete() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE row_line record;line_id bigint;c bigint;
BEGIN
 c:=coalesce(NEW.country_id,OLD.country_id);IF TG_TABLE_NAME='sal_order_line' THEN line_id:=coalesce(NEW.id,OLD.id);ELSE line_id:=coalesce(NEW.order_line_id,OLD.order_line_id);END IF;
 SELECT id,base_qty INTO row_line FROM sal_order_line WHERE country_id=c AND id=line_id FOR UPDATE;
 IF FOUND AND (SELECT coalesce(sum(alloc_qty),0) FROM sal_order_alloc WHERE country_id=c AND order_line_id=line_id)<>row_line.base_qty THEN RAISE EXCEPTION 'SAL_ALLOCATION_NOT_BALANCED' USING ERRCODE='23514'; END IF;
 RETURN NULL;
END $$;
