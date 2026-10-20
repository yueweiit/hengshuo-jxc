-- State selection only: callers must separately establish sealed or persisted opening authority.
-- A configured cutoff period retains its existing behavior; no historical period is fabricated.
CREATE FUNCTION jxc_assert_opening_cutoff_period(selected_country bigint,selected_book bigint,cutoff date)
RETURNS void LANGUAGE plpgsql VOLATILE AS $$
DECLARE first_start date;
BEGIN
 IF EXISTS(SELECT 1 FROM fin_period WHERE country_id=selected_country AND book_id=selected_book AND cutoff BETWEEN start_date AND end_date) THEN
  PERFORM id FROM fin_period WHERE country_id=selected_country AND book_id=selected_book AND cutoff BETWEEN start_date AND end_date FOR SHARE;
  PERFORM jxc_assert_period_state(selected_country,selected_book,cutoff);RETURN;
 END IF;
 SELECT min(start_date) INTO first_start FROM fin_period WHERE country_id=selected_country AND book_id=selected_book;
 IF cutoff IS NULL OR first_start IS DISTINCT FROM cutoff+1 THEN RAISE EXCEPTION 'FIN_OPENING_CUTOFF' USING ERRCODE='23514';END IF;
 PERFORM id FROM fin_period WHERE country_id=selected_country AND book_id=selected_book AND start_date=first_start FOR SHARE;
 PERFORM jxc_assert_period_state(selected_country,selected_book,first_start);
END $$;

