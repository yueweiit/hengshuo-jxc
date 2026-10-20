-- M3 appends completion/confirmation and valuation facts; M2 source facts stay immutable.
ALTER TABLE cst_inbound_cost ADD UNIQUE(country_id,book_id,id);
ALTER TABLE inv_batch ADD UNIQUE(country_id,book_id,id);
CREATE TABLE cst_cost_confirmation (
 country_id jxc_safe_id NOT NULL,book_id jxc_safe_id NOT NULL,cost_id jxc_safe_id NOT NULL,
 base_purchase_amount numeric(20,4) NOT NULL CHECK(base_purchase_amount>=0),unit_cost numeric(38,12) NOT NULL CHECK(unit_cost>=0),
 rate_id jxc_safe_id,rate numeric(18,8),rate_date date,rate_version int,
 biz_date date NOT NULL,confirmed_by jxc_safe_id NOT NULL REFERENCES sys_user(id),confirmed_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 PRIMARY KEY(country_id,cost_id),FOREIGN KEY(country_id,book_id,cost_id) REFERENCES cst_inbound_cost(country_id,book_id,id),FOREIGN KEY(country_id,rate_id) REFERENCES md_exchange_rate(country_id,id)
);
CREATE TABLE cst_cogs_completion (
 country_id jxc_safe_id NOT NULL,book_id jxc_safe_id NOT NULL,cogs_id jxc_safe_id NOT NULL,amount numeric(20,4) NOT NULL,unit_cost numeric(38,12) NOT NULL,
 biz_date date NOT NULL,completed_by jxc_safe_id NOT NULL REFERENCES sys_user(id),created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 PRIMARY KEY(country_id,cogs_id),FOREIGN KEY(country_id,cogs_id) REFERENCES cst_cogs(country_id,id),FOREIGN KEY(country_id,book_id) REFERENCES fin_book(country_id,id)
);
CREATE TABLE cst_fee_allocation (
 id jxc_safe_id PRIMARY KEY DEFAULT nextval('jxc_id_seq'),country_id jxc_safe_id NOT NULL,book_id jxc_safe_id NOT NULL,fee_id jxc_safe_id NOT NULL,
 basis varchar(16) NOT NULL CHECK(basis IN ('QTY','WEIGHT','VOLUME','VALUE','MANUAL')),fee_currency varchar(3) NOT NULL,fee_amount numeric(20,4) NOT NULL CHECK(fee_amount>0),
 base_currency varchar(3) NOT NULL,base_amount numeric(20,4) NOT NULL CHECK(base_amount>0),rate numeric(18,8),source_version int NOT NULL,
 status varchar(16) NOT NULL DEFAULT 'DRAFT' CHECK(status IN ('DRAFT','PENDING_APPROVAL','APPROVED','CONFIRMED')),biz_date date NOT NULL,
 replaces_allocation_id jxc_safe_id,confirmed_by jxc_safe_id REFERENCES sys_user(id),confirmed_at timestamptz,created_by jxc_safe_id NOT NULL REFERENCES sys_user(id),created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 UNIQUE(country_id,id),UNIQUE(country_id,book_id,id),FOREIGN KEY(country_id,book_id) REFERENCES fin_book(country_id,id),FOREIGN KEY(country_id,fee_id) REFERENCES lgs_fee(country_id,id),FOREIGN KEY(country_id,replaces_allocation_id) REFERENCES cst_fee_allocation(country_id,id)
);
CREATE TABLE cst_fee_allocation_line (
 id jxc_safe_id PRIMARY KEY DEFAULT nextval('jxc_id_seq'),country_id jxc_safe_id NOT NULL,book_id jxc_safe_id NOT NULL,allocation_id jxc_safe_id NOT NULL,batch_id jxc_safe_id NOT NULL,
 basis_value numeric(38,12) NOT NULL CHECK(basis_value>=0),qty numeric(20,4) NOT NULL CHECK(qty>0),amount numeric(20,4) NOT NULL CHECK(amount>=0),rounding_adj numeric(20,4) NOT NULL DEFAULT 0,
 UNIQUE(country_id,id),UNIQUE(country_id,allocation_id,batch_id),FOREIGN KEY(country_id,book_id,allocation_id) REFERENCES cst_fee_allocation(country_id,book_id,id),FOREIGN KEY(country_id,book_id,batch_id) REFERENCES inv_batch(country_id,book_id,id)
);
CREATE TABLE cst_fee_allocation_claim (
 country_id jxc_safe_id NOT NULL,fee_id jxc_safe_id NOT NULL,allocation_id jxc_safe_id NOT NULL,PRIMARY KEY(country_id,fee_id),UNIQUE(country_id,allocation_id),FOREIGN KEY(country_id,fee_id) REFERENCES lgs_fee(country_id,id),FOREIGN KEY(country_id,allocation_id) REFERENCES cst_fee_allocation(country_id,id)
);
CREATE TABLE cst_allocation_relation (
 country_id jxc_safe_id NOT NULL,book_id jxc_safe_id NOT NULL,original_id jxc_safe_id NOT NULL,replacement_id jxc_safe_id,relation varchar(16) NOT NULL CHECK(relation IN ('REVERSED','SUPERSEDED')),reason text NOT NULL,biz_date date NOT NULL,created_by jxc_safe_id NOT NULL REFERENCES sys_user(id),
 PRIMARY KEY(country_id,original_id),FOREIGN KEY(country_id,book_id,original_id) REFERENCES cst_fee_allocation(country_id,book_id,id),FOREIGN KEY(country_id,book_id,replacement_id) REFERENCES cst_fee_allocation(country_id,book_id,id),CHECK((relation='SUPERSEDED')=(replacement_id IS NOT NULL))
);
CREATE TABLE cst_cost_adjustment (
 id jxc_safe_id PRIMARY KEY DEFAULT nextval('jxc_id_seq'),country_id jxc_safe_id NOT NULL,book_id jxc_safe_id NOT NULL,doc_no varchar(100) NOT NULL,batch_id jxc_safe_id NOT NULL,warehouse_id jxc_safe_id NOT NULL,product_id jxc_safe_id NOT NULL,
 target varchar(16) NOT NULL CHECK(target IN ('INVENTORY','COGS','MIXED')),amount numeric(20,4) NOT NULL,inventory_amount numeric(20,4),sold_amount numeric(20,4),reason text NOT NULL,
 source_type varchar(32) NOT NULL DEFAULT 'MANUAL',source_id jxc_safe_id,reversal_of_id jxc_safe_id,biz_date date NOT NULL,
 status varchar(24) NOT NULL DEFAULT 'DRAFT' CHECK(status IN ('DRAFT','PENDING_APPROVAL','APPROVED','CONFIRMED')),confirmed_by jxc_safe_id REFERENCES sys_user(id),confirmed_at timestamptz,created_by jxc_safe_id NOT NULL REFERENCES sys_user(id),version int NOT NULL DEFAULT 1,
 UNIQUE(country_id,id),UNIQUE(country_id,book_id,id),UNIQUE(country_id,doc_no),FOREIGN KEY(country_id,book_id,batch_id) REFERENCES inv_batch(country_id,book_id,id),FOREIGN KEY(country_id,warehouse_id) REFERENCES org_warehouse(country_id,id),FOREIGN KEY(country_id,product_id) REFERENCES md_country_sku(country_id,product_id),FOREIGN KEY(country_id,reversal_of_id) REFERENCES cst_cost_adjustment(country_id,id),CHECK(amount<>0 OR source_type<>'MANUAL'),CHECK(status<>'CONFIRMED' OR amount=inventory_amount+sold_amount)
);
CREATE TABLE cst_valuation_change (
 id jxc_safe_id PRIMARY KEY DEFAULT nextval('jxc_id_seq'),country_id jxc_safe_id NOT NULL,book_id jxc_safe_id NOT NULL,batch_id jxc_safe_id NOT NULL,adjustment_id jxc_safe_id NOT NULL,
 qty_basis numeric(20,4) NOT NULL CHECK(qty_basis>0),amount numeric(20,4) NOT NULL,inventory_amount numeric(20,4) NOT NULL,sold_amount numeric(20,4) NOT NULL,unit_delta numeric(38,12) NOT NULL,
 source_type varchar(32) NOT NULL,source_id jxc_safe_id NOT NULL,seq int NOT NULL DEFAULT 1,biz_date date NOT NULL,created_by jxc_safe_id NOT NULL REFERENCES sys_user(id),created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 UNIQUE(country_id,id),UNIQUE(country_id,source_type,source_id,batch_id,seq),FOREIGN KEY(country_id,book_id,batch_id) REFERENCES inv_batch(country_id,book_id,id),FOREIGN KEY(country_id,book_id,adjustment_id) REFERENCES cst_cost_adjustment(country_id,book_id,id),CHECK(amount=inventory_amount+sold_amount)
);
CREATE TABLE cst_expense_record (
 id jxc_safe_id PRIMARY KEY DEFAULT nextval('jxc_id_seq'),country_id jxc_safe_id NOT NULL,book_id jxc_safe_id NOT NULL,entity_id jxc_safe_id NOT NULL,doc_no varchar(100) NOT NULL,
 expense_item_id jxc_safe_id NOT NULL,treatment varchar(24) NOT NULL CHECK(treatment IN ('PERIOD_EXPENSE','DIRECT_SELLING')),currency varchar(3) NOT NULL REFERENCES md_currency(code),amount numeric(20,4) NOT NULL CHECK(amount>0),base_currency varchar(3) NOT NULL REFERENCES md_currency(code),base_amount numeric(20,4) NOT NULL CHECK(base_amount>0),rate_id jxc_safe_id,rate numeric(18,8) NOT NULL CHECK(rate>0),rate_date date NOT NULL,rate_version int NOT NULL,biz_date date NOT NULL,status varchar(16) NOT NULL DEFAULT 'CONFIRMED' CHECK(status='CONFIRMED'),created_by jxc_safe_id NOT NULL REFERENCES sys_user(id),created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 UNIQUE(country_id,id),UNIQUE(country_id,book_id,id),UNIQUE(country_id,doc_no),FOREIGN KEY(country_id,book_id) REFERENCES fin_book(country_id,id),FOREIGN KEY(country_id,entity_id) REFERENCES org_entity(country_id,id),FOREIGN KEY(country_id,expense_item_id) REFERENCES md_expense_item(country_id,id),FOREIGN KEY(country_id,rate_id) REFERENCES md_exchange_rate(country_id,id)
);
CREATE TABLE cst_expense_alloc_line (
 id jxc_safe_id PRIMARY KEY DEFAULT nextval('jxc_id_seq'),country_id jxc_safe_id NOT NULL,expense_id jxc_safe_id NOT NULL,product_id jxc_safe_id NOT NULL,amount numeric(20,4) NOT NULL CHECK(amount>0),base_amount numeric(20,4) NOT NULL CHECK(base_amount>0),UNIQUE(country_id,expense_id,product_id),FOREIGN KEY(country_id,expense_id) REFERENCES cst_expense_record(country_id,id),FOREIGN KEY(country_id,product_id) REFERENCES md_country_sku(country_id,product_id)
);
ALTER TABLE md_expense_item DROP CONSTRAINT IF EXISTS md_expense_item_cost_treatment_check;
ALTER TABLE md_expense_item ADD CHECK(cost_treatment IN ('CAPITALIZE','EXPENSE','PERIOD_EXPENSE','DIRECT_SELLING'));
ALTER TABLE md_product ADD gross_weight numeric(20,4) CHECK(gross_weight>=0),ADD volume numeric(20,4) CHECK(volume>=0);
ALTER TABLE cst_valuation_movement ADD command_txid bigint NOT NULL DEFAULT txid_current();
CREATE FUNCTION jxc_cost_completion_guard() RETURNS trigger LANGUAGE plpgsql AS $$ DECLARE original record;BEGIN
 SELECT * INTO original FROM cst_cogs WHERE country_id=NEW.country_id AND id=NEW.cogs_id;
 IF original.book_id<>NEW.book_id OR original.amount IS NOT NULL THEN RAISE EXCEPTION 'CST_COMPLETE_SNAPSHOT_IMMUTABLE';END IF;RETURN NEW;END $$;
