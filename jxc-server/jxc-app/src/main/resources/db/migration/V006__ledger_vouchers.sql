-- M3 ledger. Empty configuration only; all facts require explicit authorized commands.
CREATE TABLE fin_account (
 id jxc_safe_id PRIMARY KEY DEFAULT nextval('jxc_id_seq'),country_id jxc_safe_id NOT NULL,book_id jxc_safe_id NOT NULL,
 code varchar(64) NOT NULL CHECK(btrim(code)<>''),name varchar(200) NOT NULL CHECK(btrim(name)<>''),parent_id jxc_safe_id,level int NOT NULL DEFAULT 1 CHECK(level>0),
 category varchar(16) NOT NULL CHECK(category IN ('ASSET','LIABILITY','EQUITY','COST','EXPENSE','INCOME','PROFIT_LOSS')),direction varchar(8) NOT NULL CHECK(direction IN ('DEBIT','CREDIT')),
 is_leaf boolean NOT NULL DEFAULT true,fx_enabled boolean NOT NULL DEFAULT false,is_cash boolean NOT NULL DEFAULT false,is_bank boolean NOT NULL DEFAULT false,
 aux_types jsonb NOT NULL DEFAULT '[]' CHECK(jsonb_typeof(aux_types)='array'),reconcile_type varchar(16) CHECK(reconcile_type IN ('AR','AP','INVENTORY','CASH')),
 status varchar(16) NOT NULL DEFAULT 'ENABLED' CHECK(status IN ('ENABLED','DISABLED')),version int NOT NULL DEFAULT 1 CHECK(version>0),
 UNIQUE(country_id,id),UNIQUE(country_id,book_id,id),UNIQUE(country_id,book_id,code),FOREIGN KEY(country_id,book_id) REFERENCES fin_book(country_id,id),FOREIGN KEY(country_id,book_id,parent_id) REFERENCES fin_account(country_id,book_id,id),CHECK(NOT(is_cash AND is_bank))
);
CREATE TABLE fin_cashflow_item (
 id jxc_safe_id PRIMARY KEY DEFAULT nextval('jxc_id_seq'),country_id jxc_safe_id NOT NULL,book_id jxc_safe_id NOT NULL,code varchar(64) NOT NULL,name varchar(200) NOT NULL,
 category varchar(16) NOT NULL CHECK(category IN ('OPERATING','INVESTING','FINANCING')),direction varchar(8) NOT NULL CHECK(direction IN ('IN','OUT','BOTH','DEBIT','CREDIT')),
 status varchar(16) NOT NULL DEFAULT 'ENABLED' CHECK(status IN ('ENABLED','DISABLED')),version int NOT NULL DEFAULT 1,
 UNIQUE(country_id,id),UNIQUE(country_id,book_id,id),UNIQUE(country_id,book_id,code),FOREIGN KEY(country_id,book_id) REFERENCES fin_book(country_id,id)
);
CREATE TABLE fin_voucher_word (
 id jxc_safe_id PRIMARY KEY DEFAULT nextval('jxc_id_seq'),country_id jxc_safe_id NOT NULL,book_id jxc_safe_id NOT NULL,code varchar(32) NOT NULL,name varchar(100) NOT NULL,number_rule varchar(200) NOT NULL DEFAULT 'DATE_SEQUENCE',status varchar(16) NOT NULL DEFAULT 'ENABLED' CHECK(status IN ('ENABLED','DISABLED')),version int NOT NULL DEFAULT 1,
 UNIQUE(country_id,id),UNIQUE(country_id,book_id,id),UNIQUE(country_id,book_id,code),FOREIGN KEY(country_id,book_id) REFERENCES fin_book(country_id,id)
);
CREATE TABLE fin_category_account_map (
 id jxc_safe_id PRIMARY KEY DEFAULT nextval('jxc_id_seq'),country_id jxc_safe_id NOT NULL,book_id jxc_safe_id NOT NULL,category_id jxc_safe_id NOT NULL REFERENCES md_category(id),purpose varchar(16) NOT NULL CHECK(purpose IN ('INVENTORY','REVENUE','COGS')),account_id jxc_safe_id NOT NULL,version int NOT NULL DEFAULT 1,
 UNIQUE(country_id,id),UNIQUE(country_id,book_id,category_id,purpose),FOREIGN KEY(country_id,book_id) REFERENCES fin_book(country_id,id),FOREIGN KEY(country_id,book_id,account_id) REFERENCES fin_account(country_id,book_id,id)
);
CREATE TABLE fin_opening_balance (
 id jxc_safe_id PRIMARY KEY DEFAULT nextval('jxc_id_seq'),country_id jxc_safe_id NOT NULL,book_id jxc_safe_id NOT NULL,account_id jxc_safe_id NOT NULL,
 aux jsonb NOT NULL DEFAULT '{}' CHECK(jsonb_typeof(aux)='object' AND jxc_json_ids_safe(aux)),aux_key text NOT NULL DEFAULT '{}' CHECK(aux_key=aux::text),currency varchar(3) NOT NULL REFERENCES md_currency(code),orig_amount numeric(20,4) NOT NULL CHECK(orig_amount>=0),rate numeric(18,8) NOT NULL DEFAULT 1 CHECK(rate>0),base_amount numeric(20,4) NOT NULL CHECK(base_amount>=0),direction varchar(8) NOT NULL CHECK(direction IN ('DEBIT','CREDIT')),cutoff_date date NOT NULL,
 status varchar(16) NOT NULL DEFAULT 'DRAFT' CHECK(status IN ('DRAFT','CONFIRMED')),version int NOT NULL DEFAULT 1,created_by jxc_safe_id NOT NULL REFERENCES sys_user(id),confirmed_by jxc_safe_id REFERENCES sys_user(id),confirmed_at timestamptz,
 UNIQUE(country_id,id),UNIQUE(country_id,book_id,account_id,aux_key,currency),FOREIGN KEY(country_id,book_id) REFERENCES fin_book(country_id,id),FOREIGN KEY(country_id,book_id,account_id) REFERENCES fin_account(country_id,book_id,id)
);
CREATE TABLE fin_voucher (
 id jxc_safe_id PRIMARY KEY DEFAULT nextval('jxc_id_seq'),country_id jxc_safe_id NOT NULL,book_id jxc_safe_id NOT NULL,period_id jxc_safe_id NOT NULL,word_id jxc_safe_id,voucher_no varchar(120) NOT NULL,voucher_date date NOT NULL,summary varchar(1000) NOT NULL DEFAULT '',
 source_kind varchar(16) NOT NULL CHECK(source_kind IN ('MANUAL','AUTO','REVERSAL','ADJUST')),source_event_id jxc_safe_id,mapping_template_id jxc_safe_id,mapping_version int,
 status varchar(24) NOT NULL CHECK(status IN ('DRAFT','PENDING_AUDIT','AUDITED','POSTED','REVERSED')),total_debit numeric(20,4) NOT NULL,total_credit numeric(20,4) NOT NULL,
 prepared_by jxc_safe_id NOT NULL REFERENCES sys_user(id),audited_by jxc_safe_id REFERENCES sys_user(id),audited_at timestamptz,posted_by jxc_safe_id REFERENCES sys_user(id),posted_at timestamptz,
 reversal_of_id jxc_safe_id,reversed_by_id jxc_safe_id,reason varchar(1000) NOT NULL DEFAULT '',unaudit_reason varchar(1000),version int NOT NULL DEFAULT 1 CHECK(version>0),created_at timestamptz NOT NULL DEFAULT clock_timestamp(),updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 UNIQUE(country_id,id),UNIQUE(country_id,book_id,id),UNIQUE(country_id,book_id,voucher_no),UNIQUE(country_id,source_event_id),UNIQUE(country_id,reversal_of_id),
 FOREIGN KEY(country_id,book_id) REFERENCES fin_book(country_id,id),FOREIGN KEY(country_id,book_id,period_id) REFERENCES fin_period(country_id,book_id,id),FOREIGN KEY(country_id,book_id,word_id) REFERENCES fin_voucher_word(country_id,book_id,id),FOREIGN KEY(country_id,source_event_id) REFERENCES sys_biz_event(country_id,id),
 FOREIGN KEY(country_id,book_id,reversal_of_id) REFERENCES fin_voucher(country_id,book_id,id),FOREIGN KEY(country_id,book_id,reversed_by_id) REFERENCES fin_voucher(country_id,book_id,id),CHECK(total_debit=total_credit),CHECK(audited_by IS NULL OR audited_by<>prepared_by),CHECK((source_kind='REVERSAL')=(reversal_of_id IS NOT NULL))
);
CREATE TABLE fin_voucher_line (
 id jxc_safe_id PRIMARY KEY DEFAULT nextval('jxc_id_seq'),country_id jxc_safe_id NOT NULL,book_id jxc_safe_id NOT NULL,voucher_id jxc_safe_id NOT NULL,seq int NOT NULL CHECK(seq>0),summary varchar(1000) NOT NULL DEFAULT '',account_id jxc_safe_id NOT NULL,
 aux jsonb NOT NULL DEFAULT '{}' CHECK(jsonb_typeof(aux)='object' AND jxc_json_ids_safe(aux)),aux_key text NOT NULL DEFAULT '{}' CHECK(aux_key=aux::text),currency varchar(3) NOT NULL REFERENCES md_currency(code),orig_amount numeric(20,4) NOT NULL,rate numeric(18,8) NOT NULL CHECK(rate>0),debit numeric(20,4) NOT NULL DEFAULT 0,credit numeric(20,4) NOT NULL DEFAULT 0,cashflow_item_id jxc_safe_id,source_doc_type varchar(64),source_doc_id jxc_safe_id,
 UNIQUE(country_id,id),UNIQUE(country_id,voucher_id,seq),FOREIGN KEY(country_id,book_id,voucher_id) REFERENCES fin_voucher(country_id,book_id,id),FOREIGN KEY(country_id,book_id,account_id) REFERENCES fin_account(country_id,book_id,id),FOREIGN KEY(country_id,book_id,cashflow_item_id) REFERENCES fin_cashflow_item(country_id,book_id,id),CHECK((debit=0)<>(credit=0))
);
CREATE TABLE fin_account_balance (
 id jxc_safe_id PRIMARY KEY DEFAULT nextval('jxc_id_seq'),country_id jxc_safe_id NOT NULL,book_id jxc_safe_id NOT NULL,period_id jxc_safe_id NOT NULL,account_id jxc_safe_id NOT NULL,aux jsonb NOT NULL DEFAULT '{}' CHECK(jsonb_typeof(aux)='object'),aux_key text NOT NULL DEFAULT '{}' CHECK(aux_key=aux::text),currency varchar(3) NOT NULL REFERENCES md_currency(code),
 opening_debit numeric(20,4) NOT NULL DEFAULT 0,opening_credit numeric(20,4) NOT NULL DEFAULT 0,period_debit numeric(20,4) NOT NULL DEFAULT 0,period_credit numeric(20,4) NOT NULL DEFAULT 0,closing_debit numeric(20,4) NOT NULL DEFAULT 0,closing_credit numeric(20,4) NOT NULL DEFAULT 0,orig_closing numeric(20,4) NOT NULL DEFAULT 0,version int NOT NULL DEFAULT 1,
 UNIQUE(country_id,id),UNIQUE(country_id,book_id,period_id,account_id,aux_key,currency),FOREIGN KEY(country_id,book_id) REFERENCES fin_book(country_id,id),FOREIGN KEY(country_id,book_id,period_id) REFERENCES fin_period(country_id,book_id,id),FOREIGN KEY(country_id,book_id,account_id) REFERENCES fin_account(country_id,book_id,id),CHECK(opening_debit>=0 AND opening_credit>=0 AND closing_debit>=0 AND closing_credit>=0),CHECK(opening_debit=0 OR opening_credit=0),CHECK(closing_debit=0 OR closing_credit=0),CHECK(closing_debit-closing_credit=opening_debit-opening_credit+period_debit-period_credit)
);
ALTER TABLE md_fund_account ADD FOREIGN KEY(country_id,book_id,gl_account_id) REFERENCES fin_account(country_id,book_id,id);
ALTER TABLE md_expense_item ADD COLUMN account_id jxc_safe_id;
ALTER TABLE md_expense_item ADD FOREIGN KEY(country_id,account_id) REFERENCES fin_account(country_id,id);

