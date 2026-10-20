-- M4: retained immutable generations. Runtime owns no DDL/BYPASSRLS and cannot write snapshots.
ALTER TABLE fin_period ADD close_generation integer NOT NULL DEFAULT 0 CHECK(close_generation>=0);
ALTER TABLE fin_period ADD closed_by jxc_safe_id REFERENCES sys_user(id);
ALTER TABLE fin_period ADD closed_at timestamptz;
CREATE TABLE fin_close_generation (
 id jxc_safe_id PRIMARY KEY DEFAULT nextval('jxc_id_seq'),country_id jxc_safe_id NOT NULL,book_id jxc_safe_id NOT NULL,period_id jxc_safe_id NOT NULL,
 close_generation integer NOT NULL CHECK(close_generation>0),source_fingerprint varchar(64) NOT NULL CHECK(source_fingerprint ~ '^[a-f0-9]{64}$'),
 checks jsonb NOT NULL CHECK(jsonb_typeof(checks)='array' AND jxc_json_ids_safe(checks)),created_by jxc_safe_id NOT NULL REFERENCES sys_user(id),created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 UNIQUE(country_id,id),UNIQUE(country_id,book_id,period_id,close_generation),FOREIGN KEY(country_id,book_id,period_id) REFERENCES fin_period(country_id,book_id,id)
);
CREATE TABLE fin_snapshot (
 id jxc_safe_id PRIMARY KEY DEFAULT nextval('jxc_id_seq'),country_id jxc_safe_id NOT NULL,book_id jxc_safe_id NOT NULL,period_id jxc_safe_id NOT NULL,
 close_generation integer NOT NULL CHECK(close_generation>0),snapshot_type varchar(16) NOT NULL CHECK(snapshot_type IN ('BALANCE','REPORT','RECONCILE')),
 content jsonb NOT NULL CHECK(jsonb_typeof(content)='object' AND jxc_json_ids_safe(content)),source_versions jsonb NOT NULL CHECK(jsonb_typeof(source_versions)='object' AND jxc_json_ids_safe(source_versions)),
 source_fingerprint varchar(64) NOT NULL CHECK(source_fingerprint ~ '^[a-f0-9]{64}$'),created_by jxc_safe_id NOT NULL REFERENCES sys_user(id),created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 UNIQUE(country_id,id),UNIQUE(country_id,book_id,period_id,close_generation,snapshot_type),FOREIGN KEY(country_id,book_id,period_id,close_generation) REFERENCES fin_close_generation(country_id,book_id,period_id,close_generation)
);
CREATE TABLE fin_close_waiver (
 id jxc_safe_id PRIMARY KEY DEFAULT nextval('jxc_id_seq'),country_id jxc_safe_id NOT NULL,book_id jxc_safe_id NOT NULL,period_id jxc_safe_id NOT NULL,
 close_generation integer NOT NULL CHECK(close_generation>0),check_code varchar(32) NOT NULL CHECK(check_code IN ('AR_DIFF','AP_DIFF','INV_DIFF','CASH_DIFF')),
 fingerprint varchar(64) NOT NULL CHECK(fingerprint ~ '^[a-f0-9]{64}$'),reason varchar(1000) NOT NULL CHECK(length(btrim(reason))>0),waived_by jxc_safe_id NOT NULL REFERENCES sys_user(id),created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 UNIQUE(country_id,id),FOREIGN KEY(country_id,book_id,period_id) REFERENCES fin_period(country_id,book_id,id)
);
CREATE TABLE fin_reopen_log (
 id jxc_safe_id PRIMARY KEY DEFAULT nextval('jxc_id_seq'),country_id jxc_safe_id NOT NULL,book_id jxc_safe_id NOT NULL,period_id jxc_safe_id NOT NULL,
 previous_generation integer NOT NULL CHECK(previous_generation>0),reason varchar(1000) NOT NULL CHECK(length(btrim(reason))>0),
 snapshot_refs jsonb NOT NULL CHECK(jsonb_typeof(snapshot_refs)='array' AND jxc_json_ids_safe(snapshot_refs)),dependencies jsonb NOT NULL CHECK(jsonb_typeof(dependencies)='array' AND jxc_json_ids_safe(dependencies)),
 invalidated_waiver_ids jsonb NOT NULL CHECK(jsonb_typeof(invalidated_waiver_ids)='array' AND jxc_json_ids_safe(invalidated_waiver_ids)),
 operated_by jxc_safe_id NOT NULL REFERENCES sys_user(id),operated_at timestamptz NOT NULL DEFAULT clock_timestamp(),UNIQUE(country_id,id),
 FOREIGN KEY(country_id,book_id,period_id,previous_generation) REFERENCES fin_close_generation(country_id,book_id,period_id,close_generation)
);
DO $$ DECLARE t text;BEGIN FOREACH t IN ARRAY ARRAY['fin_close_generation','fin_snapshot','fin_close_waiver','fin_reopen_log'] LOOP
 EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY',t);EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY',t);
 EXECUTE format('CREATE POLICY country_isolation ON %I USING(country_id=jxc_current_country_id()) WITH CHECK(country_id=jxc_current_country_id())',t);
 EXECUTE format('CREATE TRIGGER immutable_generation BEFORE UPDATE OR DELETE ON %I FOR EACH ROW EXECUTE FUNCTION jxc_append_only()',t);
 END LOOP;END $$;