CREATE TRIGGER cst_completion_source BEFORE INSERT ON cst_cogs_completion FOR EACH ROW EXECUTE FUNCTION jxc_cost_completion_guard();
CREATE FUNCTION jxc_allocation_total_guard() RETURNS trigger LANGUAGE plpgsql AS $$ DECLARE c bigint;a bigint;header record;total numeric;BEGIN
 c:=coalesce(NEW.country_id,OLD.country_id);IF TG_TABLE_NAME='cst_fee_allocation' THEN a:=coalesce(NEW.id,OLD.id);ELSE a:=coalesce(NEW.allocation_id,OLD.allocation_id);END IF;
 SELECT * INTO header FROM cst_fee_allocation WHERE country_id=c AND id=a FOR UPDATE;SELECT coalesce(sum(amount),0) INTO total FROM cst_fee_allocation_line WHERE country_id=c AND allocation_id=a;
 IF header.id IS NOT NULL AND header.base_amount<>total THEN RAISE EXCEPTION 'CST_ALLOCATION_AMOUNT_MISMATCH';END IF;RETURN NULL;END $$;
CREATE CONSTRAINT TRIGGER cst_alloc_header_total AFTER INSERT OR UPDATE OR DELETE ON cst_fee_allocation DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION jxc_allocation_total_guard();
CREATE CONSTRAINT TRIGGER cst_alloc_line_total AFTER INSERT OR UPDATE OR DELETE ON cst_fee_allocation_line DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION jxc_allocation_total_guard();
CREATE FUNCTION jxc_cost_document_guard() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
 IF TG_OP='INSERT' THEN PERFORM jxc_assert_period_open(NEW.country_id,NEW.book_id,NEW.biz_date);RETURN NEW;END IF;
 IF TG_OP='DELETE' OR OLD.status='CONFIRMED' OR (to_jsonb(NEW)-ARRAY['status','confirmed_by','confirmed_at','inventory_amount','sold_amount','version'])<>(to_jsonb(OLD)-ARRAY['status','confirmed_by','confirmed_at','inventory_amount','sold_amount','version']) THEN RAISE EXCEPTION 'BUSINESS_FACT_IMMUTABLE';END IF;
 PERFORM jxc_assert_period_open(NEW.country_id,NEW.book_id,NEW.biz_date);RETURN NEW;END $$;