CREATE FUNCTION jxc_fin_voucher_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF TG_OP='DELETE' THEN IF OLD.status<>'DRAFT' OR OLD.source_kind<>'MANUAL' THEN RAISE EXCEPTION 'FIN_POSTED_LOCKED';END IF;PERFORM jxc_assert_period_open(OLD.country_id,OLD.book_id,OLD.voucher_date);RETURN OLD;END IF;
 IF TG_OP='UPDATE' AND OLD.status IN ('POSTED','REVERSED') THEN
  IF (to_jsonb(NEW)-ARRAY['status','reversed_by_id','version','updated_at']) IS DISTINCT FROM (to_jsonb(OLD)-ARRAY['status','reversed_by_id','version','updated_at']) OR NOT(OLD.status='POSTED' AND NEW.status='REVERSED' AND NEW.reversed_by_id IS NOT NULL AND EXISTS(SELECT 1 FROM fin_voucher r WHERE r.country_id=OLD.country_id AND r.book_id=OLD.book_id AND r.id=NEW.reversed_by_id AND r.reversal_of_id=OLD.id AND r.status='POSTED')) THEN RAISE EXCEPTION 'FIN_POSTED_LOCKED';END IF;RETURN NEW;
 END IF;
 IF TG_OP='UPDATE' THEN PERFORM jxc_assert_period_open(OLD.country_id,OLD.book_id,OLD.voucher_date);END IF;
 PERFORM jxc_assert_period_open(NEW.country_id,NEW.book_id,NEW.voucher_date);
 IF EXISTS(SELECT 1 FROM fin_opening_balance o WHERE o.country_id=NEW.country_id AND o.book_id=NEW.book_id AND o.status='CONFIRMED' AND o.cutoff_date>=NEW.voucher_date) THEN RAISE EXCEPTION 'FIN_OPENING_CUTOFF';END IF;
 IF NOT EXISTS(SELECT 1 FROM fin_period p WHERE p.country_id=NEW.country_id AND p.book_id=NEW.book_id AND p.id=NEW.period_id AND NEW.voucher_date BETWEEN p.start_date AND p.end_date) THEN RAISE EXCEPTION 'FIN_PERIOD_MISMATCH';END IF;
 IF TG_OP='UPDATE' AND OLD.status<>'DRAFT' AND (to_jsonb(NEW)-ARRAY['status','audited_by','audited_at','posted_by','posted_at','unaudit_reason','version','updated_at']) IS DISTINCT FROM (to_jsonb(OLD)-ARRAY['status','audited_by','audited_at','posted_by','posted_at','unaudit_reason','version','updated_at']) THEN RAISE EXCEPTION 'FIN_POSTED_LOCKED';END IF;
 IF NEW.status IN ('AUDITED','POSTED','REVERSED') AND (NEW.audited_by IS NULL OR NEW.audited_by=NEW.prepared_by) THEN RAISE EXCEPTION 'FIN_AUDITOR_CONFLICT';END IF;
 IF NEW.status='POSTED' AND (NEW.posted_by IS NULL OR NEW.posted_at IS NULL OR TG_OP='INSERT' OR OLD.status<>'AUDITED') THEN RAISE EXCEPTION 'FIN_STATUS_CONFLICT';END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER fin_voucher_guard BEFORE INSERT OR UPDATE OR DELETE ON fin_voucher FOR EACH ROW EXECUTE FUNCTION jxc_fin_voucher_guard();
