-- M2 sales and receivables; no opening balances, demo users or accounting postings.
CREATE TABLE md_customer_group (
 id jxc_safe_id PRIMARY KEY DEFAULT nextval('jxc_id_seq'),country_id jxc_safe_id NOT NULL REFERENCES sys_country(id),code varchar(64) NOT NULL,name varchar(200) NOT NULL,status varchar(16) NOT NULL DEFAULT 'ENABLED' CHECK(status IN ('ENABLED','DISABLED')),version int NOT NULL DEFAULT 1,
 UNIQUE(country_id,id),UNIQUE(country_id,code)
);
CREATE TABLE md_customer_level (LIKE md_customer_group INCLUDING DEFAULTS INCLUDING CONSTRAINTS);
ALTER TABLE md_customer_level ADD PRIMARY KEY(id),ADD UNIQUE(country_id,id),ADD UNIQUE(country_id,code),ADD FOREIGN KEY(country_id) REFERENCES sys_country(id);
CREATE TABLE md_customer (
 id jxc_safe_id PRIMARY KEY DEFAULT nextval('jxc_id_seq'),country_id jxc_safe_id NOT NULL REFERENCES sys_country(id),code varchar(64) NOT NULL,name varchar(200) NOT NULL,group_id jxc_safe_id,level_id jxc_safe_id,store_id jxc_safe_id,sales_owner_id jxc_safe_id REFERENCES sys_user(id),contact varchar(200) NOT NULL DEFAULT '',phone varchar(100) NOT NULL DEFAULT '',email varchar(250) NOT NULL DEFAULT '',tax_id varchar(100) NOT NULL DEFAULT '',addresses jsonb NOT NULL DEFAULT '[]',remark text NOT NULL DEFAULT '',status varchar(16) NOT NULL DEFAULT 'ENABLED' CHECK(status IN ('ENABLED','DISABLED')),version int NOT NULL DEFAULT 1,created_at timestamptz NOT NULL DEFAULT clock_timestamp(),updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 UNIQUE(country_id,id),UNIQUE(country_id,code),FOREIGN KEY(country_id,group_id) REFERENCES md_customer_group(country_id,id),FOREIGN KEY(country_id,level_id) REFERENCES md_customer_level(country_id,id),FOREIGN KEY(country_id,store_id) REFERENCES org_store(country_id,id)
);
CREATE TABLE md_customer_bank (
 id jxc_safe_id PRIMARY KEY DEFAULT nextval('jxc_id_seq'),country_id jxc_safe_id NOT NULL,customer_id jxc_safe_id NOT NULL,bank_name varchar(200) NOT NULL,account_name varchar(200) NOT NULL,account_no_masked varchar(100) NOT NULL,account_no_encrypted text,bank_address varchar(500) NOT NULL DEFAULT '',swift_code varchar(100) NOT NULL DEFAULT '',currency varchar(3) NOT NULL,is_default boolean NOT NULL DEFAULT false,status varchar(16) NOT NULL DEFAULT 'ENABLED',version int NOT NULL DEFAULT 1,UNIQUE(country_id,id),FOREIGN KEY(country_id,customer_id) REFERENCES md_customer(country_id,id)
);
CREATE TABLE sal_price (
 id jxc_safe_id PRIMARY KEY DEFAULT nextval('jxc_id_seq'),country_id jxc_safe_id NOT NULL,product_id jxc_safe_id NOT NULL,price_type varchar(16) NOT NULL CHECK(price_type IN ('BASE','LEVEL','CUSTOMER')),customer_id jxc_safe_id,level_id jxc_safe_id,unit varchar(32) NOT NULL,tax_mode varchar(16) NOT NULL DEFAULT 'INCL',min_qty numeric(18,4) NOT NULL CHECK(min_qty>0),price numeric(20,4) NOT NULL CHECK(price>0),currency varchar(3) NOT NULL,effective_from date NOT NULL,effective_to date,version_no int NOT NULL DEFAULT 1,status varchar(16) NOT NULL DEFAULT 'ACTIVE',version int NOT NULL DEFAULT 1,created_by jxc_safe_id REFERENCES sys_user(id),created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 UNIQUE(country_id,id),FOREIGN KEY(country_id,product_id) REFERENCES md_country_sku(country_id,product_id),FOREIGN KEY(country_id,customer_id) REFERENCES md_customer(country_id,id),FOREIGN KEY(country_id,level_id) REFERENCES md_customer_level(country_id,id),CHECK((price_type<>'CUSTOMER' OR customer_id IS NOT NULL) AND (price_type<>'LEVEL' OR level_id IS NOT NULL)),CHECK(effective_to IS NULL OR effective_to>=effective_from)
);
CREATE TABLE sal_order (
 id jxc_safe_id PRIMARY KEY DEFAULT nextval('jxc_id_seq'),country_id jxc_safe_id NOT NULL,book_id jxc_safe_id NOT NULL,entity_id jxc_safe_id NOT NULL,store_id jxc_safe_id,customer_id jxc_safe_id NOT NULL,doc_no varchar(100) NOT NULL,order_date date NOT NULL,currency varchar(3) NOT NULL,tax_mode varchar(16) NOT NULL DEFAULT 'INCL',payment_type varchar(16) NOT NULL CHECK(payment_type IN ('CASH','CREDIT')),salesperson_id jxc_safe_id REFERENCES sys_user(id),entered_by jxc_safe_id NOT NULL REFERENCES sys_user(id),sales_source varchar(32) NOT NULL DEFAULT 'SALESPERSON',ship_address jsonb,delivery_date date,total_qty numeric(18,4) NOT NULL DEFAULT 0 CHECK(total_qty>=0),total_amount numeric(20,4) NOT NULL DEFAULT 0 CHECK(total_amount>=0),approval_status varchar(24) NOT NULL DEFAULT 'DRAFT',fulfillment_status varchar(32) NOT NULL DEFAULT 'PENDING_PREPARE',payment_status varchar(24) NOT NULL DEFAULT 'UNPAID',approval_instance_id jxc_safe_id,approved_hash varchar(64),credit_rule_version_id jxc_safe_id,credit_exception_approved boolean NOT NULL DEFAULT false,credit_exception_rule_id jxc_safe_id,credit_evaluation jsonb NOT NULL DEFAULT '{}',doc_version int NOT NULL DEFAULT 1,remark text NOT NULL DEFAULT '',version int NOT NULL DEFAULT 1,created_at timestamptz NOT NULL DEFAULT clock_timestamp(),updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 UNIQUE(country_id,id),UNIQUE(country_id,book_id,id),UNIQUE(country_id,doc_no),FOREIGN KEY(country_id,entity_id,book_id) REFERENCES fin_book(country_id,entity_id,id),FOREIGN KEY(country_id,entity_id,store_id) REFERENCES org_store(country_id,entity_id,id),FOREIGN KEY(country_id,customer_id) REFERENCES md_customer(country_id,id)
);
CREATE TABLE sal_order_line (
 id jxc_safe_id PRIMARY KEY DEFAULT nextval('jxc_id_seq'),country_id jxc_safe_id NOT NULL,book_id jxc_safe_id NOT NULL,order_id jxc_safe_id NOT NULL,product_id jxc_safe_id NOT NULL,line_no int NOT NULL,unit varchar(32) NOT NULL,factor numeric(18,8) NOT NULL CHECK(factor>0),qty numeric(18,4) NOT NULL CHECK(qty>0),base_qty numeric(18,4) NOT NULL CHECK(base_qty>0),price numeric(20,4) NOT NULL CHECK(price>=0),std_price numeric(20,4),price_source varchar(24) NOT NULL,price_ref_id jxc_safe_id,price_version_no int NOT NULL DEFAULT 0,manual_price_flag boolean NOT NULL DEFAULT false,discount_amount numeric(20,4) NOT NULL DEFAULT 0 CHECK(discount_amount>=0),tax_rate numeric(18,8) NOT NULL DEFAULT 0,line_amount numeric(20,4) NOT NULL CHECK(line_amount>=0),cancelled_qty numeric(18,4) NOT NULL DEFAULT 0,outbound_qty numeric(18,4) NOT NULL DEFAULT 0,signed_qty numeric(18,4) NOT NULL DEFAULT 0,returned_qty numeric(18,4) NOT NULL DEFAULT 0,claimed_qty numeric(18,4) NOT NULL DEFAULT 0,version int NOT NULL DEFAULT 1,
 UNIQUE(country_id,id),UNIQUE(country_id,book_id,id),UNIQUE(country_id,order_id,id),UNIQUE(country_id,order_id,line_no),FOREIGN KEY(country_id,book_id,order_id) REFERENCES sal_order(country_id,book_id,id),FOREIGN KEY(country_id,product_id) REFERENCES md_country_sku(country_id,product_id),CHECK(cancelled_qty>=0 AND outbound_qty>=0 AND signed_qty>=0 AND returned_qty>=0 AND claimed_qty>=0 AND cancelled_qty+outbound_qty<=base_qty AND signed_qty<=outbound_qty AND returned_qty+claimed_qty<=outbound_qty),CHECK(discount_amount<=qty*price)
);
CREATE TABLE sal_order_alloc (
 id jxc_safe_id PRIMARY KEY DEFAULT nextval('jxc_id_seq'),country_id jxc_safe_id NOT NULL,book_id jxc_safe_id NOT NULL,order_id jxc_safe_id NOT NULL,order_line_id jxc_safe_id NOT NULL,warehouse_id jxc_safe_id NOT NULL,alloc_qty numeric(18,4) NOT NULL CHECK(alloc_qty>0),outbound_qty numeric(18,4) NOT NULL DEFAULT 0,cancelled_qty numeric(18,4) NOT NULL DEFAULT 0,version int NOT NULL DEFAULT 1,
 UNIQUE(country_id,id),UNIQUE(country_id,book_id,id),UNIQUE(country_id,order_line_id,warehouse_id),FOREIGN KEY(country_id,order_id,order_line_id) REFERENCES sal_order_line(country_id,order_id,id),FOREIGN KEY(country_id,warehouse_id) REFERENCES org_warehouse(country_id,id),CHECK(outbound_qty>=0 AND cancelled_qty>=0 AND outbound_qty+cancelled_qty<=alloc_qty)
);
CREATE TABLE sal_outbound (
 id jxc_safe_id PRIMARY KEY DEFAULT nextval('jxc_id_seq'),country_id jxc_safe_id NOT NULL,book_id jxc_safe_id NOT NULL,order_id jxc_safe_id NOT NULL,warehouse_id jxc_safe_id NOT NULL,doc_no varchar(100) NOT NULL,biz_date date NOT NULL,status varchar(24) NOT NULL DEFAULT 'DRAFT',outbound_at timestamptz,operator_id jxc_safe_id REFERENCES sys_user(id),carrier varchar(200) NOT NULL DEFAULT '',tracking_no varchar(200) NOT NULL DEFAULT '',driver varchar(200) NOT NULL DEFAULT '',receivable_id jxc_safe_id,check_result jsonb,version int NOT NULL DEFAULT 1,created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 UNIQUE(country_id,id),UNIQUE(country_id,book_id,id),UNIQUE(country_id,doc_no),FOREIGN KEY(country_id,book_id,order_id) REFERENCES sal_order(country_id,book_id,id),FOREIGN KEY(country_id,warehouse_id) REFERENCES org_warehouse(country_id,id)
);
CREATE TABLE sal_outbound_line (
 id jxc_safe_id PRIMARY KEY DEFAULT nextval('jxc_id_seq'),country_id jxc_safe_id NOT NULL,book_id jxc_safe_id NOT NULL,outbound_id jxc_safe_id NOT NULL,order_line_id jxc_safe_id NOT NULL,alloc_id jxc_safe_id NOT NULL,product_id jxc_safe_id NOT NULL,qty numeric(18,4) NOT NULL CHECK(qty>0),price numeric(20,4) NOT NULL CHECK(price>=0),amount numeric(20,4) NOT NULL CHECK(amount>=0),batch_id jxc_safe_id,cogs_id jxc_safe_id,receivable_id jxc_safe_id,version int NOT NULL DEFAULT 1,
 UNIQUE(country_id,id),UNIQUE(country_id,book_id,id),UNIQUE(country_id,outbound_id,alloc_id),FOREIGN KEY(country_id,book_id,outbound_id) REFERENCES sal_outbound(country_id,book_id,id),FOREIGN KEY(country_id,book_id,order_line_id) REFERENCES sal_order_line(country_id,book_id,id),FOREIGN KEY(country_id,alloc_id) REFERENCES sal_order_alloc(country_id,id),FOREIGN KEY(country_id,product_id) REFERENCES md_country_sku(country_id,product_id),FOREIGN KEY(country_id,batch_id) REFERENCES inv_batch(country_id,id),FOREIGN KEY(country_id,cogs_id) REFERENCES cst_cogs(country_id,id)
);
CREATE TABLE sal_outbound_batch (
 id jxc_safe_id PRIMARY KEY DEFAULT nextval('jxc_id_seq'),country_id jxc_safe_id NOT NULL,outbound_line_id jxc_safe_id NOT NULL,batch_id jxc_safe_id NOT NULL,qty numeric(18,4) NOT NULL CHECK(qty>0),UNIQUE(country_id,id),UNIQUE(country_id,outbound_line_id,batch_id),FOREIGN KEY(country_id,outbound_line_id) REFERENCES sal_outbound_line(country_id,id),FOREIGN KEY(country_id,batch_id) REFERENCES inv_batch(country_id,id)
);
CREATE TABLE sal_sign (
 id jxc_safe_id PRIMARY KEY DEFAULT nextval('jxc_id_seq'),country_id jxc_safe_id NOT NULL,book_id jxc_safe_id NOT NULL,outbound_id jxc_safe_id NOT NULL,signer_name varchar(200) NOT NULL,signed_at timestamptz NOT NULL,biz_date date NOT NULL,remark text NOT NULL DEFAULT '',UNIQUE(country_id,id),FOREIGN KEY(country_id,book_id,outbound_id) REFERENCES sal_outbound(country_id,book_id,id)
);
CREATE TABLE sal_sign_line (
 id jxc_safe_id PRIMARY KEY DEFAULT nextval('jxc_id_seq'),country_id jxc_safe_id NOT NULL,sign_id jxc_safe_id NOT NULL,outbound_line_id jxc_safe_id NOT NULL,signed_qty numeric(18,4) NOT NULL CHECK(signed_qty>=0),diff_type varchar(24) NOT NULL DEFAULT 'NONE',reason text NOT NULL DEFAULT '',diff_status varchar(24),resolution text NOT NULL DEFAULT '',UNIQUE(country_id,id),UNIQUE(country_id,outbound_line_id),FOREIGN KEY(country_id,sign_id) REFERENCES sal_sign(country_id,id),FOREIGN KEY(country_id,outbound_line_id) REFERENCES sal_outbound_line(country_id,id)
);
CREATE TABLE ar_customer_currency (
 id jxc_safe_id PRIMARY KEY DEFAULT nextval('jxc_id_seq'),country_id jxc_safe_id NOT NULL,customer_id jxc_safe_id NOT NULL,currency varchar(3) NOT NULL,version int NOT NULL DEFAULT 1,UNIQUE(country_id,id),UNIQUE(country_id,customer_id,currency),FOREIGN KEY(country_id,customer_id) REFERENCES md_customer(country_id,id)
);
CREATE TABLE ar_credit_rule (
 id jxc_safe_id PRIMARY KEY DEFAULT nextval('jxc_id_seq'),country_id jxc_safe_id NOT NULL,target_type varchar(16) NOT NULL CHECK(target_type IN ('CUSTOMER','GROUP')),target_id jxc_safe_id NOT NULL,payment_mode varchar(24) NOT NULL CHECK(payment_mode IN ('CASH_ONLY','CREDIT_ALLOWED')),credit_limit numeric(20,4) NOT NULL DEFAULT 0 CHECK(credit_limit>=0),currency varchar(3) NOT NULL,term_days int NOT NULL DEFAULT 0 CHECK(term_days>=0),due_basis varchar(24) NOT NULL DEFAULT 'OUTBOUND_DATE',due_extra_days int NOT NULL DEFAULT 0,overdue_policy varchar(24) NOT NULL DEFAULT 'WARN',grace_days int NOT NULL DEFAULT 0 CHECK(grace_days>=0),allow_exception boolean NOT NULL DEFAULT false,effective_from date NOT NULL,effective_to date,version_no int NOT NULL DEFAULT 1,status varchar(16) NOT NULL DEFAULT 'ACTIVE',version int NOT NULL DEFAULT 1,created_by jxc_safe_id REFERENCES sys_user(id),created_at timestamptz NOT NULL DEFAULT clock_timestamp(),UNIQUE(country_id,id),CHECK(effective_to IS NULL OR effective_to>=effective_from)
);
CREATE TABLE ar_credit_occupation (
 id jxc_safe_id PRIMARY KEY DEFAULT nextval('jxc_id_seq'),country_id jxc_safe_id NOT NULL,book_id jxc_safe_id NOT NULL,customer_id jxc_safe_id NOT NULL,currency varchar(3) NOT NULL,occ_type varchar(24) NOT NULL,ref_type varchar(32) NOT NULL,ref_id jxc_safe_id NOT NULL,amount numeric(20,4) NOT NULL CHECK(amount>=0),released_amount numeric(20,4) NOT NULL DEFAULT 0,status varchar(16) NOT NULL DEFAULT 'OPEN',created_at timestamptz NOT NULL DEFAULT clock_timestamp(),UNIQUE(country_id,id),UNIQUE(country_id,book_id,occ_type,ref_type,ref_id),FOREIGN KEY(country_id,book_id) REFERENCES fin_book(country_id,id),FOREIGN KEY(country_id,customer_id) REFERENCES md_customer(country_id,id),CHECK(released_amount>=0 AND released_amount<=amount)
);
CREATE TABLE ar_receivable (
 id jxc_safe_id PRIMARY KEY DEFAULT nextval('jxc_id_seq'),country_id jxc_safe_id NOT NULL,book_id jxc_safe_id NOT NULL,customer_id jxc_safe_id NOT NULL,order_id jxc_safe_id NOT NULL,source_type varchar(32) NOT NULL,source_id jxc_safe_id NOT NULL,doc_no varchar(100) NOT NULL,currency varchar(3) NOT NULL,amount numeric(20,4) NOT NULL CHECK(amount>=0),written_off_amount numeric(20,4) NOT NULL DEFAULT 0,open_amount numeric(20,4) NOT NULL,biz_date date NOT NULL,due_date date NOT NULL,credit_rule_version_id jxc_safe_id,settle_status varchar(16) NOT NULL DEFAULT 'OPEN',due_status varchar(16) NOT NULL DEFAULT 'NOT_DUE',version int NOT NULL DEFAULT 1,created_at timestamptz NOT NULL DEFAULT clock_timestamp(),UNIQUE(country_id,id),UNIQUE(country_id,book_id,id),UNIQUE(country_id,source_type,source_id),FOREIGN KEY(country_id,book_id,order_id) REFERENCES sal_order(country_id,book_id,id),FOREIGN KEY(country_id,customer_id) REFERENCES md_customer(country_id,id),CHECK(written_off_amount>=0 AND written_off_amount<=amount AND open_amount=amount-written_off_amount)
);
ALTER TABLE sal_outbound ADD FOREIGN KEY(country_id,receivable_id) REFERENCES ar_receivable(country_id,id);
ALTER TABLE sal_outbound_line ADD FOREIGN KEY(country_id,receivable_id) REFERENCES ar_receivable(country_id,id);
CREATE TABLE ar_receipt (
 id jxc_safe_id PRIMARY KEY DEFAULT nextval('jxc_id_seq'),country_id jxc_safe_id NOT NULL,book_id jxc_safe_id NOT NULL,customer_id jxc_safe_id NOT NULL,store_id jxc_safe_id,fund_account_id jxc_safe_id NOT NULL,doc_no varchar(100) NOT NULL,currency varchar(3) NOT NULL,amount numeric(20,4) NOT NULL CHECK(amount>0),written_off_amount numeric(20,4) NOT NULL DEFAULT 0,method varchar(16) NOT NULL CHECK(method IN ('CASH','TRANSFER')),status varchar(32) NOT NULL DEFAULT 'PENDING_CONFIRM',payer_name varchar(200) NOT NULL DEFAULT '',transfer_date date,reference_no varchar(200) NOT NULL DEFAULT '',received_by jxc_safe_id REFERENCES sys_user(id),biz_time timestamptz NOT NULL,biz_date date NOT NULL,arrival_date date,confirmed_by jxc_safe_id REFERENCES sys_user(id),confirmed_at timestamptz,void_reason text NOT NULL DEFAULT '',version int NOT NULL DEFAULT 1,created_at timestamptz NOT NULL DEFAULT clock_timestamp(),UNIQUE(country_id,id),UNIQUE(country_id,book_id,id),UNIQUE(country_id,doc_no),FOREIGN KEY(country_id,book_id) REFERENCES fin_book(country_id,id),FOREIGN KEY(country_id,customer_id) REFERENCES md_customer(country_id,id),FOREIGN KEY(country_id,fund_account_id) REFERENCES md_fund_account(country_id,id),FOREIGN KEY(country_id,store_id) REFERENCES org_store(country_id,id),CHECK(written_off_amount>=0 AND written_off_amount<=amount)
);
CREATE TABLE ar_receipt_order (
 id jxc_safe_id PRIMARY KEY DEFAULT nextval('jxc_id_seq'),country_id jxc_safe_id NOT NULL,book_id jxc_safe_id NOT NULL,receipt_id jxc_safe_id NOT NULL,order_id jxc_safe_id NOT NULL,planned_amount numeric(20,4) NOT NULL CHECK(planned_amount>0),used_amount numeric(20,4) NOT NULL DEFAULT 0,version int NOT NULL DEFAULT 1,UNIQUE(country_id,id),UNIQUE(country_id,receipt_id,order_id),FOREIGN KEY(country_id,book_id,receipt_id) REFERENCES ar_receipt(country_id,book_id,id),FOREIGN KEY(country_id,book_id,order_id) REFERENCES sal_order(country_id,book_id,id),CHECK(used_amount>=0 AND used_amount<=planned_amount)
);
CREATE TABLE ar_credit_note (
 id jxc_safe_id PRIMARY KEY DEFAULT nextval('jxc_id_seq'),country_id jxc_safe_id NOT NULL,book_id jxc_safe_id NOT NULL,customer_id jxc_safe_id NOT NULL,order_id jxc_safe_id,source_type varchar(32) NOT NULL,source_id jxc_safe_id NOT NULL,settlement_version int NOT NULL DEFAULT 1,purpose varchar(16) NOT NULL CHECK(purpose IN ('OFFSET','REFUND')),doc_no varchar(100) NOT NULL,currency varchar(3) NOT NULL,amount numeric(20,4) NOT NULL CHECK(amount>=0),used_amount numeric(20,4) NOT NULL DEFAULT 0,reserved_amount numeric(20,4) NOT NULL DEFAULT 0,refundable_flag boolean NOT NULL,status varchar(16) NOT NULL DEFAULT 'ACTIVE',biz_date date NOT NULL,created_at timestamptz NOT NULL DEFAULT clock_timestamp(),version int NOT NULL DEFAULT 1,UNIQUE(country_id,id),UNIQUE(country_id,book_id,id),UNIQUE(country_id,source_type,source_id,settlement_version,purpose),FOREIGN KEY(country_id,book_id,order_id) REFERENCES sal_order(country_id,book_id,id),FOREIGN KEY(country_id,customer_id) REFERENCES md_customer(country_id,id),CHECK(used_amount>=0 AND reserved_amount>=0 AND used_amount+reserved_amount<=amount)
);
CREATE TABLE ar_refund_reservation (
 id jxc_safe_id PRIMARY KEY DEFAULT nextval('jxc_id_seq'),country_id jxc_safe_id NOT NULL,book_id jxc_safe_id NOT NULL,credit_note_id jxc_safe_id NOT NULL,refund_id jxc_safe_id NOT NULL,amount numeric(20,4) NOT NULL CHECK(amount>0),consumed_amount numeric(20,4) NOT NULL DEFAULT 0,released_amount numeric(20,4) NOT NULL DEFAULT 0,biz_date date NOT NULL,UNIQUE(country_id,id),UNIQUE(country_id,credit_note_id,refund_id),FOREIGN KEY(country_id,book_id,credit_note_id) REFERENCES ar_credit_note(country_id,book_id,id),CHECK(consumed_amount>=0 AND released_amount>=0 AND consumed_amount+released_amount<=amount)
);
CREATE TABLE ar_writeoff (
 id jxc_safe_id PRIMARY KEY DEFAULT nextval('jxc_id_seq'),country_id jxc_safe_id NOT NULL,book_id jxc_safe_id NOT NULL,customer_id jxc_safe_id NOT NULL,doc_no varchar(100) NOT NULL,currency varchar(3) NOT NULL,biz_date date NOT NULL,status varchar(16) NOT NULL DEFAULT 'EFFECTIVE',reversal_of_id jxc_safe_id,reason text NOT NULL DEFAULT '',created_by jxc_safe_id REFERENCES sys_user(id),created_at timestamptz NOT NULL DEFAULT clock_timestamp(),UNIQUE(country_id,id),UNIQUE(country_id,book_id,id),UNIQUE(country_id,reversal_of_id),FOREIGN KEY(country_id,customer_id) REFERENCES md_customer(country_id,id),FOREIGN KEY(country_id,book_id) REFERENCES fin_book(country_id,id),FOREIGN KEY(country_id,reversal_of_id) REFERENCES ar_writeoff(country_id,id)
);
CREATE TABLE ar_writeoff_line (
 id jxc_safe_id PRIMARY KEY DEFAULT nextval('jxc_id_seq'),country_id jxc_safe_id NOT NULL,book_id jxc_safe_id NOT NULL,writeoff_id jxc_safe_id NOT NULL,from_type varchar(16) NOT NULL CHECK(from_type IN ('RECEIPT','CREDIT_NOTE')),from_id jxc_safe_id NOT NULL,receipt_id jxc_safe_id,credit_note_id jxc_safe_id,receivable_id jxc_safe_id NOT NULL,order_id jxc_safe_id,amount numeric(20,4) NOT NULL CHECK(amount<>0),allocated_amount numeric(20,4) NOT NULL DEFAULT 0,UNIQUE(country_id,id),FOREIGN KEY(country_id,book_id,writeoff_id) REFERENCES ar_writeoff(country_id,book_id,id),FOREIGN KEY(country_id,book_id,receivable_id) REFERENCES ar_receivable(country_id,book_id,id),FOREIGN KEY(country_id,book_id,receipt_id) REFERENCES ar_receipt(country_id,book_id,id),FOREIGN KEY(country_id,book_id,credit_note_id) REFERENCES ar_credit_note(country_id,book_id,id),CHECK((from_type='RECEIPT' AND receipt_id=from_id AND credit_note_id IS NULL) OR (from_type='CREDIT_NOTE' AND credit_note_id=from_id AND receipt_id IS NULL))
);
CREATE TABLE ar_return_offset (
 id jxc_safe_id PRIMARY KEY DEFAULT nextval('jxc_id_seq'),country_id jxc_safe_id NOT NULL,book_id jxc_safe_id NOT NULL,return_id jxc_safe_id NOT NULL,settlement_version int NOT NULL,credit_note_id jxc_safe_id NOT NULL,writeoff_id jxc_safe_id NOT NULL,amount numeric(20,4) NOT NULL CHECK(amount>0),UNIQUE(country_id,id),UNIQUE(country_id,credit_note_id,writeoff_id),FOREIGN KEY(country_id,book_id,credit_note_id) REFERENCES ar_credit_note(country_id,book_id,id),FOREIGN KEY(country_id,book_id,writeoff_id) REFERENCES ar_writeoff(country_id,book_id,id)
);
CREATE TABLE ar_statement (
 id jxc_safe_id PRIMARY KEY DEFAULT nextval('jxc_id_seq'),country_id jxc_safe_id NOT NULL,book_id jxc_safe_id NOT NULL,customer_id jxc_safe_id NOT NULL,currency varchar(3) NOT NULL,period_start date NOT NULL,period_end date NOT NULL,opening numeric(20,4) NOT NULL,increase numeric(20,4) NOT NULL,decrease numeric(20,4) NOT NULL,closing numeric(20,4) NOT NULL,detail_snapshot jsonb NOT NULL,generated_by jxc_safe_id NOT NULL REFERENCES sys_user(id),created_at timestamptz NOT NULL DEFAULT clock_timestamp(),UNIQUE(country_id,id),FOREIGN KEY(country_id,book_id) REFERENCES fin_book(country_id,id),FOREIGN KEY(country_id,customer_id) REFERENCES md_customer(country_id,id),CHECK(period_start<=period_end AND opening+increase-decrease=closing)
);
-- Guard dated business facts in the database, including omitted Java checks. Progress
-- projections on historical sources remain writable only through new open-period facts.
CREATE FUNCTION jxc_sales_date_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE d date; old_d date;
BEGIN
 d:=(to_jsonb(NEW)->>TG_ARGV[0])::date;
 IF TG_OP='INSERT' THEN PERFORM jxc_assert_period_open(NEW.country_id,NEW.book_id,d);
 ELSIF (to_jsonb(NEW)-string_to_array(TG_ARGV[1],',')) IS DISTINCT FROM (to_jsonb(OLD)-string_to_array(TG_ARGV[1],',')) THEN
  old_d:=(to_jsonb(OLD)->>TG_ARGV[0])::date;PERFORM jxc_assert_period_open(OLD.country_id,OLD.book_id,old_d);PERFORM jxc_assert_period_open(NEW.country_id,NEW.book_id,d);
  IF TG_ARGV[2]='immutable' THEN RAISE EXCEPTION 'JXC_IMMUTABLE_FACT' USING ERRCODE='P0001'; END IF;
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER sal_order_period BEFORE INSERT OR UPDATE ON sal_order FOR EACH ROW EXECUTE FUNCTION jxc_sales_date_guard('order_date','approval_status,fulfillment_status,payment_status,approval_instance_id,approved_hash,credit_rule_version_id,credit_exception_approved,credit_exception_rule_id,credit_evaluation,version,updated_at','editable');
CREATE TRIGGER sal_outbound_period BEFORE INSERT OR UPDATE ON sal_outbound FOR EACH ROW EXECUTE FUNCTION jxc_sales_date_guard('biz_date','status,outbound_at,operator_id,carrier,tracking_no,driver,receivable_id,check_result,version','editable');
CREATE TRIGGER sal_sign_period BEFORE INSERT OR UPDATE ON sal_sign FOR EACH ROW EXECUTE FUNCTION jxc_sales_date_guard('biz_date','','immutable');
CREATE TRIGGER ar_receivable_period BEFORE INSERT OR UPDATE ON ar_receivable FOR EACH ROW EXECUTE FUNCTION jxc_sales_date_guard('biz_date','written_off_amount,open_amount,settle_status,due_status,version','immutable');
CREATE TRIGGER ar_receipt_period BEFORE INSERT OR UPDATE ON ar_receipt FOR EACH ROW EXECUTE FUNCTION jxc_sales_date_guard('biz_date','written_off_amount,status,confirmed_by,confirmed_at,arrival_date,reference_no,void_reason,version','immutable');
CREATE TRIGGER ar_note_period BEFORE INSERT OR UPDATE ON ar_credit_note FOR EACH ROW EXECUTE FUNCTION jxc_sales_date_guard('biz_date','used_amount,reserved_amount,status,version','immutable');
CREATE TRIGGER ar_writeoff_period BEFORE INSERT OR UPDATE ON ar_writeoff FOR EACH ROW EXECUTE FUNCTION jxc_sales_date_guard('biz_date','status','immutable');
CREATE TRIGGER ar_refund_reservation_period BEFORE INSERT OR UPDATE ON ar_refund_reservation FOR EACH ROW EXECUTE FUNCTION jxc_sales_date_guard('biz_date','consumed_amount,released_amount','immutable');
CREATE FUNCTION jxc_sales_children_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE parent record; parent_id bigint;
BEGIN
 IF TG_OP='DELETE' THEN RAISE EXCEPTION 'JXC_IMMUTABLE_FACT' USING ERRCODE='P0001'; END IF;
 parent_id:=(to_jsonb(NEW)->>TG_ARGV[1])::bigint;
 EXECUTE format('SELECT country_id,book_id,%I AS biz_date FROM %I WHERE country_id=$1 AND id=$2',TG_ARGV[2],TG_ARGV[0]) INTO parent USING NEW.country_id,parent_id;
 IF parent IS NOT NULL THEN PERFORM jxc_assert_period_open(parent.country_id,parent.book_id,parent.biz_date); END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER sal_line_period BEFORE INSERT ON sal_order_line FOR EACH ROW EXECUTE FUNCTION jxc_sales_children_guard('sal_order','order_id','order_date');