CREATE TRIGGER cst_allocation_fact BEFORE INSERT OR UPDATE OR DELETE ON cst_fee_allocation FOR EACH ROW EXECUTE FUNCTION jxc_cost_document_guard();
CREATE TRIGGER cst_adjustment_fact BEFORE INSERT OR UPDATE OR DELETE ON cst_cost_adjustment FOR EACH ROW EXECUTE FUNCTION jxc_cost_document_guard();
DO $$ DECLARE t text;BEGIN FOREACH t IN ARRAY ARRAY['cst_cost_confirmation','cst_cogs_completion','cst_fee_allocation','cst_fee_allocation_line','cst_fee_allocation_claim','cst_allocation_relation','cst_cost_adjustment','cst_valuation_change','cst_expense_record','cst_expense_alloc_line'] LOOP
 EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY',t);EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY',t);EXECUTE format('CREATE POLICY country_isolation ON %I USING(country_id=jxc_current_country_id()) WITH CHECK(country_id=jxc_current_country_id())',t);
 EXECUTE format('GRANT SELECT,INSERT ON %I TO "${runtimeRole}"',t);
 END LOOP;FOREACH t IN ARRAY ARRAY['cst_cost_confirmation','cst_cogs_completion','cst_allocation_relation','cst_valuation_change','cst_expense_record'] LOOP
 EXECUTE format('CREATE TRIGGER %I BEFORE INSERT ON %I FOR EACH ROW EXECUTE FUNCTION jxc_inventory_dated_fact_guard()',t||'_date',t);
 END LOOP;FOREACH t IN ARRAY ARRAY['cst_cost_confirmation','cst_cogs_completion','cst_fee_allocation_line','cst_allocation_relation','cst_valuation_change','cst_expense_record','cst_expense_alloc_line'] LOOP
 EXECUTE format('CREATE TRIGGER %I BEFORE UPDATE OR DELETE ON %I FOR EACH ROW EXECUTE FUNCTION jxc_append_only()',t||'_immutable',t);
 END LOOP;END $$;
