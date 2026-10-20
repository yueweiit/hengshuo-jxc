-- Preserve M1 financial-event mutation diagnostics when narrowing the technical export exception.
CREATE OR REPLACE FUNCTION jxc_guard_biz_event() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF TG_OP='INSERT' THEN
  IF NEW.source_type='SYS_REPORT_EXPORT' OR NEW.event_type='SYS_REPORT_EXPORT_REQUESTED' THEN
   IF NEW.source_type<>'SYS_REPORT_EXPORT' OR NEW.event_type<>'SYS_REPORT_EXPORT_REQUESTED' OR NEW.event_seq<>1 OR
    NOT EXISTS(SELECT 1 FROM sys_export_job WHERE country_id=NEW.country_id AND book_id=NEW.book_id AND id=NEW.source_id)
   THEN RAISE EXCEPTION 'JXC_JOB_SOURCE_REQUIRED' USING ERRCODE='P0001'; END IF;
   PERFORM id FROM fin_book WHERE country_id=NEW.country_id AND id=NEW.book_id FOR SHARE;
  ELSE PERFORM jxc_assert_period_open(NEW.country_id,NEW.book_id,NEW.biz_date); END IF;
  RETURN NEW;
 ELSIF TG_OP='DELETE' THEN RAISE EXCEPTION 'JXC_IMMUTABLE_FACT' USING ERRCODE='P0001';
 ELSIF ROW(NEW.id,NEW.country_id,NEW.book_id,NEW.event_type,NEW.source_type,NEW.source_id,NEW.event_seq,NEW.payload,NEW.biz_date,NEW.occurred_at)
  IS DISTINCT FROM ROW(OLD.id,OLD.country_id,OLD.book_id,OLD.event_type,OLD.source_type,OLD.source_id,OLD.event_seq,OLD.payload,OLD.biz_date,OLD.occurred_at)
 THEN
  -- Preserve the existing financial period error contract; technical artifacts have no accounting period.
  IF NOT(OLD.source_type='SYS_REPORT_EXPORT' AND OLD.event_type='SYS_REPORT_EXPORT_REQUESTED') THEN
   PERFORM jxc_assert_period_open(OLD.country_id,OLD.book_id,OLD.biz_date);
  END IF;
  RAISE EXCEPTION 'JXC_IMMUTABLE_FACT' USING ERRCODE='P0001'; END IF;
 RETURN NEW;
END $$;