CREATE TRIGGER sal_alloc_period BEFORE INSERT ON sal_order_alloc FOR EACH ROW EXECUTE FUNCTION jxc_sales_children_guard('sal_order','order_id','order_date');
CREATE TRIGGER outbound_line_period BEFORE INSERT ON sal_outbound_line FOR EACH ROW EXECUTE FUNCTION jxc_sales_children_guard('sal_outbound','outbound_id','biz_date');
CREATE TRIGGER writeoff_line_period BEFORE INSERT OR UPDATE OR DELETE ON ar_writeoff_line FOR EACH ROW EXECUTE FUNCTION jxc_sales_children_guard('ar_writeoff','writeoff_id','biz_date');
CREATE FUNCTION jxc_sales_allocation_complete() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE row_line record; line_id bigint; c bigint;
BEGIN
 c:=COALESCE(NEW.country_id,OLD.country_id);line_id:=COALESCE(NEW.order_line_id,OLD.order_line_id);
 SELECT id,base_qty INTO row_line FROM sal_order_line WHERE country_id=c AND id=line_id FOR UPDATE;
 IF FOUND AND (SELECT coalesce(sum(alloc_qty),0) FROM sal_order_alloc WHERE country_id=c AND order_line_id=line_id)<>row_line.base_qty THEN RAISE EXCEPTION 'SAL_ALLOCATION_NOT_BALANCED' USING ERRCODE='23514'; END IF;
 RETURN NULL;
