-- Installed after all domain closure migrations. Reads remain authorized for DISABLED countries.
CREATE FUNCTION jxc_country_mutation_gate() RETURNS trigger LANGUAGE plpgsql VOLATILE AS $$
DECLARE value jsonb;selected_country bigint;country_status text;day date;
BEGIN
 value:=CASE WHEN TG_OP='DELETE' THEN to_jsonb(OLD) ELSE to_jsonb(NEW) END;
 selected_country:=(value->>'country_id')::bigint;
 IF selected_country=0 OR TG_TABLE_NAME IN('sys_authz_epoch','sys_audit_log','sys_idempotency','sys_export_job','sys_job_result','sys_job_execution_intent','sys_notification','sys_worker_runtime') THEN RETURN CASE WHEN TG_OP='DELETE' THEN OLD ELSE NEW END;END IF;
 -- Finite historical exports keep their existing owner/session/source guards and never mutate facts.
 IF TG_TABLE_NAME='sys_biz_event' AND value->>'source_type'='SYS_REPORT_EXPORT' AND value->>'event_type'='SYS_REPORT_EXPORT_REQUESTED' AND (value->>'event_seq')::integer=1 AND EXISTS(SELECT 1 FROM sys_export_job j WHERE j.country_id=selected_country AND j.book_id=(value->>'book_id')::bigint AND j.id=(value->>'source_id')::bigint) THEN RETURN CASE WHEN TG_OP='DELETE' THEN OLD ELSE NEW END;END IF;
 IF TG_TABLE_NAME='sys_biz_event_consume' AND value->>'consumer'='SYS_EXPORT' AND EXISTS(SELECT 1 FROM sys_biz_event e WHERE e.country_id=selected_country AND e.id=(value->>'event_id')::bigint AND e.source_type='SYS_REPORT_EXPORT' AND e.event_type='SYS_REPORT_EXPORT_REQUESTED') THEN RETURN CASE WHEN TG_OP='DELETE' THEN OLD ELSE NEW END;END IF;
 SELECT status INTO country_status FROM sys_country WHERE id=selected_country FOR SHARE;
 IF country_status='DISABLED' THEN RAISE EXCEPTION 'SYS_COUNTRY_DISABLED';END IF;
 IF TG_ARGV[0]='TRADE' AND country_status<>'ACTIVE' THEN
  day:=coalesce((value->>'biz_date')::date,(value->>'order_date')::date,(value->>'bill_date')::date,(value->>'pay_date')::date,(value->>'receipt_date')::date,(value->>'voucher_date')::date,(value->>'opening_date')::date);
  IF day IS NULL THEN
   -- Child facts carry the same server-only import transaction and inherit its validated cutoff.
   IF coalesce(current_setting('app.opening_import_batch',true),'') ~ '^[1-9][0-9]{0,15}$' THEN SELECT cutoff_date INTO day FROM sys_import_batch WHERE country_id=selected_country AND id=current_setting('app.opening_import_batch',true)::bigint AND status='VALIDATED';END IF;
  END IF;
  IF NOT jxc_opening_import_allowed(selected_country,day) THEN RAISE EXCEPTION 'SYS_COUNTRY_NOT_ACTIVE';END IF;
 END IF;
 RETURN CASE WHEN TG_OP='DELETE' THEN OLD ELSE NEW END;
END $$;
DO $$ DECLARE row record;mode text; BEGIN
 FOR row IN SELECT c.relname FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='public' AND c.relkind IN('r','p') AND EXISTS(SELECT 1 FROM pg_attribute a WHERE a.attrelid=c.oid AND a.attname='country_id' AND NOT a.attisdropped) LOOP
  -- Configuration, explicit opening configuration and workflow metadata can be prepared in DRAFT.
  mode:=CASE WHEN
   ((row.relname ~ '^(pur|lgs|rtn|sal|ar|ap|inv|cst)_') AND row.relname NOT IN('sal_price','ar_credit_rule','ap_recognition_rule','inv_classify_rule','inv_stock_limit','cst_method_config'))
   OR (row.relname LIKE 'fin\_%' ESCAPE '\' AND row.relname NOT IN('fin_book','fin_period','fin_account','fin_cashflow_item','fin_category_account_map','fin_mapping_line','fin_mapping_template','fin_opening_balance','fin_report_line_account','fin_report_template','fin_report_template_line','fin_voucher_word')) OR row.relname='sys_biz_event' THEN 'TRADE' ELSE 'CONFIG' END;
  EXECUTE format('CREATE TRIGGER jxc_country_gate BEFORE INSERT OR UPDATE OR DELETE ON %I FOR EACH ROW EXECUTE FUNCTION jxc_country_mutation_gate(%L)',row.relname,mode);
 END LOOP;
END $$;