GRANT UPDATE ON cst_fee_allocation,cst_cost_adjustment TO "${runtimeRole}";
GRANT DELETE ON cst_fee_allocation_claim TO "${runtimeRole}";
-- Projection writes must be explained by a dated immutable movement from this transaction.
CREATE FUNCTION jxc_cost_projection_binding() RETURNS trigger LANGUAGE plpgsql AS $$ DECLARE movement record;current_value record;BEGIN
 IF TG_OP='UPDATE' AND NEW.amount IS NOT DISTINCT FROM OLD.amount THEN RETURN NULL;END IF;
 SELECT * INTO movement FROM cst_valuation_movement WHERE country_id=NEW.country_id AND book_id=NEW.book_id AND warehouse_id=NEW.warehouse_id AND product_id=NEW.product_id AND command_txid=txid_current() ORDER BY id DESC LIMIT 1;
 IF movement.id IS NULL THEN RAISE EXCEPTION 'CST_PROJECTION_SOURCE_REQUIRED';END IF;
 IF TG_TABLE_NAME='cst_valuation_pool' THEN
  SELECT qty,amount INTO current_value FROM cst_valuation_pool WHERE country_id=NEW.country_id AND book_id=NEW.book_id AND warehouse_id=NEW.warehouse_id AND product_id=NEW.product_id;
  IF current_value.qty<>movement.after_qty OR current_value.amount IS DISTINCT FROM movement.after_amount THEN RAISE EXCEPTION 'CST_PROJECTION_MOVEMENT_MISMATCH';END IF;
 END IF;RETURN NULL;END $$;