CREATE FUNCTION jxc_fin_line_guard() RETURNS trigger LANGUAGE plpgsql AS $$ DECLARE h fin_voucher;BEGIN
 SELECT * INTO h FROM fin_voucher WHERE country_id=COALESCE(NEW.country_id,OLD.country_id) AND id=COALESCE(NEW.voucher_id,OLD.voucher_id) FOR UPDATE;
 IF h.status IN ('POSTED','REVERSED') OR TG_OP='UPDATE' OR (TG_OP='DELETE' AND h.status<>'DRAFT') THEN RAISE EXCEPTION 'FIN_POSTED_LOCKED';END IF;
 PERFORM jxc_assert_period_open(h.country_id,h.book_id,h.voucher_date);RETURN COALESCE(NEW,OLD);
END $$;
CREATE TRIGGER fin_line_guard BEFORE INSERT OR UPDATE OR DELETE ON fin_voucher_line FOR EACH ROW EXECUTE FUNCTION jxc_fin_line_guard();
CREATE FUNCTION jxc_fin_balanced() RETURNS trigger LANGUAGE plpgsql AS $$ DECLARE h fin_voucher;d numeric;c numeric;n int;BEGIN
 SELECT * INTO h FROM fin_voucher WHERE country_id=COALESCE(NEW.country_id,OLD.country_id) AND id=COALESCE((to_jsonb(NEW)->>CASE WHEN TG_TABLE_NAME='fin_voucher' THEN 'id' ELSE 'voucher_id' END)::bigint,(to_jsonb(OLD)->>CASE WHEN TG_TABLE_NAME='fin_voucher' THEN 'id' ELSE 'voucher_id' END)::bigint);
 IF NOT FOUND THEN RETURN NULL;END IF;
 SELECT count(*),COALESCE(sum(debit),0),COALESCE(sum(credit),0) INTO n,d,c FROM fin_voucher_line WHERE country_id=h.country_id AND voucher_id=h.id;
 IF n<2 OR d<>c OR d<>h.total_debit OR c<>h.total_credit THEN RAISE EXCEPTION 'FIN_UNBALANCED';END IF;RETURN NULL;