-- Only the five native opening INSERT shapes can use the cutoff-period selector.
-- The immutable reviewed row and source reservation must match the actual economic fact.
CREATE FUNCTION jxc_assert_subledger_opening_fact(fact_table text,fact jsonb)
RETURNS void LANGUAGE plpgsql VOLATILE AS $$
DECLARE selected_country bigint;selected_book bigint;document_day date;selected_row_id bigint;import_batch_id bigint;requested_user bigint;expected_type text;reviewed jsonb;base text;quantity numeric;unit_price numeric;valued_unit numeric;
BEGIN
 selected_country:=(fact->>'country_id')::bigint;selected_book:=(fact->>'book_id')::bigint;document_day:=(fact->>'biz_date')::date;
 expected_type:=CASE fact_table WHEN 'inv_stock_txn' THEN 'OPENING_STOCK' WHEN 'cst_inbound_cost' THEN 'OPENING_STOCK' WHEN 'cst_valuation_movement' THEN 'OPENING_STOCK' WHEN 'ar_receivable' THEN 'OPENING_AR' WHEN 'ar_credit_note' THEN 'OPENING_ADVANCE' END;
 IF expected_type IS NULL OR fact->>'source_type' IS DISTINCT FROM expected_type OR NOT jxc_opening_import_allowed(selected_country,document_day) THEN RAISE EXCEPTION 'SYS_IMPORT_OPENING_SCOPE_REQUIRED' USING ERRCODE='23514';END IF;
 selected_row_id:=(CASE WHEN expected_type='OPENING_STOCK' THEN fact->>'source_line_id' ELSE fact->>'import_row_id' END)::bigint;
 SELECT r.normalized,b.id,b.requested_by INTO reviewed,import_batch_id,requested_user
 FROM sys_import_batch b JOIN sys_import_row r ON r.country_id=b.country_id AND r.batch_id=b.id
 JOIN sys_import_source s ON s.country_id=r.country_id AND s.row_id=r.id AND s.import_type=b.import_type AND s.source_key=r.source_key
 WHERE b.country_id=selected_country AND b.id=current_setting('app.opening_import_batch')::bigint AND b.import_type=expected_type AND b.status='VALIDATED'
 AND b.cutoff_date=document_day AND r.id=selected_row_id AND r.errors='[]'::jsonb AND r.target_id IS NULL;
 IF NOT FOUND OR (reviewed->>'bookId')::bigint IS DISTINCT FROM selected_book OR reviewed->>'sourceDate' IS NULL OR (reviewed->>'sourceDate')::date>document_day THEN RAISE EXCEPTION 'SYS_IMPORT_OPENING_SOURCE_MISMATCH' USING ERRCODE='23514';END IF;
 PERFORM jxc_assert_country_trade(selected_country,document_day);
 SELECT base_currency INTO base FROM fin_book WHERE country_id=selected_country AND id=selected_book;
 IF expected_type='OPENING_STOCK' THEN
  quantity:=(reviewed->>'qty')::numeric;unit_price:=(reviewed->>'unitCost')::numeric;valued_unit:=round(round(quantity*unit_price,4)/quantity,4);
  IF ROW((fact->>'warehouse_id')::bigint,(fact->>'product_id')::bigint) IS DISTINCT FROM ROW((reviewed->>'warehouseId')::bigint,(reviewed->>'productId')::bigint)
   OR NOT EXISTS(SELECT 1 FROM inv_batch b WHERE b.country_id=selected_country AND b.id=(fact->>'batch_id')::bigint AND b.book_id=selected_book AND b.product_id=(reviewed->>'productId')::bigint AND b.source_type='OPENING_STOCK' AND b.source_id=import_batch_id AND b.source_line_id=selected_row_id AND b.first_inbound_date=document_day AND b.cutoff_date=document_day AND b.opening_warehouse_id=(reviewed->>'warehouseId')::bigint AND b.opening_batch_no=reviewed->>'batchNo') THEN RAISE EXCEPTION 'SYS_IMPORT_OPENING_SOURCE_MISMATCH' USING ERRCODE='23514';END IF;
  IF fact_table='inv_stock_txn' THEN
   IF (fact->>'source_id')::bigint IS DISTINCT FROM import_batch_id OR fact->>'source_no' IS DISTINCT FROM reviewed->>'refNo' OR fact->>'txn_type' IS DISTINCT FROM 'OPENING_IN'
    OR (fact->>'on_hand_change')::numeric IS DISTINCT FROM quantity OR (fact->>'frozen_change')::numeric IS DISTINCT FROM 0::numeric OR (fact->>'seq')::integer IS DISTINCT FROM 1 OR (fact->>'operator_id')::bigint IS DISTINCT FROM requested_user OR (fact->>'unit_cost')::numeric IS DISTINCT FROM valued_unit THEN RAISE EXCEPTION 'SYS_IMPORT_OPENING_SOURCE_MISMATCH' USING ERRCODE='23514';END IF;
  ELSIF fact_table='cst_inbound_cost' THEN
   IF (fact->>'qty')::numeric IS DISTINCT FROM quantity OR (fact->>'src_unit_price')::numeric IS DISTINCT FROM unit_price OR (fact->>'unit_cost')::numeric IS DISTINCT FROM valued_unit
    OR (fact->>'src_amount')::numeric IS DISTINCT FROM round(quantity*unit_price,4) OR (fact->>'base_purchase_amount')::numeric IS DISTINCT FROM round(quantity*unit_price,4)
    OR fact->>'src_currency' IS DISTINCT FROM base OR fact->>'base_currency' IS DISTINCT FROM base OR (fact->>'rate')::numeric IS DISTINCT FROM 1::numeric OR (fact->>'rate_date')::date IS DISTINCT FROM document_day OR fact->>'rate_id' IS NOT NULL
    OR fact->>'status' IS DISTINCT FROM 'ESTIMATED' OR fact->>'po_id' IS NOT NULL OR fact->>'po_line_id' IS NOT NULL OR fact->>'original_outbound_line_id' IS NOT NULL OR fact->>'source_cost_id' IS NOT NULL THEN RAISE EXCEPTION 'SYS_IMPORT_OPENING_SOURCE_MISMATCH' USING ERRCODE='23514';END IF;
  ELSE
   IF fact->>'action' IS DISTINCT FROM 'INBOUND' OR (fact->>'seq')::integer IS DISTINCT FROM 1 OR (fact->>'qty_change')::numeric IS DISTINCT FROM quantity
    OR (fact->>'amount_change')::numeric IS DISTINCT FROM round(quantity*unit_price,4) OR fact->>'cogs_id' IS NOT NULL OR fact->>'transfer_cost_id' IS NOT NULL
    OR NOT EXISTS(SELECT 1 FROM cst_inbound_cost c WHERE c.country_id=selected_country AND c.book_id=selected_book AND c.batch_id=(fact->>'batch_id')::bigint AND c.source_type='OPENING_STOCK' AND c.source_line_id=selected_row_id AND c.biz_date=document_day AND c.qty=quantity AND c.base_purchase_amount=(fact->>'amount_change')::numeric)
   THEN RAISE EXCEPTION 'SYS_IMPORT_OPENING_SOURCE_MISMATCH' USING ERRCODE='23514';END IF;
  END IF;
 ELSE
  IF (fact->>'source_id')::bigint IS DISTINCT FROM selected_row_id OR fact->>'opening_ref' IS DISTINCT FROM reviewed->>'refNo' OR (fact->>'cutoff_date')::date IS DISTINCT FROM document_day
   OR (fact->>'customer_id')::bigint IS DISTINCT FROM (reviewed->>'customerId')::bigint OR fact->>'currency' IS DISTINCT FROM reviewed->>'currency' OR fact->>'currency' IS DISTINCT FROM base OR (fact->>'amount')::numeric IS DISTINCT FROM (reviewed->>'amount')::numeric OR fact->>'order_id' IS NOT NULL THEN RAISE EXCEPTION 'SYS_IMPORT_OPENING_SOURCE_MISMATCH' USING ERRCODE='23514';END IF;
  IF expected_type='OPENING_AR' THEN
   IF (fact->>'open_amount')::numeric IS DISTINCT FROM (reviewed->>'amount')::numeric OR (fact->>'written_off_amount')::numeric IS DISTINCT FROM 0::numeric OR (fact->>'due_date')::date IS DISTINCT FROM (reviewed->>'dueDate')::date THEN RAISE EXCEPTION 'SYS_IMPORT_OPENING_SOURCE_MISMATCH' USING ERRCODE='23514';END IF;
  ELSIF fact->>'purpose' IS DISTINCT FROM 'OFFSET' OR (fact->>'refundable_flag')::boolean IS DISTINCT FROM false OR (fact->>'used_amount')::numeric IS DISTINCT FROM 0::numeric OR (fact->>'reserved_amount')::numeric IS DISTINCT FROM 0::numeric THEN RAISE EXCEPTION 'SYS_IMPORT_OPENING_SOURCE_MISMATCH' USING ERRCODE='23514';
  END IF;
 END IF;
 PERFORM jxc_assert_opening_cutoff_period(selected_country,selected_book,document_day);