CREATE CONSTRAINT TRIGGER cst_pool_fact_binding AFTER INSERT OR UPDATE ON cst_valuation_pool DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION jxc_cost_projection_binding();
CREATE CONSTRAINT TRIGGER cst_batch_fact_binding AFTER INSERT OR UPDATE ON cst_batch_value DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION jxc_cost_projection_binding();
CREATE FUNCTION jxc_inbound_confirmation_guard() RETURNS trigger LANGUAGE plpgsql AS $$ DECLARE source record;BEGIN
 SELECT * INTO source FROM cst_inbound_cost WHERE country_id=NEW.country_id AND id=NEW.cost_id;
 IF source.base_purchase_amount IS NOT NULL AND (NEW.base_purchase_amount<>source.base_purchase_amount OR NEW.rate IS DISTINCT FROM source.rate OR NEW.rate_id IS DISTINCT FROM source.rate_id OR NEW.rate_version IS DISTINCT FROM source.rate_version) THEN RAISE EXCEPTION 'CST_COMPLETE_SNAPSHOT_IMMUTABLE';END IF;
 IF source.base_purchase_amount IS NULL AND source.src_amount IS NOT NULL AND (NEW.rate IS NULL OR NEW.rate<=0 OR NEW.base_purchase_amount<>round(source.src_amount*NEW.rate,4)) THEN RAISE EXCEPTION 'CST_COMPLETION_RATE_MISMATCH';END IF;
 IF NEW.unit_cost<>round(NEW.base_purchase_amount/source.qty,12) THEN RAISE EXCEPTION 'CST_COMPLETION_UNIT_MISMATCH';END IF;RETURN NEW;END $$;
CREATE TRIGGER cst_confirmation_frozen_source BEFORE INSERT ON cst_cost_confirmation FOR EACH ROW EXECUTE FUNCTION jxc_inbound_confirmation_guard();
ALTER TABLE cst_fee_allocation ADD command_txid bigint NOT NULL DEFAULT txid_current();
ALTER TABLE cst_expense_record ADD command_txid bigint NOT NULL DEFAULT txid_current();
CREATE FUNCTION jxc_cost_child_creation_guard() RETURNS trigger LANGUAGE plpgsql AS $$ DECLARE parent_tx bigint;BEGIN
 IF TG_TABLE_NAME='cst_fee_allocation_line' THEN SELECT command_txid INTO parent_tx FROM cst_fee_allocation WHERE country_id=NEW.country_id AND id=NEW.allocation_id;
 ELSE SELECT command_txid INTO parent_tx FROM cst_expense_record WHERE country_id=NEW.country_id AND id=NEW.expense_id;END IF;
 IF parent_tx IS DISTINCT FROM txid_current() THEN RAISE EXCEPTION 'BUSINESS_FACT_IMMUTABLE';END IF;RETURN NEW;END $$;
CREATE TRIGGER cst_allocation_line_creation BEFORE INSERT ON cst_fee_allocation_line FOR EACH ROW EXECUTE FUNCTION jxc_cost_child_creation_guard();
CREATE TRIGGER cst_expense_line_creation BEFORE INSERT ON cst_expense_alloc_line FOR EACH ROW EXECUTE FUNCTION jxc_cost_child_creation_guard();
CREATE FUNCTION jxc_expense_total_guard() RETURNS trigger LANGUAGE plpgsql AS $$ DECLARE c bigint;e bigint;parent record;original numeric;base numeric;BEGIN
 c:=coalesce(NEW.country_id,OLD.country_id);IF TG_TABLE_NAME='cst_expense_record' THEN e:=coalesce(NEW.id,OLD.id);ELSE e:=coalesce(NEW.expense_id,OLD.expense_id);END IF;
 SELECT * INTO parent FROM cst_expense_record WHERE country_id=c AND id=e;SELECT coalesce(sum(amount),0),coalesce(sum(base_amount),0) INTO original,base FROM cst_expense_alloc_line WHERE country_id=c AND expense_id=e;
 IF parent.id IS NOT NULL AND (parent.treatment='DIRECT_SELLING' OR original<>0) AND (original<>parent.amount OR base<>parent.base_amount) THEN RAISE EXCEPTION 'CST_EXPENSE_AMOUNT_MISMATCH';END IF;RETURN NULL;END $$;