GRANT SELECT ON fin_close_generation,fin_snapshot,fin_close_waiver,fin_reopen_log TO "${runtimeRole}";
GRANT INSERT ON fin_close_waiver TO "${runtimeRole}";
REVOKE DELETE ON fin_period FROM "${runtimeRole}";

CREATE FUNCTION jxc_period_closing_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF current_user='${runtimeRole}' THEN
  IF TG_OP='INSERT' AND (NEW.status NOT IN ('OPEN','NOT_STARTED') OR NEW.close_generation<>0 OR NEW.closed_by IS NOT NULL OR NEW.closed_at IS NOT NULL) THEN RAISE EXCEPTION 'FIN_PERIOD_CONTROLLED_TRANSITION';END IF;
  IF TG_OP='UPDATE' AND (ROW(NEW.status,NEW.close_generation,NEW.closed_by,NEW.closed_at,NEW.country_id,NEW.book_id,NEW.fiscal_year,NEW.period_no,NEW.start_date,NEW.end_date) IS DISTINCT FROM ROW(OLD.status,OLD.close_generation,OLD.closed_by,OLD.closed_at,OLD.country_id,OLD.book_id,OLD.fiscal_year,OLD.period_no,OLD.start_date,OLD.end_date)) THEN RAISE EXCEPTION 'FIN_PERIOD_CONTROLLED_TRANSITION';END IF;
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER period_closing_guard BEFORE INSERT OR UPDATE ON fin_period FOR EACH ROW EXECUTE FUNCTION jxc_period_closing_guard();
CREATE FUNCTION jxc_close_waiver_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE p fin_period;
BEGIN
 SELECT * INTO p FROM fin_period WHERE country_id=NEW.country_id AND book_id=NEW.book_id AND id=NEW.period_id;
 IF NOT FOUND OR p.status NOT IN ('OPEN','PENDING_CLOSE') OR NEW.close_generation<>p.close_generation+1 THEN RAISE EXCEPTION 'FIN_WAIVER_STALE';END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER close_waiver_guard BEFORE INSERT ON fin_close_waiver FOR EACH ROW EXECUTE FUNCTION jxc_close_waiver_guard();