END $$;

CREATE OR REPLACE FUNCTION jxc_inventory_dated_fact_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF TG_OP='INSERT' AND TG_TABLE_NAME IN ('inv_stock_txn','cst_inbound_cost','cst_valuation_movement') AND to_jsonb(NEW)->>'source_type'='OPENING_STOCK' THEN
  PERFORM jxc_assert_subledger_opening_fact(TG_TABLE_NAME,to_jsonb(NEW));RETURN NEW;
 END IF;
 PERFORM jxc_assert_period_open(NEW.country_id,NEW.book_id,NEW.biz_date);RETURN NEW;
END $$;

CREATE OR REPLACE FUNCTION jxc_sales_date_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE d date;old_d date;
BEGIN
 d:=(to_jsonb(NEW)->>TG_ARGV[0])::date;
 IF TG_OP='INSERT' AND ((TG_TABLE_NAME='ar_receivable' AND to_jsonb(NEW)->>'source_type'='OPENING_AR') OR (TG_TABLE_NAME='ar_credit_note' AND to_jsonb(NEW)->>'source_type'='OPENING_ADVANCE')) THEN
  PERFORM jxc_assert_subledger_opening_fact(TG_TABLE_NAME,to_jsonb(NEW));RETURN NEW;
 END IF;
 IF TG_OP='INSERT' THEN PERFORM jxc_assert_period_open(NEW.country_id,NEW.book_id,d);
 ELSIF (to_jsonb(NEW)-string_to_array(TG_ARGV[1],',')) IS DISTINCT FROM (to_jsonb(OLD)-string_to_array(TG_ARGV[1],',')) THEN
  old_d:=(to_jsonb(OLD)->>TG_ARGV[0])::date;PERFORM jxc_assert_period_open(OLD.country_id,OLD.book_id,old_d);PERFORM jxc_assert_period_open(NEW.country_id,NEW.book_id,d);
  IF TG_ARGV[2]='immutable' THEN RAISE EXCEPTION 'JXC_IMMUTABLE_FACT' USING ERRCODE='P0001';END IF;
 END IF;
 RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION jxc_assert_opening_cutoff_period(bigint,bigint,date),jxc_assert_subledger_opening_fact(text,jsonb) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION jxc_assert_opening_cutoff_period(bigint,bigint,date),jxc_assert_subledger_opening_fact(text,jsonb) TO "${runtimeRole}";