END $$;
CREATE CONSTRAINT TRIGGER fin_voucher_balanced AFTER INSERT OR UPDATE ON fin_voucher DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION jxc_fin_balanced();
CREATE CONSTRAINT TRIGGER fin_lines_balanced AFTER INSERT OR DELETE ON fin_voucher_line DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION jxc_fin_balanced();
CREATE FUNCTION jxc_fin_opening_guard() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
 IF OLD.status='CONFIRMED' THEN RAISE EXCEPTION 'FIN_OPENING_LOCKED';END IF;RETURN COALESCE(NEW,OLD);END $$;
CREATE TRIGGER fin_opening_guard BEFORE UPDATE OR DELETE ON fin_opening_balance FOR EACH ROW EXECUTE FUNCTION jxc_fin_opening_guard();
CREATE FUNCTION jxc_fin_account_guard() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
 IF TG_OP='DELETE' AND EXISTS(SELECT 1 FROM fin_voucher_line WHERE country_id=OLD.country_id AND account_id=OLD.id) THEN RAISE EXCEPTION 'FIN_ACCOUNT_REFERENCED';END IF;
 IF TG_OP='UPDATE' AND (NEW.direction<>OLD.direction OR NEW.aux_types<>OLD.aux_types OR NEW.fx_enabled<>OLD.fx_enabled OR NEW.is_cash<>OLD.is_cash OR NEW.is_bank<>OLD.is_bank OR NEW.is_leaf<>OLD.is_leaf OR NEW.reconcile_type IS DISTINCT FROM OLD.reconcile_type) AND (EXISTS(SELECT 1 FROM fin_voucher_line WHERE country_id=OLD.country_id AND account_id=OLD.id) OR EXISTS(SELECT 1 FROM fin_opening_balance WHERE country_id=OLD.country_id AND account_id=OLD.id)) THEN RAISE EXCEPTION 'FIN_ACCOUNT_REFERENCED';END IF;RETURN COALESCE(NEW,OLD);END $$;