END $$;
CREATE CONSTRAINT TRIGGER sal_alloc_sum AFTER INSERT OR UPDATE OR DELETE ON sal_order_alloc DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION jxc_sales_allocation_complete();

DO $$ DECLARE t text; BEGIN FOREACH t IN ARRAY ARRAY['md_customer_group','md_customer_level','md_customer','md_customer_bank','sal_price','sal_order','sal_order_line','sal_order_alloc','sal_outbound','sal_outbound_line','sal_outbound_batch','sal_sign','sal_sign_line','ar_customer_currency','ar_credit_rule','ar_credit_occupation','ar_receivable','ar_receipt','ar_receipt_order','ar_credit_note','ar_refund_reservation','ar_writeoff','ar_writeoff_line','ar_return_offset','ar_statement'] LOOP
 EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY',t);EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY',t);
 EXECUTE format('CREATE POLICY country_isolation ON %I USING(country_id=jxc_current_country_id()) WITH CHECK(country_id=jxc_current_country_id())',t);
 END LOOP;END $$;
GRANT SELECT,INSERT,UPDATE ON md_customer_group,md_customer_level,md_customer,md_customer_bank,sal_price,sal_order,sal_order_line,sal_order_alloc,sal_outbound,sal_outbound_line,sal_outbound_batch,sal_sign,sal_sign_line,ar_customer_currency,ar_credit_rule,ar_credit_occupation,ar_receivable,ar_receipt,ar_receipt_order,ar_credit_note,ar_refund_reservation,ar_writeoff,ar_writeoff_line,ar_return_offset,ar_statement TO "${runtimeRole}";
GRANT DELETE ON sal_order_line,sal_order_alloc TO "${runtimeRole}";

