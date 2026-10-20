-- Preserve native financial fact immutability; only validated opening inserts have a cutoff exception.
CREATE OR REPLACE FUNCTION jxc_aprtn_dated_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE d date; old_d date; mutable text; opening_batch bigint; expected_type text;
BEGIN
 IF TG_OP='DELETE' THEN RAISE EXCEPTION 'BUSINESS_FACT_DELETE_FORBIDDEN'; END IF;
 d:=(to_jsonb(NEW)->>TG_ARGV[0])::date;
 IF TG_OP='INSERT' AND TG_TABLE_NAME IN ('ap_bill','ap_prepayment') AND to_jsonb(NEW)->>'origin_kind'='OPENING' THEN
   IF NOT jxc_opening_import_allowed(NEW.country_id,d) THEN RAISE EXCEPTION 'SYS_IMPORT_OPENING_SCOPE_REQUIRED' USING ERRCODE='23514';END IF;
   opening_batch:=current_setting('app.opening_import_batch')::bigint;
   expected_type:=CASE WHEN TG_TABLE_NAME='ap_bill' THEN 'OPENING_AP' ELSE 'OPENING_PREPAYMENT' END;
   IF NOT EXISTS(SELECT 1 FROM sys_import_batch b JOIN sys_import_row r ON r.country_id=b.country_id AND r.batch_id=b.id JOIN sys_import_source s ON s.country_id=r.country_id AND s.row_id=r.id AND s.import_type=b.import_type AND s.source_key=r.source_key WHERE b.country_id=NEW.country_id AND b.id=opening_batch AND b.import_type=expected_type AND b.status='VALIDATED' AND b.cutoff_date=d AND NEW.opening_source_ref='IMPORT:'||b.id||':'||r.row_no AND r.normalized->>'refNo'=NEW.opening_ref_no AND (r.normalized->>'bookId')::bigint=NEW.book_id AND (r.normalized->>'partnerId')::bigint=NEW.partner_id AND r.normalized->>'partnerType'=NEW.partner_type AND r.normalized->>'currency'=NEW.currency AND r.normalized->>'baseCurrency'=NEW.base_currency AND (r.normalized->>'rate')::numeric=NEW.rate AND NEW.rate_date=b.cutoff_date AND NEW.rate_id IS NULL AND NEW.valuation_status='READY' AND NEW.status='CONFIRMED' AND COALESCE((r.normalized->>'sourceDate')::date,b.cutoff_date)<=b.cutoff_date AND (r.normalized->>'amount')::numeric=NEW.amount AND (r.normalized->>'baseAmount')::numeric=NEW.base_amount) THEN RAISE EXCEPTION 'SYS_IMPORT_OPENING_SOURCE_MISMATCH' USING ERRCODE='23514';END IF;
   PERFORM id FROM sys_country WHERE id=NEW.country_id AND status<>'DISABLED' FOR SHARE;IF NOT FOUND THEN RAISE EXCEPTION 'SYS_COUNTRY_DISABLED';END IF;
   PERFORM id FROM fin_book WHERE country_id=NEW.country_id AND id=NEW.book_id AND status='ACTIVE' FOR SHARE;IF NOT FOUND THEN RAISE EXCEPTION 'FIN_BOOK_NOT_ACTIVE';END IF;
   IF NOT EXISTS(SELECT 1 FROM fin_period p WHERE p.country_id=NEW.country_id AND p.book_id=NEW.book_id AND p.start_date=d+1 AND p.status='OPEN') OR EXISTS(SELECT 1 FROM fin_period p WHERE p.country_id=NEW.country_id AND p.book_id=NEW.book_id AND p.start_date<d+1) THEN RAISE EXCEPTION 'FIN_OPENING_CUTOFF' USING ERRCODE='23514';END IF;
  RETURN NEW;
 END IF;

 mutable:=CASE TG_TABLE_NAME
  WHEN 'ap_bill' THEN 'paid_amount,status,version'
  WHEN 'ap_payment' THEN 'used_amount,status,version'
  WHEN 'ap_prepayment' THEN 'used_amount,status,version'
  WHEN 'ap_credit_note' THEN 'used_amount,status,version'
  WHEN 'ap_settlement' THEN 'status,version'
  WHEN 'ap_adjustment' THEN 'status,approval_instance_id,version'
  WHEN 'rtn_sales_return' THEN 'status,approval_instance_id,settled_flag,short_reason,version'
  WHEN 'rtn_refund' THEN 'status,approval_instance_id,paid_at,reference_no,paid_by,proof_attachment_id,version'
  WHEN 'rtn_purchase_return' THEN 'status,approval_instance_id,ap_credit_note_id,version'
  WHEN 'rtn_sales_settlement' THEN 'status,version'
  WHEN 'rtn_claim' THEN 'result,compensated_amount,ap_credit_note_id,version'
  WHEN 'rtn_sales_inspection' THEN 'inventory_batch_id,version'
  ELSE '' END;
 IF TG_OP='UPDATE' THEN
  IF TG_TABLE_NAME IN ('ap_bill','ap_adjustment','rtn_sales_return','rtn_refund','rtn_purchase_return') AND (to_jsonb(NEW)->>'status')='DRAFT' AND (to_jsonb(OLD)->>'status')<>'DRAFT' THEN RAISE EXCEPTION 'BUSINESS_FACT_IMMUTABLE' USING ERRCODE='23514';END IF;
  IF TG_TABLE_NAME='ap_bill' AND (to_jsonb(OLD)->>'status')='VOIDED' AND (to_jsonb(NEW)->>'status')<>'VOIDED' THEN RAISE EXCEPTION 'BUSINESS_FACT_IMMUTABLE' USING ERRCODE='23514';END IF;
  IF TG_TABLE_NAME IN ('ap_payment','ap_prepayment') AND (to_jsonb(NEW)->>'status')='PENDING_CONFIRM' AND (to_jsonb(OLD)->>'status')<>'PENDING_CONFIRM' THEN RAISE EXCEPTION 'BUSINESS_FACT_IMMUTABLE' USING ERRCODE='23514';END IF;
  -- Confirmation and voiding create economic effects; only paid/used projections
  -- may follow a new settlement fact after the original period has closed.
  IF TG_TABLE_NAME='ap_bill' AND (to_jsonb(NEW)->>'status') IS DISTINCT FROM (to_jsonb(OLD)->>'status') AND ((to_jsonb(OLD)->>'status')='DRAFT' OR (to_jsonb(NEW)->>'status')='VOIDED') THEN
   PERFORM jxc_assert_period_open(OLD.country_id,OLD.book_id,OLD.bill_date);
  ELSIF TG_TABLE_NAME IN ('ap_payment','ap_prepayment') AND (to_jsonb(NEW)->>'status') IS DISTINCT FROM (to_jsonb(OLD)->>'status') AND ((to_jsonb(OLD)->>'status')='PENDING_CONFIRM' OR (to_jsonb(NEW)->>'status')='VOIDED') THEN
   PERFORM jxc_assert_period_open(OLD.country_id,OLD.book_id,OLD.pay_date);
  END IF;
  IF mutable<>'' AND (to_jsonb(NEW)-string_to_array(mutable,',')) IS NOT DISTINCT FROM (to_jsonb(OLD)-string_to_array(mutable,',')) THEN RETURN NEW; END IF;
  IF TG_TABLE_NAME IN ('ap_bill','ap_payment','ap_prepayment','ap_credit_note') THEN
   IF to_jsonb(OLD)->>'valuation_status'='PENDING_RATE' AND
      (to_jsonb(NEW)-ARRAY['base_currency','rate_id','rate','rate_date','base_amount','valuation_status','version']) IS NOT DISTINCT FROM
      (to_jsonb(OLD)-ARRAY['base_currency','rate_id','rate','rate_date','base_amount','valuation_status','version']) THEN
    PERFORM jxc_assert_period_open(OLD.country_id,OLD.book_id,(to_jsonb(OLD)->>TG_ARGV[0])::date);RETURN NEW;
   END IF;
   IF (TG_TABLE_NAME='ap_bill' AND OLD.status<>'DRAFT') OR
      (TG_TABLE_NAME IN ('ap_payment','ap_prepayment') AND OLD.status<>'PENDING_CONFIRM') OR
       TG_TABLE_NAME='ap_credit_note' THEN RAISE EXCEPTION 'BUSINESS_FACT_IMMUTABLE' USING ERRCODE='23514';END IF;
  ELSIF TG_TABLE_NAME IN ('ap_settlement','rtn_sales_receipt','rtn_sales_settlement','rtn_sales_inspection','rtn_claim') OR (TG_TABLE_NAME IN ('ap_adjustment','rtn_sales_return','rtn_refund','rtn_purchase_return') AND (to_jsonb(OLD)->>'status')<>'DRAFT') THEN
   RAISE EXCEPTION 'BUSINESS_FACT_IMMUTABLE' USING ERRCODE='23514';
  END IF;
 END IF;
 d:=(to_jsonb(NEW)->>TG_ARGV[0])::date;
 PERFORM jxc_assert_period_open(NEW.country_id,NEW.book_id,d);
 IF TG_OP='UPDATE' THEN old_d:=(to_jsonb(OLD)->>TG_ARGV[0])::date;IF (OLD.country_id,OLD.book_id,old_d) IS DISTINCT FROM (NEW.country_id,NEW.book_id,d) THEN PERFORM jxc_assert_period_open(OLD.country_id,OLD.book_id,old_d);END IF;END IF;
 RETURN NEW;
END $$;