CREATE CONSTRAINT TRIGGER cst_expense_header_total AFTER INSERT ON cst_expense_record DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION jxc_expense_total_guard();
CREATE CONSTRAINT TRIGGER cst_expense_line_total AFTER INSERT ON cst_expense_alloc_line DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION jxc_expense_total_guard();
ALTER TABLE cst_inbound_cost ADD FOREIGN KEY(country_id,book_id,batch_id) REFERENCES inv_batch(country_id,book_id,id);
ALTER TABLE cst_batch_value ADD FOREIGN KEY(country_id,book_id,batch_id) REFERENCES inv_batch(country_id,book_id,id);
ALTER TABLE lgs_fee ADD UNIQUE(country_id,book_id,id);
ALTER TABLE cst_fee_allocation ADD FOREIGN KEY(country_id,book_id,fee_id) REFERENCES lgs_fee(country_id,book_id,id);
CREATE FUNCTION jxc_cost_part_ownership_guard() RETURNS trigger LANGUAGE plpgsql AS $$ DECLARE parent record;batch record;source record;BEGIN
 SELECT * INTO batch FROM inv_batch WHERE country_id=NEW.country_id AND id=NEW.batch_id;
 IF TG_TABLE_NAME='cst_cogs_part' THEN
  SELECT * INTO parent FROM cst_cogs WHERE country_id=NEW.country_id AND id=NEW.cogs_id;
  IF NEW.cost_id IS NOT NULL THEN SELECT * INTO source FROM cst_inbound_cost WHERE country_id=NEW.country_id AND id=NEW.cost_id;
   IF source.book_id<>parent.book_id OR source.batch_id<>NEW.batch_id THEN RAISE EXCEPTION 'CST_SOURCE_BOOK_MISMATCH';END IF;
  END IF;
 ELSE SELECT * INTO parent FROM cst_transfer_cost WHERE country_id=NEW.country_id AND id=NEW.transfer_cost_id;
 END IF;
 IF batch.book_id<>parent.book_id OR batch.product_id<>parent.product_id THEN RAISE EXCEPTION 'CST_SOURCE_BOOK_MISMATCH';END IF;RETURN NEW;END $$;