ALTER TABLE ar_credit_note ADD FOREIGN KEY(country_id,book_id) REFERENCES fin_book(country_id,id);
CREATE FUNCTION jxc_ar_fact_immutable() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'JXC_IMMUTABLE_FACT' USING ERRCODE='P0001'; END $$;
CREATE TRIGGER ar_offset_immutable BEFORE UPDATE OR DELETE ON ar_return_offset FOR EACH ROW EXECUTE FUNCTION jxc_ar_fact_immutable();
CREATE TRIGGER ar_writeoff_line_immutable BEFORE UPDATE OR DELETE ON ar_writeoff_line FOR EACH ROW EXECUTE FUNCTION jxc_ar_fact_immutable();

-- Source ownership is a database invariant, including writes that omit Java checks.
ALTER TABLE sal_order_alloc ADD CONSTRAINT sal_alloc_line_book_fk FOREIGN KEY(country_id,book_id,order_line_id) REFERENCES sal_order_line(country_id,book_id,id);
CREATE FUNCTION jxc_sales_order_child_economics() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE parent sal_order%ROWTYPE; economic_change boolean; progress_keys text[];
BEGIN
 SELECT * INTO parent FROM sal_order WHERE country_id=COALESCE(NEW.country_id,OLD.country_id) AND id=COALESCE(NEW.order_id,OLD.order_id) FOR SHARE;
 IF NOT FOUND THEN RAISE EXCEPTION 'SAL_ORDER_SOURCE_MISSING' USING ERRCODE='23503'; END IF;
 IF TG_TABLE_NAME='sal_order_line' THEN progress_keys:=ARRAY['outbound_qty','cancelled_qty','signed_qty','returned_qty','claimed_qty','version'];
 ELSE progress_keys:=ARRAY['outbound_qty','cancelled_qty','version']; END IF;
 IF TG_OP='UPDATE' AND ROW(NEW.id,NEW.country_id,NEW.book_id,NEW.order_id) IS DISTINCT FROM ROW(OLD.id,OLD.country_id,OLD.book_id,OLD.order_id) THEN RAISE EXCEPTION 'JXC_IMMUTABLE_FACT' USING ERRCODE='P0001'; END IF;
 IF TG_TABLE_NAME='sal_order_alloc' AND TG_OP='UPDATE' AND ROW(to_jsonb(NEW)->>'order_line_id',to_jsonb(NEW)->>'warehouse_id') IS DISTINCT FROM ROW(to_jsonb(OLD)->>'order_line_id',to_jsonb(OLD)->>'warehouse_id') THEN RAISE EXCEPTION 'JXC_IMMUTABLE_FACT' USING ERRCODE='P0001'; END IF;
 economic_change:=TG_OP IN ('INSERT','DELETE') OR (to_jsonb(NEW)-progress_keys) IS DISTINCT FROM (to_jsonb(OLD)-progress_keys);
 IF economic_change THEN
  IF parent.approval_status<>'DRAFT' THEN RAISE EXCEPTION 'SAL_ORDER_NOT_DRAFT' USING ERRCODE='P0001'; END IF;
  PERFORM jxc_assert_period_open(parent.country_id,parent.book_id,parent.order_date);
  IF TG_OP='DELETE' AND ((to_jsonb(OLD)->>'outbound_qty')::numeric>0 OR (to_jsonb(OLD)->>'cancelled_qty')::numeric>0) THEN RAISE EXCEPTION 'JXC_IMMUTABLE_FACT' USING ERRCODE='P0001'; END IF;
  IF TG_TABLE_NAME='sal_order_line' AND TG_OP='UPDATE' AND OLD.outbound_qty>0 AND
   (to_jsonb(NEW)-ARRAY['qty','base_qty','line_amount','line_no','outbound_qty','cancelled_qty','signed_qty','returned_qty','claimed_qty','version']) IS DISTINCT FROM
   (to_jsonb(OLD)-ARRAY['qty','base_qty','line_amount','line_no','outbound_qty','cancelled_qty','signed_qty','returned_qty','claimed_qty','version']) THEN RAISE EXCEPTION 'JXC_IMMUTABLE_FACT' USING ERRCODE='P0001'; END IF;
 END IF;
 IF TG_OP<>'DELETE' AND NEW.book_id<>parent.book_id THEN RAISE EXCEPTION 'SAL_ORDER_BOOK_MISMATCH' USING ERRCODE='23503'; END IF;
 IF TG_TABLE_NAME='sal_order_alloc' AND TG_OP<>'DELETE' AND NOT EXISTS(SELECT 1 FROM org_warehouse w WHERE w.country_id=NEW.country_id AND w.id=(to_jsonb(NEW)->>'warehouse_id')::bigint AND w.entity_id=parent.entity_id) THEN RAISE EXCEPTION 'SAL_ALLOC_WAREHOUSE_MISMATCH' USING ERRCODE='23503'; END IF;
 IF TG_OP='DELETE' THEN RETURN OLD;ELSE RETURN NEW;END IF;