CREATE TRIGGER fin_account_guard BEFORE UPDATE OR DELETE ON fin_account FOR EACH ROW EXECUTE FUNCTION jxc_fin_account_guard();
DO $$ DECLARE t text;BEGIN FOREACH t IN ARRAY ARRAY['fin_account','fin_cashflow_item','fin_voucher_word','fin_category_account_map','fin_opening_balance','fin_voucher','fin_voucher_line','fin_account_balance'] LOOP
 EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY',t);EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY',t);EXECUTE format('CREATE POLICY country_isolation ON %I USING(country_id=jxc_current_country_id()) WITH CHECK(country_id=jxc_current_country_id())',t);
 END LOOP;END $$;
GRANT SELECT,INSERT,UPDATE,DELETE ON fin_account,fin_cashflow_item,fin_voucher_word,fin_category_account_map,fin_opening_balance,fin_voucher TO "${runtimeRole}";
GRANT SELECT,INSERT,DELETE ON fin_voucher_line TO "${runtimeRole}";
GRANT SELECT,INSERT,UPDATE ON fin_account_balance TO "${runtimeRole}";

-- Projection writes are accepted only when they agree with immutable posted entries and confirmed openings.
CREATE FUNCTION jxc_fin_assert_balance(p_id bigint) RETURNS void LANGUAGE plpgsql AS $$
DECLARE b fin_account_balance;p fin_period;op numeric;pd numeric;pc numeric;original numeric;opening_original numeric;ob numeric;
BEGIN
 SELECT * INTO b FROM fin_account_balance WHERE id=p_id;IF NOT FOUND THEN RETURN;END IF;
 SELECT * INTO p FROM fin_period WHERE country_id=b.country_id AND book_id=b.book_id AND id=b.period_id;
 SELECT COALESCE(sum(l.debit-l.credit) FILTER(WHERE v.voucher_date<p.start_date),0),COALESCE(sum(l.debit) FILTER(WHERE v.period_id=p.id),0),COALESCE(sum(l.credit) FILTER(WHERE v.period_id=p.id),0),COALESCE(sum(CASE WHEN l.debit<>0 THEN l.orig_amount ELSE -l.orig_amount END),0) INTO op,pd,pc,original
 FROM fin_voucher_line l JOIN fin_voucher v ON v.country_id=l.country_id AND v.id=l.voucher_id WHERE l.country_id=b.country_id AND l.book_id=b.book_id AND l.account_id=b.account_id AND l.aux_key=b.aux_key AND l.currency=b.currency AND v.status IN ('POSTED','REVERSED') AND v.voucher_date<=p.end_date;
 SELECT COALESCE(sum(CASE WHEN direction='DEBIT' THEN base_amount ELSE -base_amount END),0),COALESCE(sum(CASE WHEN direction='DEBIT' THEN orig_amount ELSE -orig_amount END),0) INTO ob,opening_original FROM fin_opening_balance WHERE country_id=b.country_id AND book_id=b.book_id AND account_id=b.account_id AND aux_key=b.aux_key AND currency=b.currency AND status='CONFIRMED' AND cutoff_date<p.start_date;
 IF b.opening_debit-b.opening_credit<>op+ob OR b.period_debit<>pd OR b.period_credit<>pc OR b.orig_closing<>original+opening_original THEN RAISE EXCEPTION 'FIN_BALANCE_FACT_MISMATCH';END IF;