CREATE TRIGGER cst_cogs_part_ownership BEFORE INSERT ON cst_cogs_part FOR EACH ROW EXECUTE FUNCTION jxc_cost_part_ownership_guard();
CREATE TRIGGER cst_transfer_part_ownership BEFORE INSERT ON cst_transfer_cost_part FOR EACH ROW EXECUTE FUNCTION jxc_cost_part_ownership_guard();
-- Pending transfer amounts are completed once, beside the immutable M2 snapshots.
CREATE TABLE cst_transfer_completion (
 country_id jxc_safe_id NOT NULL,book_id jxc_safe_id NOT NULL,transfer_cost_id jxc_safe_id NOT NULL,amount numeric(20,4) NOT NULL CHECK(amount>=0),biz_date date NOT NULL,completed_by jxc_safe_id NOT NULL REFERENCES sys_user(id),PRIMARY KEY(country_id,transfer_cost_id),FOREIGN KEY(country_id,transfer_cost_id) REFERENCES cst_transfer_cost(country_id,id),FOREIGN KEY(country_id,book_id) REFERENCES fin_book(country_id,id)
);
CREATE TABLE cst_transfer_part_completion (
 country_id jxc_safe_id NOT NULL,book_id jxc_safe_id NOT NULL,transfer_cost_id jxc_safe_id NOT NULL,batch_id jxc_safe_id NOT NULL,amount numeric(20,4) NOT NULL CHECK(amount>=0),biz_date date NOT NULL,completed_by jxc_safe_id NOT NULL REFERENCES sys_user(id),PRIMARY KEY(country_id,transfer_cost_id,batch_id),FOREIGN KEY(country_id,transfer_cost_id,batch_id) REFERENCES cst_transfer_cost_part(country_id,transfer_cost_id,batch_id),FOREIGN KEY(country_id,book_id,batch_id) REFERENCES inv_batch(country_id,book_id,id)
);
CREATE TABLE cst_movement_completion (
 country_id jxc_safe_id NOT NULL,book_id jxc_safe_id NOT NULL,movement_id jxc_safe_id NOT NULL,amount_change numeric(20,4) NOT NULL,biz_date date NOT NULL,completed_by jxc_safe_id NOT NULL REFERENCES sys_user(id),PRIMARY KEY(country_id,movement_id),FOREIGN KEY(country_id,movement_id) REFERENCES cst_valuation_movement(country_id,id),FOREIGN KEY(country_id,book_id) REFERENCES fin_book(country_id,id)
);
ALTER TABLE cst_transfer_loss ADD UNIQUE(country_id,id);
CREATE TABLE cst_transfer_loss_completion (
 country_id jxc_safe_id NOT NULL,book_id jxc_safe_id NOT NULL,loss_id jxc_safe_id NOT NULL,amount numeric(20,4) NOT NULL CHECK(amount>=0),biz_date date NOT NULL,completed_by jxc_safe_id NOT NULL REFERENCES sys_user(id),PRIMARY KEY(country_id,loss_id),FOREIGN KEY(country_id,loss_id) REFERENCES cst_transfer_loss(country_id,id),FOREIGN KEY(country_id,book_id) REFERENCES fin_book(country_id,id)
);
CREATE FUNCTION jxc_pending_cost_completion_guard() RETURNS trigger LANGUAGE plpgsql AS $$ DECLARE original record;BEGIN
 IF TG_TABLE_NAME='cst_transfer_completion' THEN SELECT book_id,amount INTO original FROM cst_transfer_cost WHERE country_id=NEW.country_id AND id=NEW.transfer_cost_id;
 ELSIF TG_TABLE_NAME='cst_transfer_part_completion' THEN SELECT t.book_id,p.amount INTO original FROM cst_transfer_cost_part p JOIN cst_transfer_cost t ON t.country_id=p.country_id AND t.id=p.transfer_cost_id WHERE p.country_id=NEW.country_id AND p.transfer_cost_id=NEW.transfer_cost_id AND p.batch_id=NEW.batch_id;
 ELSIF TG_TABLE_NAME='cst_movement_completion' THEN SELECT book_id,amount_change amount INTO original FROM cst_valuation_movement WHERE country_id=NEW.country_id AND id=NEW.movement_id;
 ELSE SELECT c.book_id,l.amount INTO original FROM cst_transfer_loss l JOIN cst_cogs c ON c.country_id=l.country_id AND c.id=l.cogs_id WHERE l.country_id=NEW.country_id AND l.id=NEW.loss_id;END IF;
 IF original.book_id<>NEW.book_id OR original.amount IS NOT NULL THEN RAISE EXCEPTION 'CST_COMPLETE_SNAPSHOT_IMMUTABLE';END IF;RETURN NEW;END $$;
DO $$ DECLARE t text;BEGIN FOREACH t IN ARRAY ARRAY['cst_transfer_completion','cst_transfer_part_completion','cst_movement_completion','cst_transfer_loss_completion'] LOOP
 EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY',t);EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY',t);EXECUTE format('CREATE POLICY country_isolation ON %I USING(country_id=jxc_current_country_id()) WITH CHECK(country_id=jxc_current_country_id())',t);
 EXECUTE format('GRANT SELECT,INSERT ON %I TO "${runtimeRole}"',t);
 EXECUTE format('CREATE TRIGGER %I BEFORE INSERT ON %I FOR EACH ROW EXECUTE FUNCTION jxc_inventory_dated_fact_guard()',t||'_date',t);
 EXECUTE format('CREATE TRIGGER %I BEFORE INSERT ON %I FOR EACH ROW EXECUTE FUNCTION jxc_pending_cost_completion_guard()',t||'_source',t);
 EXECUTE format('CREATE TRIGGER %I BEFORE UPDATE OR DELETE ON %I FOR EACH ROW EXECUTE FUNCTION jxc_append_only()',t||'_immutable',t);
 END LOOP;END $$;