END $$;
CREATE TRIGGER sal_line_economics BEFORE INSERT OR UPDATE OR DELETE ON sal_order_line FOR EACH ROW EXECUTE FUNCTION jxc_sales_order_child_economics();
CREATE TRIGGER sal_alloc_economics BEFORE INSERT OR UPDATE OR DELETE ON sal_order_alloc FOR EACH ROW EXECUTE FUNCTION jxc_sales_order_child_economics();

CREATE FUNCTION jxc_sales_outbound_source() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE head sal_outbound%ROWTYPE;
BEGIN
 SELECT * INTO head FROM sal_outbound WHERE country_id=COALESCE(NEW.country_id,OLD.country_id) AND id=COALESCE(NEW.outbound_id,OLD.outbound_id) FOR SHARE;
 IF NOT FOUND THEN RAISE EXCEPTION 'SAL_OUTBOUND_SOURCE_MISMATCH' USING ERRCODE='23503'; END IF;
 IF TG_OP='DELETE' THEN RAISE EXCEPTION 'JXC_IMMUTABLE_FACT' USING ERRCODE='P0001'; END IF;
 IF NOT EXISTS(SELECT 1 FROM sal_order_alloc a JOIN sal_order_line l ON l.country_id=a.country_id AND l.id=a.order_line_id
  WHERE a.country_id=NEW.country_id AND a.id=NEW.alloc_id AND a.book_id=NEW.book_id AND a.order_id=head.order_id AND a.warehouse_id=head.warehouse_id
   AND l.id=NEW.order_line_id AND l.book_id=NEW.book_id AND l.order_id=head.order_id AND l.product_id=NEW.product_id AND head.book_id=NEW.book_id)
 THEN RAISE EXCEPTION 'SAL_OUTBOUND_SOURCE_MISMATCH' USING ERRCODE='23503'; END IF;
 IF NEW.batch_id IS NOT NULL AND NOT EXISTS(SELECT 1 FROM inv_batch b JOIN inv_batch_balance bb ON bb.country_id=b.country_id AND bb.batch_id=b.id AND bb.product_id=b.product_id
  WHERE b.country_id=NEW.country_id AND b.id=NEW.batch_id AND b.book_id=NEW.book_id AND b.product_id=NEW.product_id AND bb.warehouse_id=head.warehouse_id)
 THEN RAISE EXCEPTION 'SAL_BATCH_SOURCE_MISMATCH' USING ERRCODE='23503'; END IF;
 IF NEW.cogs_id IS NOT NULL AND NOT EXISTS(SELECT 1 FROM cst_cogs c WHERE c.country_id=NEW.country_id AND c.id=NEW.cogs_id AND c.book_id=NEW.book_id AND c.product_id=NEW.product_id AND c.warehouse_id=head.warehouse_id AND c.source_type='SAL_OUTBOUND' AND c.source_line_id=NEW.id AND c.qty=NEW.qty)
 THEN RAISE EXCEPTION 'SAL_COGS_SOURCE_MISMATCH' USING ERRCODE='23503'; END IF;
 IF TG_OP='UPDATE' AND head.status<>'DRAFT' AND (to_jsonb(NEW)-ARRAY['receivable_id','version']) IS DISTINCT FROM (to_jsonb(OLD)-ARRAY['receivable_id','version']) THEN RAISE EXCEPTION 'JXC_IMMUTABLE_FACT' USING ERRCODE='P0001'; END IF;
 IF TG_OP='INSERT' OR (to_jsonb(NEW)-ARRAY['receivable_id','version']) IS DISTINCT FROM (to_jsonb(OLD)-ARRAY['receivable_id','version']) THEN PERFORM jxc_assert_period_open(head.country_id,head.book_id,head.biz_date); END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER sal_outbound_source_guard BEFORE INSERT OR UPDATE OR DELETE ON sal_outbound_line FOR EACH ROW EXECUTE FUNCTION jxc_sales_outbound_source();