END $$;
CREATE FUNCTION jxc_fin_balance_fact_guard() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN PERFORM jxc_fin_assert_balance(NEW.id);RETURN NULL;END $$;
CREATE CONSTRAINT TRIGGER fin_balance_fact_guard AFTER INSERT OR UPDATE ON fin_account_balance DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION jxc_fin_balance_fact_guard();
CREATE FUNCTION jxc_fin_posting_projection_guard() RETURNS trigger LANGUAGE plpgsql AS $$ DECLARE v fin_voucher;r record;balance_id bigint;BEGIN
 SELECT * INTO v FROM fin_voucher WHERE country_id=NEW.country_id AND id=NEW.id;IF NOT FOUND OR v.status NOT IN ('POSTED','REVERSED') THEN RETURN NULL;END IF;
 FOR r IN SELECT DISTINCT p.id period_id,l.account_id,l.aux_key,l.currency FROM fin_voucher_line l JOIN fin_period p ON p.country_id=l.country_id AND p.book_id=l.book_id AND (p.id=v.period_id OR p.start_date>v.voucher_date AND p.status IN ('OPEN','PENDING_CLOSE')) WHERE l.country_id=v.country_id AND l.voucher_id=v.id LOOP
  SELECT id INTO balance_id FROM fin_account_balance WHERE country_id=v.country_id AND book_id=v.book_id AND period_id=r.period_id AND account_id=r.account_id AND aux_key=r.aux_key AND currency=r.currency;
  IF NOT FOUND THEN RAISE EXCEPTION 'FIN_BALANCE_PROJECTION_MISSING';END IF;PERFORM jxc_fin_assert_balance(balance_id);
 END LOOP;RETURN NULL;