-- Opening stock retains its original cutoff event, backed by the same immutable native transaction.
CREATE OR REPLACE FUNCTION jxc_guard_biz_event() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE opening_txn inv_stock_txn;
BEGIN
 IF TG_OP='INSERT' THEN
  IF NEW.source_type='OPENING_STOCK' AND NEW.event_type='INV_STOCK_CHANGED' THEN
   SELECT * INTO opening_txn FROM inv_stock_txn t WHERE t.country_id=NEW.country_id AND t.book_id=NEW.book_id AND t.source_type='OPENING_STOCK' AND t.source_line_id=NEW.source_id AND t.txn_type='OPENING_IN' AND t.seq=1 AND t.biz_date=NEW.biz_date;
   IF NOT FOUND OR NEW.event_seq<>1 OR NEW.payload IS DISTINCT FROM jsonb_build_object('warehouseId',opening_txn.warehouse_id,'productId',opening_txn.product_id,'sourceId',opening_txn.source_id,'sourceLineId',opening_txn.source_line_id) THEN RAISE EXCEPTION 'SYS_IMPORT_OPENING_SOURCE_MISMATCH' USING ERRCODE='23514';END IF;
   PERFORM jxc_assert_subledger_opening_fact('inv_stock_txn',to_jsonb(opening_txn));RETURN NEW;
  ELSIF NEW.source_type='SYS_REPORT_EXPORT' OR NEW.event_type='SYS_REPORT_EXPORT_REQUESTED' THEN
   IF NEW.source_type<>'SYS_REPORT_EXPORT' OR NEW.event_type<>'SYS_REPORT_EXPORT_REQUESTED' OR NEW.event_seq<>1 OR
    NOT EXISTS(SELECT 1 FROM sys_export_job WHERE country_id=NEW.country_id AND book_id=NEW.book_id AND id=NEW.source_id)
   THEN RAISE EXCEPTION 'JXC_JOB_SOURCE_REQUIRED' USING ERRCODE='P0001';END IF;
   PERFORM id FROM fin_book WHERE country_id=NEW.country_id AND id=NEW.book_id FOR SHARE;
  ELSE PERFORM jxc_assert_period_open(NEW.country_id,NEW.book_id,NEW.biz_date);END IF;
  RETURN NEW;
 ELSIF TG_OP='DELETE' THEN RAISE EXCEPTION 'JXC_IMMUTABLE_FACT' USING ERRCODE='P0001';
 ELSIF ROW(NEW.id,NEW.country_id,NEW.book_id,NEW.event_type,NEW.source_type,NEW.source_id,NEW.event_seq,NEW.payload,NEW.biz_date,NEW.occurred_at)
  IS DISTINCT FROM ROW(OLD.id,OLD.country_id,OLD.book_id,OLD.event_type,OLD.source_type,OLD.source_id,OLD.event_seq,OLD.payload,OLD.biz_date,OLD.occurred_at)
 THEN
  IF NOT(OLD.source_type='SYS_REPORT_EXPORT' AND OLD.event_type='SYS_REPORT_EXPORT_REQUESTED') THEN PERFORM jxc_assert_period_open(OLD.country_id,OLD.book_id,OLD.biz_date);END IF;
  RAISE EXCEPTION 'JXC_IMMUTABLE_FACT' USING ERRCODE='P0001';END IF;
 RETURN NEW;
END $$;