CREATE FUNCTION jxc_sales_outbound_batch_source() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF TG_OP<>'INSERT' THEN RAISE EXCEPTION 'JXC_IMMUTABLE_FACT' USING ERRCODE='P0001'; END IF;
 IF NOT EXISTS(SELECT 1 FROM sal_outbound_line l JOIN sal_outbound h ON h.country_id=l.country_id AND h.id=l.outbound_id JOIN inv_batch b ON b.country_id=l.country_id AND b.id=NEW.batch_id JOIN inv_batch_balance bb ON bb.country_id=b.country_id AND bb.batch_id=b.id AND bb.product_id=b.product_id
  WHERE l.country_id=NEW.country_id AND l.id=NEW.outbound_line_id AND b.book_id=l.book_id AND b.product_id=l.product_id AND bb.warehouse_id=h.warehouse_id)
 THEN RAISE EXCEPTION 'SAL_BATCH_SOURCE_MISMATCH' USING ERRCODE='23503'; END IF;RETURN NEW;
END $$;
CREATE TRIGGER sal_outbound_batch_source_guard BEFORE INSERT OR UPDATE OR DELETE ON sal_outbound_batch FOR EACH ROW EXECUTE FUNCTION jxc_sales_outbound_batch_source();
CREATE FUNCTION jxc_sales_sign_line_source() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE head sal_sign%ROWTYPE; out_qty numeric;
BEGIN
 IF TG_OP='DELETE' OR TG_OP='UPDATE' AND (to_jsonb(NEW)-ARRAY['diff_status','resolution']) IS DISTINCT FROM (to_jsonb(OLD)-ARRAY['diff_status','resolution']) THEN RAISE EXCEPTION 'JXC_IMMUTABLE_FACT' USING ERRCODE='P0001'; END IF;
 IF TG_OP='INSERT' THEN
  SELECT * INTO head FROM sal_sign WHERE country_id=NEW.country_id AND id=NEW.sign_id;
  SELECT l.qty INTO out_qty FROM sal_outbound_line l WHERE l.country_id=NEW.country_id AND l.id=NEW.outbound_line_id AND l.book_id=head.book_id AND l.outbound_id=head.outbound_id;
  IF NOT FOUND OR NEW.signed_qty>out_qty THEN RAISE EXCEPTION 'SAL_SIGN_SOURCE_MISMATCH' USING ERRCODE='23503'; END IF;
  PERFORM jxc_assert_period_open(head.country_id,head.book_id,head.biz_date);
 END IF;RETURN NEW;