-- Only this controlled function may create a closing generation. Cross-module accounting
-- completeness remains the owner API's check under the same exclusive book transaction.
-- The DB independently validates FIN facts, actual balances, complete snapshots and generation.
CREATE FUNCTION jxc_finalize_period(p_country bigint,p_book bigint,p_period bigint,p_user bigint,p_balance jsonb,p_report jsonb,p_reconcile jsonb,p_sources jsonb,p_fingerprint text,p_checks jsonb)
RETURNS integer LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE p public.fin_period;n integer;bad_count integer;expected_count integer;item jsonb;next_start date;next_end date;next_id bigint;
BEGIN
 IF p_country IS DISTINCT FROM public.jxc_current_country_id() THEN RAISE EXCEPTION 'SYS_COUNTRY_REQUIRED';END IF;
 PERFORM 1 FROM public.fin_book WHERE country_id=p_country AND id=p_book AND status='ACTIVE' FOR UPDATE;IF NOT FOUND THEN RAISE EXCEPTION 'FIN_BOOK_NOT_ACTIVE';END IF;
 SELECT * INTO p FROM public.fin_period WHERE country_id=p_country AND book_id=p_book AND id=p_period FOR UPDATE;IF NOT FOUND THEN RAISE EXCEPTION 'FIN_PERIOD_NOT_FOUND';END IF;
 IF p.status='CLOSED' THEN RETURN p.close_generation;END IF;
 IF p.status NOT IN ('OPEN','PENDING_CLOSE') THEN RAISE EXCEPTION 'FIN_PERIOD_NOT_OPEN';END IF;n:=p.close_generation+1;
 IF EXISTS(SELECT 1 FROM public.sys_biz_event e LEFT JOIN public.fin_event_result r ON r.country_id=e.country_id AND r.event_id=e.id LEFT JOIN public.sys_biz_event_consume c ON c.country_id=e.country_id AND c.event_id=e.id AND c.consumer='FIN_VOUCHER' WHERE e.country_id=p_country AND e.book_id=p_book AND e.biz_date BETWEEN p.start_date AND p.end_date AND NOT(e.source_type='SYS_REPORT_EXPORT' AND e.event_type='SYS_REPORT_EXPORT_REQUESTED') AND (r.id IS NULL OR e.status='FAILED' OR c.status='FAILED')) THEN RAISE EXCEPTION 'FIN_CLOSE_EVENTS_OPEN';END IF;
 IF EXISTS(SELECT 1 FROM public.fin_voucher WHERE country_id=p_country AND book_id=p_book AND period_id=p_period AND (status NOT IN ('POSTED','REVERSED') OR total_debit<>total_credit)) THEN RAISE EXCEPTION 'FIN_CLOSE_VOUCHER_BLOCKED';END IF;
 IF EXISTS(SELECT 1 FROM public.fin_voucher v LEFT JOIN public.fin_voucher_line l ON l.country_id=v.country_id AND l.voucher_id=v.id WHERE v.country_id=p_country AND v.book_id=p_book AND v.period_id=p_period GROUP BY v.id HAVING count(l.id)<2 OR sum(l.debit)<>sum(l.credit) OR sum(l.debit)<>v.total_debit OR sum(l.credit)<>v.total_credit) THEN RAISE EXCEPTION 'FIN_CLOSE_UNBALANCED';END IF;
 IF EXISTS(SELECT 1 FROM public.fin_voucher_line l JOIN public.fin_voucher v ON v.country_id=l.country_id AND v.id=l.voucher_id JOIN public.fin_account a ON a.country_id=l.country_id AND a.id=l.account_id WHERE v.country_id=p_country AND v.book_id=p_book AND v.period_id=p_period AND (a.is_cash OR a.is_bank) AND l.cashflow_item_id IS NULL) THEN RAISE EXCEPTION 'FIN_CASHFLOW_REQUIRED';END IF;
 IF jsonb_typeof(p_balance->'balances') IS DISTINCT FROM 'array' OR jsonb_typeof(p_balance->'postedLines') IS DISTINCT FROM 'array' OR jsonb_typeof(p_reconcile->'rows') IS DISTINCT FROM 'array' OR jsonb_array_length(p_reconcile->'rows')<>4 OR NOT(p_report ?& ARRAY['balance','income','cashflow']) OR EXISTS(SELECT 1 FROM jsonb_each(p_report) r WHERE r.value->'available' IS DISTINCT FROM 'true'::jsonb) THEN RAISE EXCEPTION 'FIN_CLOSE_SNAPSHOT_INCOMPLETE';END IF;
 PERFORM public.jxc_fin_assert_balance(id) FROM public.fin_account_balance WHERE country_id=p_country AND book_id=p_book AND period_id=p_period;
 IF EXISTS(SELECT 1 FROM (SELECT l.account_id,l.aux_key,l.currency FROM public.fin_voucher_line l JOIN public.fin_voucher v ON v.country_id=l.country_id AND v.id=l.voucher_id WHERE v.country_id=p_country AND v.book_id=p_book AND v.voucher_date<=p.end_date AND v.status IN ('POSTED','REVERSED') UNION SELECT account_id,aux_key,currency FROM public.fin_opening_balance WHERE country_id=p_country AND book_id=p_book AND cutoff_date<p.start_date AND status='CONFIRMED') d WHERE NOT EXISTS(SELECT 1 FROM public.fin_account_balance b WHERE b.country_id=p_country AND b.book_id=p_book AND b.period_id=p_period AND b.account_id=d.account_id AND b.aux_key=d.aux_key AND b.currency=d.currency)) THEN RAISE EXCEPTION 'FIN_BALANCE_PROJECTION_MISSING';END IF;
 IF (SELECT count(DISTINCT x->>'type') FROM jsonb_array_elements(p_reconcile->'rows') x WHERE x->>'type' IN ('AR','AP','INVENTORY','CASH'))<>4 THEN RAISE EXCEPTION 'FIN_CLOSE_SNAPSHOT_INCOMPLETE';END IF;
 SELECT count(*) INTO expected_count FROM public.fin_account_balance WHERE country_id=p_country AND book_id=p_book AND period_id=p_period;
 IF jsonb_array_length(p_balance->'balances')<>expected_count THEN RAISE EXCEPTION 'FIN_CLOSE_BALANCE_MISMATCH';END IF;
 SELECT count(*) INTO bad_count FROM jsonb_array_elements(p_balance->'balances') x LEFT JOIN public.fin_account_balance b ON b.country_id=p_country AND b.book_id=p_book AND b.period_id=p_period AND b.id=(x->>'id')::bigint WHERE b.id IS NULL OR NOT(x ?& ARRAY['id','accountId','auxKey','currency','openingDebit','openingCredit','periodDebit','periodCredit','closingDebit','closingCredit','origClosing']) OR (x->>'accountId')::bigint IS DISTINCT FROM b.account_id OR x->>'auxKey' IS DISTINCT FROM b.aux_key OR x->>'currency' IS DISTINCT FROM b.currency OR (x->>'openingDebit')::numeric IS DISTINCT FROM b.opening_debit OR (x->>'openingCredit')::numeric IS DISTINCT FROM b.opening_credit OR (x->>'periodDebit')::numeric IS DISTINCT FROM b.period_debit OR (x->>'periodCredit')::numeric IS DISTINCT FROM b.period_credit OR (x->>'closingDebit')::numeric IS DISTINCT FROM b.closing_debit OR (x->>'closingCredit')::numeric IS DISTINCT FROM b.closing_credit OR (x->>'origClosing')::numeric IS DISTINCT FROM b.orig_closing;
 IF bad_count<>0 OR (SELECT count(DISTINCT x->>'id') FROM jsonb_array_elements(p_balance->'balances') x)<>expected_count THEN RAISE EXCEPTION 'FIN_CLOSE_BALANCE_MISMATCH';END IF;
 IF EXISTS(SELECT 1 FROM public.fin_account_balance b WHERE b.country_id=p_country AND b.book_id=p_book AND b.period_id=p_period AND (b.closing_debit-b.closing_credit<>b.opening_debit-b.opening_credit+b.period_debit-b.period_credit)) THEN RAISE EXCEPTION 'FIN_CLOSE_BALANCE_MISMATCH';END IF;
 IF (SELECT coalesce(sum(closing_debit-closing_credit),0) FROM public.fin_account_balance WHERE country_id=p_country AND book_id=p_book AND period_id=p_period)<>0 THEN RAISE EXCEPTION 'FIN_CLOSE_UNBALANCED';END IF;
 SELECT count(*) INTO expected_count FROM public.fin_voucher_line l JOIN public.fin_voucher v ON v.country_id=l.country_id AND v.id=l.voucher_id WHERE v.country_id=p_country AND v.book_id=p_book AND v.period_id=p_period AND v.status IN ('POSTED','REVERSED');
 IF jsonb_array_length(p_balance->'postedLines')<>expected_count OR (SELECT count(DISTINCT x->>'id') FROM jsonb_array_elements(p_balance->'postedLines') x)<>expected_count THEN RAISE EXCEPTION 'FIN_CLOSE_LINES_MISMATCH';END IF;
 IF EXISTS(SELECT 1 FROM jsonb_array_elements(p_balance->'postedLines') x LEFT JOIN public.fin_voucher_line l ON l.country_id=p_country AND l.book_id=p_book AND l.id=(x->>'id')::bigint LEFT JOIN public.fin_voucher v ON v.country_id=l.country_id AND v.id=l.voucher_id AND v.period_id=p_period WHERE v.id IS NULL OR NOT(x ?& ARRAY['id','debit','credit','accountId']) OR (x->>'debit')::numeric IS DISTINCT FROM l.debit OR (x->>'credit')::numeric IS DISTINCT FROM l.credit OR (x->>'accountId')::bigint IS DISTINCT FROM l.account_id) THEN RAISE EXCEPTION 'FIN_CLOSE_LINES_MISMATCH';END IF;
 IF jsonb_typeof(p_checks) IS DISTINCT FROM 'array' OR NOT(p_checks @> '[{"checkCode":"REPORT_CONFIG","result":"PASS"}]'::jsonb) THEN RAISE EXCEPTION 'FIN_CLOSE_CHECKS_REQUIRED';END IF;
 IF EXISTS(SELECT 1 FROM unnest(ARRAY['UNPOSTED','UNBALANCED','EVENTS_OPEN','COST_PENDING','ALLOCATION_PENDING','STOCKTAKE_PENDING','RECON_DATA_MISSING','AR_DIFF','AP_DIFF','INV_DIFF','CASH_DIFF','CASHFLOW_MISSING','REPORT_CONFIG','NEXT_PERIOD']) c WHERE NOT EXISTS(SELECT 1 FROM jsonb_array_elements(p_checks) x WHERE x->>'checkCode'=c)) THEN RAISE EXCEPTION 'FIN_CLOSE_CHECKS_REQUIRED';END IF;
 FOR item IN SELECT * FROM jsonb_array_elements(p_checks) LOOP
  IF item->>'result' IS NULL OR item->>'result' NOT IN ('PASS','WAIVED') THEN RAISE EXCEPTION 'FIN_CLOSE_BLOCKED';END IF;
  IF item->>'result'='WAIVED' AND NOT EXISTS(SELECT 1 FROM public.fin_close_waiver w WHERE w.country_id=p_country AND w.book_id=p_book AND w.period_id=p_period AND w.close_generation=n AND w.check_code=item->>'checkCode' AND w.fingerprint=item->>'fingerprint') THEN RAISE EXCEPTION 'FIN_WAIVER_STALE';END IF;
 END LOOP;
 next_start:=p.end_date+1;SELECT id INTO next_id FROM public.fin_period WHERE country_id=p_country AND book_id=p_book AND start_date=next_start FOR UPDATE;
 IF next_id IS NULL THEN
  IF p.start_date<>date_trunc('month',p.start_date)::date OR p.end_date<>(date_trunc('month',p.start_date)+interval '1 month - 1 day')::date THEN RAISE EXCEPTION 'FIN_NEXT_PERIOD_REQUIRED';END IF;
  next_end:=(date_trunc('month',next_start)+interval '1 month - 1 day')::date;
  INSERT INTO public.fin_period(country_id,book_id,fiscal_year,period_no,start_date,end_date,status,created_by) VALUES(p_country,p_book,extract(year from next_start)::integer,extract(month from next_start)::integer,next_start,next_end,'OPEN',p_user) RETURNING id INTO next_id;
 ELSE
  IF EXISTS(SELECT 1 FROM public.fin_period WHERE id=next_id AND country_id=p_country AND status NOT IN ('OPEN','NOT_STARTED')) THEN RAISE EXCEPTION 'FIN_NEXT_PERIOD_NOT_OPEN';END IF;
  UPDATE public.fin_period SET status='OPEN',version=version+1,updated_by=p_user,updated_at=clock_timestamp() WHERE id=next_id AND country_id=p_country AND status='NOT_STARTED';
 END IF;
 INSERT INTO public.fin_close_generation(country_id,book_id,period_id,close_generation,source_fingerprint,checks,created_by) VALUES(p_country,p_book,p_period,n,p_fingerprint,p_checks,p_user);
 INSERT INTO public.fin_snapshot(country_id,book_id,period_id,close_generation,snapshot_type,content,source_versions,source_fingerprint,created_by) VALUES(p_country,p_book,p_period,n,'BALANCE',p_balance,p_sources,p_fingerprint,p_user),(p_country,p_book,p_period,n,'REPORT',p_report,p_sources,p_fingerprint,p_user),(p_country,p_book,p_period,n,'RECONCILE',p_reconcile,p_sources,p_fingerprint,p_user);
 UPDATE public.fin_period SET status='CLOSED',close_generation=n,closed_by=p_user,closed_at=clock_timestamp(),updated_by=p_user,updated_at=clock_timestamp(),version=version+1 WHERE country_id=p_country AND id=p_period;
 RETURN n;
