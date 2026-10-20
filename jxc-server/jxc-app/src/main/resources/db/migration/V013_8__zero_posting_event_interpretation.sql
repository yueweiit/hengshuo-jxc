-- The source owner and the single application renderer prove economic amounts.
-- This guard proves the reviewed interpretation's technical relationships and
-- current FIN effect transaction; it deliberately does not reimplement costing.
CREATE OR REPLACE FUNCTION jxc_guard_fin_event_result() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE policy fin_mapping_template; evt sys_biz_event; voucher fin_voucher;
BEGIN
 SELECT * INTO policy FROM fin_mapping_template WHERE country_id=NEW.country_id AND id=NEW.mapping_template_id;
 SELECT * INTO evt FROM sys_biz_event WHERE country_id=NEW.country_id AND id=NEW.event_id;
 IF policy.status IS DISTINCT FROM 'ACTIVE' OR policy.event_type IS DISTINCT FROM evt.event_type
    OR policy.book_id IS DISTINCT FROM NEW.book_id OR evt.book_id IS DISTINCT FROM NEW.book_id
    OR policy.version_no IS DISTINCT FROM NEW.mapping_version OR NEW.source_event_version IS DISTINCT FROM evt.event_seq THEN
  RAISE EXCEPTION 'FIN_EVENT_INTERPRETATION_INVALID';
 END IF;
 IF NEW.status='NO_VOUCHER' AND policy.accounting_mode IS DISTINCT FROM 'NO_VOUCHER' THEN
  IF policy.accounting_mode IS DISTINCT FROM 'VOUCHER'
     OR NEW.reason IS DISTINCT FROM 'SOURCE_CONFIRMATION_ZERO_POSTING'
     OR NEW.voucher_id IS NOT NULL OR NEW.fact_hash IS NULL OR NEW.fact_hash !~ '^[a-f0-9]{64}$'
     OR NOT EXISTS (
       SELECT 1 FROM sys_biz_event_consume c
       WHERE c.country_id=NEW.country_id AND c.book_id=NEW.book_id AND c.event_id=NEW.event_id
         AND c.consumer='FIN_VOUCHER' AND c.status='PROCESSING'
         -- The original consumer marks its locked effect intent in this very
         -- transaction. A committed lease or another consumer is insufficient.
         AND c.xmin::text::numeric=mod(pg_current_xact_id()::text::numeric,4294967296)
     ) THEN
   RAISE EXCEPTION 'FIN_EVENT_INTERPRETATION_INVALID';
  END IF;
 ELSIF NEW.status='GENERATED' AND policy.accounting_mode IS DISTINCT FROM 'VOUCHER' THEN
  RAISE EXCEPTION 'FIN_EVENT_INTERPRETATION_INVALID';
 END IF;
 IF NEW.voucher_id IS NOT NULL THEN
  SELECT * INTO voucher FROM fin_voucher WHERE country_id=NEW.country_id AND id=NEW.voucher_id;
  IF voucher.source_event_id IS DISTINCT FROM NEW.event_id OR voucher.mapping_template_id IS DISTINCT FROM NEW.mapping_template_id OR voucher.mapping_version IS DISTINCT FROM NEW.mapping_version THEN RAISE EXCEPTION 'FIN_EVENT_INTERPRETATION_INVALID'; END IF;
 END IF;
 RETURN NEW;
END $$;