END $$;
CREATE TRIGGER sal_sign_line_source_guard BEFORE INSERT OR UPDATE OR DELETE ON sal_sign_line FOR EACH ROW EXECUTE FUNCTION jxc_sales_sign_line_source();

-- Reuse the allocation invariant for changes originating on the line itself.
CREATE OR REPLACE FUNCTION jxc_sales_allocation_complete() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE row_line record; line_id bigint; c bigint;
BEGIN
 c:=COALESCE(NEW.country_id,OLD.country_id);
 IF TG_TABLE_NAME='sal_order_line' THEN line_id:=COALESCE(NEW.id,OLD.id);ELSE line_id:=COALESCE(NEW.order_line_id,OLD.order_line_id);END IF;
 SELECT id,base_qty INTO row_line FROM sal_order_line WHERE country_id=c AND id=line_id FOR UPDATE;
 IF FOUND AND (SELECT coalesce(sum(alloc_qty),0) FROM sal_order_alloc WHERE country_id=c AND order_line_id=line_id)<>row_line.base_qty THEN RAISE EXCEPTION 'SAL_ALLOCATION_NOT_BALANCED' USING ERRCODE='23514'; END IF;
 RETURN NULL;
END $$;
CREATE CONSTRAINT TRIGGER sal_line_alloc_sum AFTER INSERT OR UPDATE ON sal_order_line DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION jxc_sales_allocation_complete();
REVOKE UPDATE ON ar_writeoff_line,ar_return_offset FROM "${runtimeRole}";
REVOKE UPDATE ON ar_receivable,ar_receipt,ar_credit_note,ar_writeoff,ar_refund_reservation,ar_receipt_order FROM "${runtimeRole}";
GRANT UPDATE(written_off_amount,open_amount,settle_status,due_status,version) ON ar_receivable TO "${runtimeRole}";
GRANT UPDATE(written_off_amount,status,confirmed_by,confirmed_at,arrival_date,reference_no,void_reason,version) ON ar_receipt TO "${runtimeRole}";
GRANT UPDATE(used_amount,reserved_amount,status,version) ON ar_credit_note TO "${runtimeRole}";
GRANT UPDATE(status) ON ar_writeoff TO "${runtimeRole}";
GRANT UPDATE(consumed_amount,released_amount) ON ar_refund_reservation TO "${runtimeRole}";
GRANT UPDATE(used_amount,version) ON ar_receipt_order TO "${runtimeRole}";
CREATE UNIQUE INDEX sal_price_business_version ON sal_price(country_id,price_type,coalesce(customer_id,0),coalesce(level_id,0),product_id,unit,tax_mode,min_qty,effective_from,version_no);
CREATE FUNCTION jxc_sales_outbound_header_source() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
 IF NOT EXISTS(SELECT 1 FROM sal_order o JOIN org_warehouse w ON w.country_id=o.country_id AND w.entity_id=o.entity_id WHERE o.country_id=NEW.country_id AND o.id=NEW.order_id AND o.book_id=NEW.book_id AND w.id=NEW.warehouse_id) THEN RAISE EXCEPTION 'SAL_OUTBOUND_SOURCE_MISMATCH' USING ERRCODE='23503'; END IF;
 IF TG_OP='UPDATE' AND ROW(NEW.id,NEW.country_id,NEW.book_id,NEW.order_id,NEW.warehouse_id) IS DISTINCT FROM ROW(OLD.id,OLD.country_id,OLD.book_id,OLD.order_id,OLD.warehouse_id) AND EXISTS(SELECT 1 FROM sal_outbound_line WHERE country_id=OLD.country_id AND outbound_id=OLD.id) THEN RAISE EXCEPTION 'JXC_IMMUTABLE_FACT' USING ERRCODE='P0001'; END IF;
 RETURN NEW;END $$;
CREATE TRIGGER sal_outbound_header_source_guard BEFORE INSERT OR UPDATE ON sal_outbound FOR EACH ROW EXECUTE FUNCTION jxc_sales_outbound_header_source();
ALTER TABLE sal_order_line ADD CONSTRAINT sal_line_base_conversion CHECK(base_qty=qty*factor),ADD CONSTRAINT sal_line_amount_calculation CHECK(line_amount=round(qty*price-discount_amount,4));
REVOKE UPDATE ON sal_sign_line FROM "${runtimeRole}";
GRANT UPDATE(diff_status,resolution) ON sal_sign_line TO "${runtimeRole}";