END $$;
REVOKE ALL ON FUNCTION jxc_finalize_period(bigint,bigint,bigint,bigint,jsonb,jsonb,jsonb,jsonb,text,jsonb) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION jxc_finalize_period(bigint,bigint,bigint,bigint,jsonb,jsonb,jsonb,jsonb,text,jsonb) TO "${runtimeRole}";

CREATE FUNCTION jxc_reopen_period(p_country bigint,p_book bigint,p_period bigint,p_user bigint,p_reason text,p_dependencies jsonb)
RETURNS bigint LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE p public.fin_period;refs jsonb;waivers jsonb;log_id bigint;
BEGIN
 IF p_country IS DISTINCT FROM public.jxc_current_country_id() THEN RAISE EXCEPTION 'SYS_COUNTRY_REQUIRED';END IF;
 IF length(btrim(coalesce(p_reason,'')))=0 OR length(p_reason)>1000 THEN RAISE EXCEPTION 'FIN_REOPEN_REASON_REQUIRED';END IF;
 PERFORM 1 FROM public.fin_book WHERE country_id=p_country AND id=p_book AND status='ACTIVE' FOR UPDATE;IF NOT FOUND THEN RAISE EXCEPTION 'FIN_BOOK_NOT_ACTIVE';END IF;
 SELECT * INTO p FROM public.fin_period WHERE country_id=p_country AND book_id=p_book AND id=p_period FOR UPDATE;IF NOT FOUND THEN RAISE EXCEPTION 'FIN_PERIOD_NOT_FOUND';END IF;
 IF p.status<>'CLOSED' THEN RAISE EXCEPTION 'FIN_PERIOD_NOT_CLOSED';END IF;
 IF EXISTS(SELECT 1 FROM public.fin_period WHERE country_id=p_country AND book_id=p_book AND start_date>p.end_date AND status='CLOSED') THEN RAISE EXCEPTION 'FIN_LATER_CLOSED';END IF;
 SELECT coalesce(jsonb_agg(id ORDER BY id),'[]') INTO refs FROM public.fin_snapshot WHERE country_id=p_country AND book_id=p_book AND period_id=p_period AND close_generation=p.close_generation;
 SELECT coalesce(jsonb_agg(id ORDER BY id),'[]') INTO waivers FROM public.fin_close_waiver WHERE country_id=p_country AND book_id=p_book AND period_id=p_period AND close_generation<=p.close_generation;
 INSERT INTO public.fin_reopen_log(country_id,book_id,period_id,previous_generation,reason,snapshot_refs,dependencies,invalidated_waiver_ids,operated_by) VALUES(p_country,p_book,p_period,p.close_generation,p_reason,refs,p_dependencies,waivers,p_user) RETURNING id INTO log_id;
 UPDATE public.fin_period SET status='OPEN',closed_by=NULL,closed_at=NULL,updated_by=p_user,updated_at=clock_timestamp(),version=version+1 WHERE country_id=p_country AND id=p_period;
 RETURN log_id;
END $$;
REVOKE ALL ON FUNCTION jxc_reopen_period(bigint,bigint,bigint,bigint,text,jsonb) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION jxc_reopen_period(bigint,bigint,bigint,bigint,text,jsonb) TO "${runtimeRole}";