END $$;
CREATE CONSTRAINT TRIGGER fin_posting_projection_guard AFTER INSERT OR UPDATE ON fin_voucher DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION jxc_fin_posting_projection_guard();

-- A confirmed opening is also a ledger fact: serialize it with posting and require
-- its whole book projection at commit, including rows the caller never writes.
CREATE FUNCTION jxc_fin_opening_confirmation_gate() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
 IF NEW.status='CONFIRMED' THEN PERFORM id FROM fin_book WHERE country_id=NEW.country_id AND id=NEW.book_id FOR UPDATE;END IF;RETURN NEW;
END $$;
CREATE TRIGGER fin_opening_confirmation_gate BEFORE INSERT OR UPDATE ON fin_opening_balance FOR EACH ROW EXECUTE FUNCTION jxc_fin_opening_confirmation_gate();
CREATE FUNCTION jxc_fin_opening_projection_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE o fin_opening_balance;cutoffs int;cutoff date;net numeric;r record;balance_id bigint;
BEGIN
 SELECT * INTO o FROM fin_opening_balance WHERE country_id=NEW.country_id AND id=NEW.id;
 IF NOT FOUND OR o.status<>'CONFIRMED' THEN RETURN NULL;END IF;
 IF EXISTS(SELECT 1 FROM fin_opening_balance WHERE country_id=o.country_id AND book_id=o.book_id AND status='CONFIRMED' AND (confirmed_by IS NULL OR confirmed_at IS NULL)) THEN RAISE EXCEPTION 'FIN_OPENING_CONFIRMATION_REQUIRED';END IF;
 SELECT count(DISTINCT cutoff_date),min(cutoff_date),COALESCE(sum(CASE WHEN direction='DEBIT' THEN base_amount ELSE -base_amount END),0) INTO cutoffs,cutoff,net FROM fin_opening_balance WHERE country_id=o.country_id AND book_id=o.book_id AND status='CONFIRMED';
 IF net<>0 THEN RAISE EXCEPTION 'FIN_UNBALANCED';END IF;
 IF cutoffs<>1 THEN RAISE EXCEPTION 'FIN_OPENING_CUTOFF_MISMATCH';END IF;
 IF NOT EXISTS(SELECT 1 FROM fin_period WHERE country_id=o.country_id AND book_id=o.book_id AND start_date=cutoff+1 AND status='OPEN') THEN RAISE EXCEPTION 'FIN_OPENING_PERIOD';END IF;
 PERFORM jxc_assert_period_open(o.country_id,o.book_id,cutoff+1);
 IF EXISTS(SELECT 1 FROM fin_voucher WHERE country_id=o.country_id AND book_id=o.book_id AND status IN ('POSTED','REVERSED') AND voucher_date<=cutoff) THEN RAISE EXCEPTION 'FIN_OPENING_CUTOFF';END IF;
 IF EXISTS(SELECT 1 FROM fin_voucher WHERE country_id=o.country_id AND book_id=o.book_id AND status IN ('POSTED','REVERSED')) THEN RAISE EXCEPTION 'FIN_OPENING_LOCKED';END IF;
 FOR r IN SELECT DISTINCT p.id period_id,b.account_id,b.aux_key,b.currency FROM fin_opening_balance b JOIN fin_period p ON p.country_id=b.country_id AND p.book_id=b.book_id AND p.start_date>cutoff WHERE b.country_id=o.country_id AND b.book_id=o.book_id AND b.status='CONFIRMED' LOOP
  SELECT id INTO balance_id FROM fin_account_balance WHERE country_id=o.country_id AND book_id=o.book_id AND period_id=r.period_id AND account_id=r.account_id AND aux_key=r.aux_key AND currency=r.currency;
  IF NOT FOUND THEN RAISE EXCEPTION 'FIN_BALANCE_PROJECTION_MISSING';END IF;PERFORM jxc_fin_assert_balance(balance_id);
 END LOOP;RETURN NULL;
END $$;
CREATE CONSTRAINT TRIGGER fin_opening_projection_guard AFTER INSERT OR UPDATE ON fin_opening_balance DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION jxc_fin_opening_projection_guard();
