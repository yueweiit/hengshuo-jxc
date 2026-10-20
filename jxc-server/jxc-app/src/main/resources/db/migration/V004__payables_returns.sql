-- M2 payable and return facts. All public identifiers are country scoped.

CREATE TABLE ap_source_capacity (
 id jxc_safe_id PRIMARY KEY DEFAULT nextval('jxc_id_seq'),
 country_id jxc_safe_id NOT NULL REFERENCES sys_country(id),
 entity_id jxc_safe_id NOT NULL, book_id jxc_safe_id NOT NULL, source_type varchar(32) NOT NULL, source_id jxc_safe_id NOT NULL, original_qty numeric(24,6) NOT NULL CHECK(original_qty>0), original_amount numeric(24,6) NOT NULL CHECK(original_amount>0), current_max_qty numeric(24,6) NOT NULL CHECK(current_max_qty>0), current_max_amount numeric(24,6) NOT NULL CHECK(current_max_amount>0), claimed_qty numeric(24,6) NOT NULL DEFAULT 0, claimed_amount numeric(24,6) NOT NULL DEFAULT 0,
 version integer NOT NULL DEFAULT 1 CHECK(version>0),
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 UNIQUE(country_id,id),FOREIGN KEY(country_id,entity_id,book_id) REFERENCES fin_book(country_id,entity_id,id),UNIQUE(country_id,source_type,source_id),CHECK(claimed_qty BETWEEN 0 AND current_max_qty),CHECK(claimed_amount BETWEEN 0 AND current_max_amount)
);

CREATE TABLE ap_bill (
 id jxc_safe_id PRIMARY KEY DEFAULT nextval('jxc_id_seq'),
 country_id jxc_safe_id NOT NULL REFERENCES sys_country(id),
 entity_id jxc_safe_id NOT NULL, book_id jxc_safe_id NOT NULL, partner_type varchar(16) NOT NULL CHECK(partner_type IN ('SUPPLIER','CARRIER')), partner_id jxc_safe_id NOT NULL, doc_no varchar(64) NOT NULL, bill_type varchar(16) NOT NULL CHECK(bill_type IN ('PURCHASE','LOGISTICS','OTHER')), currency varchar(3) NOT NULL REFERENCES md_currency(code), amount numeric(24,6) NOT NULL CHECK(amount>0), paid_amount numeric(24,6) NOT NULL DEFAULT 0, bill_date date NOT NULL, due_date date NOT NULL, partner_invoice_no varchar(128) NOT NULL DEFAULT '', status varchar(24) NOT NULL DEFAULT 'DRAFT' CHECK(status IN ('DRAFT','CONFIRMED','PARTIAL_PAID','PAID','VOIDED')), base_currency varchar(3), rate_id jxc_safe_id, rate numeric(24,10) CHECK(rate>0), rate_date date, base_amount numeric(24,6), valuation_status varchar(32) NOT NULL DEFAULT 'PENDING_RATE' CHECK(valuation_status IN ('PENDING_RATE','READY')),
 version integer NOT NULL DEFAULT 1 CHECK(version>0),
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 UNIQUE(country_id,id),FOREIGN KEY(country_id,entity_id,book_id) REFERENCES fin_book(country_id,entity_id,id),UNIQUE(country_id,doc_no),CHECK(paid_amount BETWEEN 0 AND amount),CHECK(valuation_status<>'READY' OR (rate IS NOT NULL AND base_currency IS NOT NULL AND base_amount IS NOT NULL))
);

CREATE TABLE ap_bill_line (
 id jxc_safe_id PRIMARY KEY DEFAULT nextval('jxc_id_seq'),
 country_id jxc_safe_id NOT NULL REFERENCES sys_country(id),
 bill_id jxc_safe_id NOT NULL, source_type varchar(32) NOT NULL CHECK(source_type IN ('PUR_ORDER_LINE','PUR_RECEIPT_LINE','LGS_FEE')), source_id jxc_safe_id NOT NULL, product_id jxc_safe_id, qty numeric(24,6) NOT NULL CHECK(qty>0), unit_price numeric(24,10) NOT NULL CHECK(unit_price>=0), amount numeric(24,6) NOT NULL CHECK(amount>0), canonical_source_type varchar(32) NOT NULL, canonical_source_id jxc_safe_id NOT NULL,
 version integer NOT NULL DEFAULT 1 CHECK(version>0),
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 UNIQUE(country_id,id),FOREIGN KEY(country_id,bill_id) REFERENCES ap_bill(country_id,id),UNIQUE(country_id,bill_id,source_type,source_id)
);

CREATE TABLE ap_source_claim (
 id jxc_safe_id PRIMARY KEY DEFAULT nextval('jxc_id_seq'),
 country_id jxc_safe_id NOT NULL REFERENCES sys_country(id),
 bill_id jxc_safe_id NOT NULL, bill_line_id jxc_safe_id NOT NULL, source_type varchar(32) NOT NULL, source_id jxc_safe_id NOT NULL, qty numeric(24,6) NOT NULL CHECK(qty>0), amount numeric(24,6) NOT NULL CHECK(amount>0), effective boolean NOT NULL DEFAULT true,
 version integer NOT NULL DEFAULT 1 CHECK(version>0),
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 UNIQUE(country_id,id),FOREIGN KEY(country_id,bill_id) REFERENCES ap_bill(country_id,id),FOREIGN KEY(country_id,bill_line_id) REFERENCES ap_bill_line(country_id,id),FOREIGN KEY(country_id,source_type,source_id) REFERENCES ap_source_capacity(country_id,source_type,source_id),UNIQUE(country_id,bill_line_id,source_type,source_id)
);

CREATE UNIQUE INDEX ap_fee_claim_once ON ap_source_claim(country_id,source_type,source_id) WHERE effective AND source_type='LGS_FEE';

CREATE TABLE ap_payment (
 id jxc_safe_id PRIMARY KEY DEFAULT nextval('jxc_id_seq'),
 country_id jxc_safe_id NOT NULL REFERENCES sys_country(id),
 entity_id jxc_safe_id NOT NULL, book_id jxc_safe_id NOT NULL, partner_type varchar(16) NOT NULL CHECK(partner_type IN ('SUPPLIER','CARRIER')), partner_id jxc_safe_id NOT NULL, doc_no varchar(64) NOT NULL, currency varchar(3) NOT NULL REFERENCES md_currency(code), amount numeric(24,6) NOT NULL CHECK(amount>0), used_amount numeric(24,6) NOT NULL DEFAULT 0, fund_account_id jxc_safe_id NOT NULL, pay_date date NOT NULL, reference_no varchar(128) NOT NULL DEFAULT '', status varchar(24) NOT NULL DEFAULT 'PENDING_CONFIRM' CHECK(status IN ('PENDING_CONFIRM','CONFIRMED','PARTIAL_SETTLED','SETTLED','VOIDED')), confirmed_by jxc_safe_id REFERENCES sys_user(id), confirmed_at timestamptz, proof_attachment_id jxc_safe_id, base_currency varchar(3), rate_id jxc_safe_id, rate numeric(24,10) CHECK(rate>0), rate_date date, base_amount numeric(24,6), valuation_status varchar(32) NOT NULL DEFAULT 'PENDING_RATE' CHECK(valuation_status IN ('PENDING_RATE','READY')),
 version integer NOT NULL DEFAULT 1 CHECK(version>0),
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 UNIQUE(country_id,id),FOREIGN KEY(country_id,entity_id,book_id) REFERENCES fin_book(country_id,entity_id,id),FOREIGN KEY(country_id,fund_account_id) REFERENCES md_fund_account(country_id,id),FOREIGN KEY(country_id,proof_attachment_id) REFERENCES sys_attachment(country_id,id),UNIQUE(country_id,doc_no),CHECK(used_amount BETWEEN 0 AND amount),CHECK(status IN ('PENDING_CONFIRM','VOIDED') OR (proof_attachment_id IS NOT NULL AND confirmed_by IS NOT NULL))
);

CREATE TABLE ap_prepayment (
 id jxc_safe_id PRIMARY KEY DEFAULT nextval('jxc_id_seq'),
 country_id jxc_safe_id NOT NULL REFERENCES sys_country(id),
 entity_id jxc_safe_id NOT NULL, book_id jxc_safe_id NOT NULL, partner_type varchar(16) NOT NULL CHECK(partner_type IN ('SUPPLIER','CARRIER')), partner_id jxc_safe_id NOT NULL, doc_no varchar(64) NOT NULL, currency varchar(3) NOT NULL REFERENCES md_currency(code), amount numeric(24,6) NOT NULL CHECK(amount>0), used_amount numeric(24,6) NOT NULL DEFAULT 0, fund_account_id jxc_safe_id NOT NULL, pay_date date NOT NULL, reference_no varchar(128) NOT NULL DEFAULT '', status varchar(24) NOT NULL DEFAULT 'PENDING_CONFIRM' CHECK(status IN ('PENDING_CONFIRM','CONFIRMED','PARTIAL_SETTLED','SETTLED','PARTIAL_USED','USED','VOIDED')), confirmed_by jxc_safe_id REFERENCES sys_user(id), confirmed_at timestamptz, proof_attachment_id jxc_safe_id, base_currency varchar(3), rate_id jxc_safe_id, rate numeric(24,10) CHECK(rate>0), rate_date date, base_amount numeric(24,6), valuation_status varchar(32) NOT NULL DEFAULT 'PENDING_RATE' CHECK(valuation_status IN ('PENDING_RATE','READY')),
 version integer NOT NULL DEFAULT 1 CHECK(version>0),
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 UNIQUE(country_id,id),FOREIGN KEY(country_id,entity_id,book_id) REFERENCES fin_book(country_id,entity_id,id),FOREIGN KEY(country_id,fund_account_id) REFERENCES md_fund_account(country_id,id),FOREIGN KEY(country_id,proof_attachment_id) REFERENCES sys_attachment(country_id,id),UNIQUE(country_id,doc_no),CHECK(used_amount BETWEEN 0 AND amount),CHECK(status IN ('PENDING_CONFIRM','VOIDED') OR (proof_attachment_id IS NOT NULL AND confirmed_by IS NOT NULL))
);

CREATE TABLE ap_credit_note (
 id jxc_safe_id PRIMARY KEY DEFAULT nextval('jxc_id_seq'),
 country_id jxc_safe_id NOT NULL REFERENCES sys_country(id),
 entity_id jxc_safe_id NOT NULL, book_id jxc_safe_id NOT NULL, partner_type varchar(16) NOT NULL CHECK(partner_type IN ('SUPPLIER','CARRIER')), partner_id jxc_safe_id NOT NULL, doc_no varchar(64) NOT NULL, source_type varchar(32) NOT NULL CHECK(source_type IN ('PURCHASE_RETURN','CLAIM','DISCOUNT','ADJUSTMENT')), source_id jxc_safe_id NOT NULL, currency varchar(3) NOT NULL REFERENCES md_currency(code), amount numeric(24,6) NOT NULL CHECK(amount>0), used_amount numeric(24,6) NOT NULL DEFAULT 0, biz_date date NOT NULL, status varchar(16) NOT NULL DEFAULT 'CONFIRMED', base_currency varchar(3), rate_id jxc_safe_id, rate numeric(24,10) CHECK(rate>0), rate_date date, base_amount numeric(24,6), valuation_status varchar(32) NOT NULL DEFAULT 'PENDING_RATE' CHECK(valuation_status IN ('PENDING_RATE','READY')),
 version integer NOT NULL DEFAULT 1 CHECK(version>0),
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 UNIQUE(country_id,id),FOREIGN KEY(country_id,entity_id,book_id) REFERENCES fin_book(country_id,entity_id,id),UNIQUE(country_id,source_type,source_id),UNIQUE(country_id,doc_no),CHECK(used_amount BETWEEN 0 AND amount)
);

CREATE TABLE ap_settlement (
 id jxc_safe_id PRIMARY KEY DEFAULT nextval('jxc_id_seq'),
 country_id jxc_safe_id NOT NULL REFERENCES sys_country(id),
 entity_id jxc_safe_id NOT NULL, book_id jxc_safe_id NOT NULL, partner_type varchar(16) NOT NULL CHECK(partner_type IN ('SUPPLIER','CARRIER')), partner_id jxc_safe_id NOT NULL, doc_no varchar(64) NOT NULL, biz_date date NOT NULL, status varchar(16) NOT NULL DEFAULT 'EFFECTIVE' CHECK(status IN ('EFFECTIVE','REVERSED')), reversal_of_id jxc_safe_id, direction smallint NOT NULL DEFAULT 1 CHECK(direction IN (-1,1)), reason text NOT NULL DEFAULT '',
 version integer NOT NULL DEFAULT 1 CHECK(version>0),
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 UNIQUE(country_id,id),FOREIGN KEY(country_id,entity_id,book_id) REFERENCES fin_book(country_id,entity_id,id),FOREIGN KEY(country_id,reversal_of_id) REFERENCES ap_settlement(country_id,id),UNIQUE(country_id,doc_no),UNIQUE(country_id,reversal_of_id),CHECK((direction=1 AND reversal_of_id IS NULL) OR (direction=-1 AND reversal_of_id IS NOT NULL))
);

CREATE TABLE ap_settlement_line (
 id jxc_safe_id PRIMARY KEY DEFAULT nextval('jxc_id_seq'),
 country_id jxc_safe_id NOT NULL REFERENCES sys_country(id),
 settlement_id jxc_safe_id NOT NULL, from_type varchar(24) NOT NULL CHECK(from_type IN ('PAYMENT','PREPAYMENT','CREDIT_NOTE')), from_id jxc_safe_id NOT NULL, from_currency varchar(3) NOT NULL, from_amount numeric(24,6) NOT NULL CHECK(from_amount>0), bill_id jxc_safe_id NOT NULL, bill_currency varchar(3) NOT NULL, bill_amount numeric(24,6) NOT NULL CHECK(bill_amount>0), settle_rate numeric(24,10) NOT NULL CHECK(settle_rate>0), rate_source varchar(64) NOT NULL,
 version integer NOT NULL DEFAULT 1 CHECK(version>0),
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 UNIQUE(country_id,id),FOREIGN KEY(country_id,settlement_id) REFERENCES ap_settlement(country_id,id),FOREIGN KEY(country_id,bill_id) REFERENCES ap_bill(country_id,id)
);

CREATE TABLE ap_fx_diff (
 id jxc_safe_id PRIMARY KEY DEFAULT nextval('jxc_id_seq'),
 country_id jxc_safe_id NOT NULL REFERENCES sys_country(id),
 settlement_line_id jxc_safe_id NOT NULL, base_currency varchar(3) NOT NULL, bill_base_amount numeric(24,6) NOT NULL, pay_base_amount numeric(24,6) NOT NULL, diff_amount numeric(24,6) NOT NULL,
 version integer NOT NULL DEFAULT 1 CHECK(version>0),
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 UNIQUE(country_id,id),FOREIGN KEY(country_id,settlement_line_id) REFERENCES ap_settlement_line(country_id,id),UNIQUE(country_id,settlement_line_id),CHECK(diff_amount=pay_base_amount-bill_base_amount)
);

CREATE TABLE ap_adjustment (
 id jxc_safe_id PRIMARY KEY DEFAULT nextval('jxc_id_seq'),
 country_id jxc_safe_id NOT NULL REFERENCES sys_country(id),
 entity_id jxc_safe_id NOT NULL, book_id jxc_safe_id NOT NULL, partner_type varchar(16) NOT NULL CHECK(partner_type IN ('SUPPLIER','CARRIER')), partner_id jxc_safe_id NOT NULL, doc_no varchar(64) NOT NULL, adj_type varchar(16) NOT NULL CHECK(adj_type IN ('DEBIT','CREDIT')), currency varchar(3) NOT NULL, amount numeric(24,6) NOT NULL CHECK(amount>0), reason text NOT NULL CHECK(btrim(reason)<>''), biz_date date NOT NULL, status varchar(24) NOT NULL DEFAULT 'DRAFT', approval_instance_id jxc_safe_id,
 version integer NOT NULL DEFAULT 1 CHECK(version>0),
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 UNIQUE(country_id,id),FOREIGN KEY(country_id,entity_id,book_id) REFERENCES fin_book(country_id,entity_id,id),FOREIGN KEY(country_id,approval_instance_id) REFERENCES wf_instance(country_id,id)
);

CREATE TABLE ap_statement (
 id jxc_safe_id PRIMARY KEY DEFAULT nextval('jxc_id_seq'),
 country_id jxc_safe_id NOT NULL REFERENCES sys_country(id),
 entity_id jxc_safe_id NOT NULL, book_id jxc_safe_id NOT NULL, partner_type varchar(16) NOT NULL CHECK(partner_type IN ('SUPPLIER','CARRIER')), partner_id jxc_safe_id NOT NULL, currency varchar(3) NOT NULL, period_start date NOT NULL, period_end date NOT NULL, opening numeric(24,6) NOT NULL, increase numeric(24,6) NOT NULL, paid numeric(24,6) NOT NULL, offset_amount numeric(24,6) NOT NULL, adjust numeric(24,6) NOT NULL, closing numeric(24,6) NOT NULL, detail_snapshot jsonb NOT NULL CHECK(jxc_json_ids_safe(detail_snapshot)),
 version integer NOT NULL DEFAULT 1 CHECK(version>0),
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 UNIQUE(country_id,id),FOREIGN KEY(country_id,entity_id,book_id) REFERENCES fin_book(country_id,entity_id,id),CHECK(period_start<=period_end),CHECK(closing=opening+increase-paid-offset_amount+adjust)
);

CREATE TABLE rtn_sales_return (
 id jxc_safe_id PRIMARY KEY DEFAULT nextval('jxc_id_seq'),
 country_id jxc_safe_id NOT NULL REFERENCES sys_country(id),
 entity_id jxc_safe_id NOT NULL, book_id jxc_safe_id NOT NULL, doc_no varchar(64) NOT NULL, order_id jxc_safe_id NOT NULL, outbound_id jxc_safe_id NOT NULL, customer_id jxc_safe_id NOT NULL, return_warehouse_id jxc_safe_id NOT NULL, currency varchar(3) NOT NULL, reason_code varchar(64) NOT NULL CHECK(btrim(reason_code)<>''), responsibility varchar(64) NOT NULL CHECK(btrim(responsibility)<>''), status varchar(32) NOT NULL DEFAULT 'DRAFT' CHECK(status IN ('DRAFT','BLOCKED','PENDING_APPROVAL','PENDING_RECEIPT','PENDING_INSPECT','PENDING_SETTLE','COMPLETED','REJECTED','CANCELLED')), approval_instance_id jxc_safe_id, biz_date date NOT NULL, settled_flag boolean NOT NULL DEFAULT false, short_reason text NOT NULL DEFAULT '',
 version integer NOT NULL DEFAULT 1 CHECK(version>0),
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 UNIQUE(country_id,id),FOREIGN KEY(country_id,entity_id,book_id) REFERENCES fin_book(country_id,entity_id,id),FOREIGN KEY(country_id,return_warehouse_id) REFERENCES org_warehouse(country_id,id),FOREIGN KEY(country_id,approval_instance_id) REFERENCES wf_instance(country_id,id),UNIQUE(country_id,doc_no)
);

CREATE TABLE rtn_sales_return_line (
 id jxc_safe_id PRIMARY KEY DEFAULT nextval('jxc_id_seq'),
 country_id jxc_safe_id NOT NULL REFERENCES sys_country(id),
 return_id jxc_safe_id NOT NULL, outbound_line_id jxc_safe_id NOT NULL, order_line_id jxc_safe_id NOT NULL, product_id jxc_safe_id NOT NULL, origin_batch_id jxc_safe_id, req_qty numeric(24,6) NOT NULL CHECK(req_qty>0), received_qty numeric(24,6) NOT NULL DEFAULT 0, inspected_qty numeric(24,6) NOT NULL DEFAULT 0, good_qty numeric(24,6) NOT NULL DEFAULT 0, frozen_qty numeric(24,6) NOT NULL DEFAULT 0, freeze_type varchar(32) NOT NULL DEFAULT '', unit_price numeric(24,10) NOT NULL CHECK(unit_price>=0), amount numeric(24,6) NOT NULL CHECK(amount>=0), reserved_qty numeric(24,6) NOT NULL CHECK(reserved_qty>=0),
 version integer NOT NULL DEFAULT 1 CHECK(version>0),
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 UNIQUE(country_id,id),FOREIGN KEY(country_id,return_id) REFERENCES rtn_sales_return(country_id,id),UNIQUE(country_id,return_id,outbound_line_id),CHECK(received_qty BETWEEN 0 AND req_qty),CHECK(inspected_qty BETWEEN 0 AND received_qty),CHECK(good_qty>=0 AND frozen_qty>=0 AND good_qty+frozen_qty=inspected_qty),CHECK(reserved_qty<=req_qty)
);

CREATE TABLE rtn_sales_receipt (
 id jxc_safe_id PRIMARY KEY DEFAULT nextval('jxc_id_seq'),
 country_id jxc_safe_id NOT NULL REFERENCES sys_country(id),
 return_id jxc_safe_id NOT NULL, return_line_id jxc_safe_id NOT NULL, warehouse_id jxc_safe_id NOT NULL, received_qty numeric(24,6) NOT NULL CHECK(received_qty>0), biz_date date NOT NULL, book_id jxc_safe_id NOT NULL, received_by jxc_safe_id NOT NULL REFERENCES sys_user(id), short_reason text NOT NULL DEFAULT '',
 version integer NOT NULL DEFAULT 1 CHECK(version>0),
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 UNIQUE(country_id,id),FOREIGN KEY(country_id,return_id) REFERENCES rtn_sales_return(country_id,id),FOREIGN KEY(country_id,return_line_id) REFERENCES rtn_sales_return_line(country_id,id),FOREIGN KEY(country_id,warehouse_id) REFERENCES org_warehouse(country_id,id),FOREIGN KEY(country_id,book_id) REFERENCES fin_book(country_id,id)
);

CREATE TABLE rtn_sales_settlement (
 id jxc_safe_id PRIMARY KEY DEFAULT nextval('jxc_id_seq'),
 country_id jxc_safe_id NOT NULL REFERENCES sys_country(id),
 return_id jxc_safe_id NOT NULL, book_id jxc_safe_id NOT NULL, biz_date date NOT NULL, total_amount numeric(24,6) NOT NULL CHECK(total_amount>=0), ar_offset_amount numeric(24,6) NOT NULL CHECK(ar_offset_amount>=0), refundable_amount numeric(24,6) NOT NULL CHECK(refundable_amount>=0), credit_note_ids jsonb NOT NULL, writeoff_id jxc_safe_id, status varchar(16) NOT NULL DEFAULT 'EFFECTIVE' CHECK(status IN ('EFFECTIVE','REVERSED')),
 version integer NOT NULL DEFAULT 1 CHECK(version>0),
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 UNIQUE(country_id,id),FOREIGN KEY(country_id,return_id) REFERENCES rtn_sales_return(country_id,id),FOREIGN KEY(country_id,book_id) REFERENCES fin_book(country_id,id),UNIQUE(country_id,return_id),CHECK(total_amount=ar_offset_amount+refundable_amount)
);

CREATE TABLE rtn_refund (
 id jxc_safe_id PRIMARY KEY DEFAULT nextval('jxc_id_seq'),
 country_id jxc_safe_id NOT NULL REFERENCES sys_country(id),
 entity_id jxc_safe_id NOT NULL, book_id jxc_safe_id NOT NULL, doc_no varchar(64) NOT NULL, customer_id jxc_safe_id NOT NULL, currency varchar(3) NOT NULL, amount numeric(24,6) NOT NULL CHECK(amount>0), method varchar(16) NOT NULL CHECK(method IN ('CASH','TRANSFER')), fund_account_id jxc_safe_id NOT NULL, payee_info jsonb NOT NULL CHECK(jxc_json_ids_safe(payee_info)), status varchar(24) NOT NULL DEFAULT 'DRAFT' CHECK(status IN ('DRAFT','BLOCKED','PENDING_APPROVAL','APPROVED','PAID','REJECTED','CANCELLED')), approval_instance_id jxc_safe_id, biz_date date NOT NULL, paid_at date, reference_no varchar(128) NOT NULL DEFAULT '', paid_by jxc_safe_id REFERENCES sys_user(id), proof_attachment_id jxc_safe_id,
 version integer NOT NULL DEFAULT 1 CHECK(version>0),
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 UNIQUE(country_id,id),FOREIGN KEY(country_id,entity_id,book_id) REFERENCES fin_book(country_id,entity_id,id),FOREIGN KEY(country_id,fund_account_id) REFERENCES md_fund_account(country_id,id),FOREIGN KEY(country_id,approval_instance_id) REFERENCES wf_instance(country_id,id),FOREIGN KEY(country_id,proof_attachment_id) REFERENCES sys_attachment(country_id,id),UNIQUE(country_id,doc_no),CHECK(status<>'PAID' OR (paid_at IS NOT NULL AND paid_by IS NOT NULL AND proof_attachment_id IS NOT NULL AND btrim(reference_no)<>''))
);

CREATE TABLE rtn_refund_source (
 id jxc_safe_id PRIMARY KEY DEFAULT nextval('jxc_id_seq'),
 country_id jxc_safe_id NOT NULL REFERENCES sys_country(id),
 refund_id jxc_safe_id NOT NULL, credit_note_id jxc_safe_id NOT NULL, amount numeric(24,6) NOT NULL CHECK(amount>0), status varchar(16) NOT NULL DEFAULT 'RESERVED' CHECK(status IN ('RESERVED','CONSUMED','RELEASED')),
 version integer NOT NULL DEFAULT 1 CHECK(version>0),
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 UNIQUE(country_id,id),FOREIGN KEY(country_id,refund_id) REFERENCES rtn_refund(country_id,id),UNIQUE(country_id,refund_id,credit_note_id)
);

CREATE TABLE rtn_purchase_return (
 id jxc_safe_id PRIMARY KEY DEFAULT nextval('jxc_id_seq'),
 country_id jxc_safe_id NOT NULL REFERENCES sys_country(id),
 entity_id jxc_safe_id NOT NULL, book_id jxc_safe_id NOT NULL, doc_no varchar(64) NOT NULL, supplier_id jxc_safe_id NOT NULL, po_id jxc_safe_id NOT NULL, stage varchar(16) NOT NULL CHECK(stage IN ('DOMESTIC','MX_STOCK')), warehouse_id jxc_safe_id, currency varchar(3) NOT NULL, reason text NOT NULL CHECK(btrim(reason)<>''), status varchar(24) NOT NULL DEFAULT 'DRAFT', approval_instance_id jxc_safe_id, ap_credit_note_id jxc_safe_id, biz_date date NOT NULL,
 version integer NOT NULL DEFAULT 1 CHECK(version>0),
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 UNIQUE(country_id,id),FOREIGN KEY(country_id,entity_id,book_id) REFERENCES fin_book(country_id,entity_id,id),FOREIGN KEY(country_id,supplier_id) REFERENCES md_supplier(country_id,id),FOREIGN KEY(country_id,warehouse_id) REFERENCES org_warehouse(country_id,id),FOREIGN KEY(country_id,approval_instance_id) REFERENCES wf_instance(country_id,id),FOREIGN KEY(country_id,ap_credit_note_id) REFERENCES ap_credit_note(country_id,id),UNIQUE(country_id,doc_no),CHECK(stage<>'MX_STOCK' OR warehouse_id IS NOT NULL)
);

CREATE TABLE rtn_purchase_return_line (
 id jxc_safe_id PRIMARY KEY DEFAULT nextval('jxc_id_seq'),
 country_id jxc_safe_id NOT NULL REFERENCES sys_country(id),
 return_id jxc_safe_id NOT NULL, po_line_id jxc_safe_id NOT NULL, source_line_id jxc_safe_id, batch_id jxc_safe_id, product_id jxc_safe_id NOT NULL, qty numeric(24,6) NOT NULL CHECK(qty>0), unit_price numeric(24,10) NOT NULL CHECK(unit_price>=0), amount numeric(24,6) NOT NULL CHECK(amount>=0),
 version integer NOT NULL DEFAULT 1 CHECK(version>0),
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 UNIQUE(country_id,id),FOREIGN KEY(country_id,return_id) REFERENCES rtn_purchase_return(country_id,id),CHECK((source_line_id IS NULL)<>(batch_id IS NULL))
);

CREATE TABLE rtn_claim (
 id jxc_safe_id PRIMARY KEY DEFAULT nextval('jxc_id_seq'),
 country_id jxc_safe_id NOT NULL REFERENCES sys_country(id),
 entity_id jxc_safe_id NOT NULL, book_id jxc_safe_id NOT NULL, doc_no varchar(64) NOT NULL, claim_type varchar(16) NOT NULL CHECK(claim_type IN ('DAMAGE','CLAIM')), against_type varchar(16) NOT NULL CHECK(against_type IN ('SUPPLIER','CARRIER')), partner_id jxc_safe_id NOT NULL, discrepancy_id jxc_safe_id, batch_id jxc_safe_id, qty numeric(24,6) NOT NULL DEFAULT 0 CHECK(qty>=0), claim_amount numeric(24,6) NOT NULL CHECK(claim_amount>0), currency varchar(3) NOT NULL, result varchar(16) NOT NULL DEFAULT 'PENDING' CHECK(result IN ('PENDING','COMPENSATED','REJECTED')), compensated_amount numeric(24,6) NOT NULL DEFAULT 0 CHECK(compensated_amount>=0), ap_credit_note_id jxc_safe_id, remark text NOT NULL DEFAULT '', biz_date date NOT NULL,
 version integer NOT NULL DEFAULT 1 CHECK(version>0),
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 UNIQUE(country_id,id),FOREIGN KEY(country_id,entity_id,book_id) REFERENCES fin_book(country_id,entity_id,id),FOREIGN KEY(country_id,ap_credit_note_id) REFERENCES ap_credit_note(country_id,id),UNIQUE(country_id,doc_no),CHECK(compensated_amount<=claim_amount)
);

CREATE TABLE rtn_sales_inspection (
 id jxc_safe_id PRIMARY KEY DEFAULT nextval('jxc_id_seq'), country_id jxc_safe_id NOT NULL REFERENCES sys_country(id),
 return_id jxc_safe_id NOT NULL, return_line_id jxc_safe_id NOT NULL, book_id jxc_safe_id NOT NULL, biz_date date NOT NULL,
 good_qty numeric(24,6) NOT NULL CHECK(good_qty>=0), frozen_qty numeric(24,6) NOT NULL CHECK(frozen_qty>=0), freeze_type varchar(32) NOT NULL,
 inventory_batch_id jxc_safe_id, version integer NOT NULL DEFAULT 1 CHECK(version>0), created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 UNIQUE(country_id,id), FOREIGN KEY(country_id,return_id) REFERENCES rtn_sales_return(country_id,id),
 FOREIGN KEY(country_id,return_line_id) REFERENCES rtn_sales_return_line(country_id,id), FOREIGN KEY(country_id,book_id) REFERENCES fin_book(country_id,id),
 CHECK(good_qty+frozen_qty>0), CHECK(freeze_type IN ('','RETURN_PENDING','DAMAGED'))
);
CREATE FUNCTION jxc_ap_claim_balance() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE sign integer; c bigint; t text; s bigint; q numeric; a numeric;
BEGIN
 IF TG_OP='DELETE' THEN RAISE EXCEPTION 'AP_CLAIM_APPEND_ONLY'; END IF;
 IF TG_OP='UPDATE' AND NOT OLD.effective AND NEW.effective THEN RAISE EXCEPTION 'AP_CLAIM_REACTIVATION_FORBIDDEN';END IF;
 IF TG_OP='UPDATE' AND (NEW.country_id,NEW.bill_id,NEW.bill_line_id,NEW.source_type,NEW.source_id,NEW.qty,NEW.amount) IS DISTINCT FROM (OLD.country_id,OLD.bill_id,OLD.bill_line_id,OLD.source_type,OLD.source_id,OLD.qty,OLD.amount) THEN RAISE EXCEPTION 'AP_CLAIM_IDENTITY_IMMUTABLE'; END IF;
 sign := CASE WHEN TG_OP='INSERT' AND NEW.effective THEN 1 WHEN TG_OP='UPDATE' AND OLD.effective AND NOT NEW.effective THEN -1 WHEN TG_OP='UPDATE' AND NOT OLD.effective AND NEW.effective THEN 1 ELSE 0 END;
 IF sign<>0 THEN UPDATE ap_source_capacity SET claimed_qty=claimed_qty+sign*NEW.qty,claimed_amount=claimed_amount+sign*NEW.amount,version=version+1 WHERE country_id=NEW.country_id AND source_type=NEW.source_type AND source_id=NEW.source_id; END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER ap_claim_balance BEFORE INSERT OR UPDATE OR DELETE ON ap_source_claim FOR EACH ROW EXECUTE FUNCTION jxc_ap_claim_balance();
CREATE FUNCTION jxc_aprtn_dated_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE d date; old_d date;
BEGIN
 IF TG_OP='DELETE' THEN RAISE EXCEPTION 'BUSINESS_FACT_DELETE_FORBIDDEN'; END IF;
 d := (to_jsonb(NEW)->>TG_ARGV[0])::date;
 PERFORM jxc_assert_period_open(NEW.country_id,NEW.book_id,d);
 IF TG_OP='UPDATE' THEN old_d := (to_jsonb(OLD)->>TG_ARGV[0])::date; IF (OLD.country_id,OLD.book_id,old_d) IS DISTINCT FROM (NEW.country_id,NEW.book_id,d) THEN PERFORM jxc_assert_period_open(OLD.country_id,OLD.book_id,old_d); END IF; END IF;
 RETURN NEW;
END $$;
CREATE FUNCTION jxc_aprtn_partner_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE t text; p bigint;
BEGIN
 t:=coalesce(to_jsonb(NEW)->>'partner_type',to_jsonb(NEW)->>'against_type');p:=(to_jsonb(NEW)->>'partner_id')::bigint;
 IF t='SUPPLIER' THEN PERFORM id FROM md_supplier WHERE country_id=NEW.country_id AND id=p;
 ELSIF t='CARRIER' THEN PERFORM id FROM md_logistics_provider WHERE country_id=NEW.country_id AND id=p;
 ELSE RAISE EXCEPTION 'AP_PARTNER_TYPE_INVALID'; END IF;
 IF NOT FOUND THEN RAISE EXCEPTION 'AP_PARTNER_INVALID' USING ERRCODE='23503'; END IF;
 RETURN NEW;
END $$;

CREATE TRIGGER ap_bill_period_guard BEFORE INSERT OR UPDATE OR DELETE ON ap_bill FOR EACH ROW EXECUTE FUNCTION jxc_aprtn_dated_guard('bill_date');

CREATE TRIGGER ap_payment_period_guard BEFORE INSERT OR UPDATE OR DELETE ON ap_payment FOR EACH ROW EXECUTE FUNCTION jxc_aprtn_dated_guard('pay_date');

CREATE TRIGGER ap_prepayment_period_guard BEFORE INSERT OR UPDATE OR DELETE ON ap_prepayment FOR EACH ROW EXECUTE FUNCTION jxc_aprtn_dated_guard('pay_date');

CREATE TRIGGER ap_credit_note_period_guard BEFORE INSERT OR UPDATE OR DELETE ON ap_credit_note FOR EACH ROW EXECUTE FUNCTION jxc_aprtn_dated_guard('biz_date');

CREATE TRIGGER ap_settlement_period_guard BEFORE INSERT OR UPDATE OR DELETE ON ap_settlement FOR EACH ROW EXECUTE FUNCTION jxc_aprtn_dated_guard('biz_date');

CREATE TRIGGER ap_adjustment_period_guard BEFORE INSERT OR UPDATE OR DELETE ON ap_adjustment FOR EACH ROW EXECUTE FUNCTION jxc_aprtn_dated_guard('biz_date');

CREATE TRIGGER rtn_sales_return_period_guard BEFORE INSERT OR UPDATE OR DELETE ON rtn_sales_return FOR EACH ROW EXECUTE FUNCTION jxc_aprtn_dated_guard('biz_date');

CREATE TRIGGER rtn_sales_receipt_period_guard BEFORE INSERT OR UPDATE OR DELETE ON rtn_sales_receipt FOR EACH ROW EXECUTE FUNCTION jxc_aprtn_dated_guard('biz_date');

CREATE TRIGGER rtn_sales_settlement_period_guard BEFORE INSERT OR UPDATE OR DELETE ON rtn_sales_settlement FOR EACH ROW EXECUTE FUNCTION jxc_aprtn_dated_guard('biz_date');

CREATE TRIGGER rtn_refund_period_guard BEFORE INSERT OR UPDATE OR DELETE ON rtn_refund FOR EACH ROW EXECUTE FUNCTION jxc_aprtn_dated_guard('biz_date');

CREATE TRIGGER rtn_purchase_return_period_guard BEFORE INSERT OR UPDATE OR DELETE ON rtn_purchase_return FOR EACH ROW EXECUTE FUNCTION jxc_aprtn_dated_guard('biz_date');

CREATE TRIGGER rtn_claim_period_guard BEFORE INSERT OR UPDATE OR DELETE ON rtn_claim FOR EACH ROW EXECUTE FUNCTION jxc_aprtn_dated_guard('biz_date');

CREATE TRIGGER ap_bill_partner_guard BEFORE INSERT OR UPDATE ON ap_bill FOR EACH ROW EXECUTE FUNCTION jxc_aprtn_partner_guard();

CREATE TRIGGER ap_payment_partner_guard BEFORE INSERT OR UPDATE ON ap_payment FOR EACH ROW EXECUTE FUNCTION jxc_aprtn_partner_guard();

CREATE TRIGGER ap_prepayment_partner_guard BEFORE INSERT OR UPDATE ON ap_prepayment FOR EACH ROW EXECUTE FUNCTION jxc_aprtn_partner_guard();

CREATE TRIGGER ap_credit_note_partner_guard BEFORE INSERT OR UPDATE ON ap_credit_note FOR EACH ROW EXECUTE FUNCTION jxc_aprtn_partner_guard();

CREATE TRIGGER ap_settlement_partner_guard BEFORE INSERT OR UPDATE ON ap_settlement FOR EACH ROW EXECUTE FUNCTION jxc_aprtn_partner_guard();

CREATE TRIGGER ap_adjustment_partner_guard BEFORE INSERT OR UPDATE ON ap_adjustment FOR EACH ROW EXECUTE FUNCTION jxc_aprtn_partner_guard();

CREATE TRIGGER ap_statement_partner_guard BEFORE INSERT OR UPDATE ON ap_statement FOR EACH ROW EXECUTE FUNCTION jxc_aprtn_partner_guard();

CREATE TRIGGER rtn_claim_partner_guard BEFORE INSERT OR UPDATE ON rtn_claim FOR EACH ROW EXECUTE FUNCTION jxc_aprtn_partner_guard();

ALTER TABLE ap_source_capacity ENABLE ROW LEVEL SECURITY;
ALTER TABLE ap_source_capacity FORCE ROW LEVEL SECURITY;
CREATE POLICY country_isolation ON ap_source_capacity USING(country_id=jxc_current_country_id()) WITH CHECK(country_id=jxc_current_country_id());
GRANT SELECT,INSERT,UPDATE ON ap_source_capacity TO "${runtimeRole}";

ALTER TABLE ap_bill ENABLE ROW LEVEL SECURITY;
ALTER TABLE ap_bill FORCE ROW LEVEL SECURITY;
CREATE POLICY country_isolation ON ap_bill USING(country_id=jxc_current_country_id()) WITH CHECK(country_id=jxc_current_country_id());
GRANT SELECT,INSERT,UPDATE ON ap_bill TO "${runtimeRole}";

ALTER TABLE ap_bill_line ENABLE ROW LEVEL SECURITY;
ALTER TABLE ap_bill_line FORCE ROW LEVEL SECURITY;
CREATE POLICY country_isolation ON ap_bill_line USING(country_id=jxc_current_country_id()) WITH CHECK(country_id=jxc_current_country_id());
GRANT SELECT,INSERT,UPDATE ON ap_bill_line TO "${runtimeRole}";

ALTER TABLE ap_source_claim ENABLE ROW LEVEL SECURITY;
ALTER TABLE ap_source_claim FORCE ROW LEVEL SECURITY;
CREATE POLICY country_isolation ON ap_source_claim USING(country_id=jxc_current_country_id()) WITH CHECK(country_id=jxc_current_country_id());
GRANT SELECT,INSERT,UPDATE ON ap_source_claim TO "${runtimeRole}";

ALTER TABLE ap_payment ENABLE ROW LEVEL SECURITY;
ALTER TABLE ap_payment FORCE ROW LEVEL SECURITY;
CREATE POLICY country_isolation ON ap_payment USING(country_id=jxc_current_country_id()) WITH CHECK(country_id=jxc_current_country_id());
GRANT SELECT,INSERT,UPDATE ON ap_payment TO "${runtimeRole}";

ALTER TABLE ap_prepayment ENABLE ROW LEVEL SECURITY;
ALTER TABLE ap_prepayment FORCE ROW LEVEL SECURITY;
CREATE POLICY country_isolation ON ap_prepayment USING(country_id=jxc_current_country_id()) WITH CHECK(country_id=jxc_current_country_id());
GRANT SELECT,INSERT,UPDATE ON ap_prepayment TO "${runtimeRole}";

ALTER TABLE ap_credit_note ENABLE ROW LEVEL SECURITY;
ALTER TABLE ap_credit_note FORCE ROW LEVEL SECURITY;
CREATE POLICY country_isolation ON ap_credit_note USING(country_id=jxc_current_country_id()) WITH CHECK(country_id=jxc_current_country_id());
GRANT SELECT,INSERT,UPDATE ON ap_credit_note TO "${runtimeRole}";

ALTER TABLE ap_settlement ENABLE ROW LEVEL SECURITY;
ALTER TABLE ap_settlement FORCE ROW LEVEL SECURITY;
CREATE POLICY country_isolation ON ap_settlement USING(country_id=jxc_current_country_id()) WITH CHECK(country_id=jxc_current_country_id());
GRANT SELECT,INSERT,UPDATE ON ap_settlement TO "${runtimeRole}";

ALTER TABLE ap_settlement_line ENABLE ROW LEVEL SECURITY;
ALTER TABLE ap_settlement_line FORCE ROW LEVEL SECURITY;
CREATE POLICY country_isolation ON ap_settlement_line USING(country_id=jxc_current_country_id()) WITH CHECK(country_id=jxc_current_country_id());
GRANT SELECT,INSERT,UPDATE ON ap_settlement_line TO "${runtimeRole}";

ALTER TABLE ap_fx_diff ENABLE ROW LEVEL SECURITY;
ALTER TABLE ap_fx_diff FORCE ROW LEVEL SECURITY;
CREATE POLICY country_isolation ON ap_fx_diff USING(country_id=jxc_current_country_id()) WITH CHECK(country_id=jxc_current_country_id());
GRANT SELECT,INSERT,UPDATE ON ap_fx_diff TO "${runtimeRole}";

ALTER TABLE ap_adjustment ENABLE ROW LEVEL SECURITY;
ALTER TABLE ap_adjustment FORCE ROW LEVEL SECURITY;
CREATE POLICY country_isolation ON ap_adjustment USING(country_id=jxc_current_country_id()) WITH CHECK(country_id=jxc_current_country_id());
GRANT SELECT,INSERT,UPDATE ON ap_adjustment TO "${runtimeRole}";

ALTER TABLE ap_statement ENABLE ROW LEVEL SECURITY;
ALTER TABLE ap_statement FORCE ROW LEVEL SECURITY;
CREATE POLICY country_isolation ON ap_statement USING(country_id=jxc_current_country_id()) WITH CHECK(country_id=jxc_current_country_id());
GRANT SELECT,INSERT,UPDATE ON ap_statement TO "${runtimeRole}";

ALTER TABLE rtn_sales_return ENABLE ROW LEVEL SECURITY;
ALTER TABLE rtn_sales_return FORCE ROW LEVEL SECURITY;
CREATE POLICY country_isolation ON rtn_sales_return USING(country_id=jxc_current_country_id()) WITH CHECK(country_id=jxc_current_country_id());
GRANT SELECT,INSERT,UPDATE ON rtn_sales_return TO "${runtimeRole}";

ALTER TABLE rtn_sales_return_line ENABLE ROW LEVEL SECURITY;
ALTER TABLE rtn_sales_return_line FORCE ROW LEVEL SECURITY;
CREATE POLICY country_isolation ON rtn_sales_return_line USING(country_id=jxc_current_country_id()) WITH CHECK(country_id=jxc_current_country_id());
GRANT SELECT,INSERT,UPDATE ON rtn_sales_return_line TO "${runtimeRole}";

ALTER TABLE rtn_sales_receipt ENABLE ROW LEVEL SECURITY;
ALTER TABLE rtn_sales_receipt FORCE ROW LEVEL SECURITY;
CREATE POLICY country_isolation ON rtn_sales_receipt USING(country_id=jxc_current_country_id()) WITH CHECK(country_id=jxc_current_country_id());
GRANT SELECT,INSERT,UPDATE ON rtn_sales_receipt TO "${runtimeRole}";

ALTER TABLE rtn_sales_settlement ENABLE ROW LEVEL SECURITY;
ALTER TABLE rtn_sales_settlement FORCE ROW LEVEL SECURITY;
CREATE POLICY country_isolation ON rtn_sales_settlement USING(country_id=jxc_current_country_id()) WITH CHECK(country_id=jxc_current_country_id());
GRANT SELECT,INSERT,UPDATE ON rtn_sales_settlement TO "${runtimeRole}";

ALTER TABLE rtn_refund ENABLE ROW LEVEL SECURITY;
ALTER TABLE rtn_refund FORCE ROW LEVEL SECURITY;
CREATE POLICY country_isolation ON rtn_refund USING(country_id=jxc_current_country_id()) WITH CHECK(country_id=jxc_current_country_id());
GRANT SELECT,INSERT,UPDATE ON rtn_refund TO "${runtimeRole}";

ALTER TABLE rtn_refund_source ENABLE ROW LEVEL SECURITY;
ALTER TABLE rtn_refund_source FORCE ROW LEVEL SECURITY;
CREATE POLICY country_isolation ON rtn_refund_source USING(country_id=jxc_current_country_id()) WITH CHECK(country_id=jxc_current_country_id());
GRANT SELECT,INSERT,UPDATE ON rtn_refund_source TO "${runtimeRole}";

ALTER TABLE rtn_purchase_return ENABLE ROW LEVEL SECURITY;
ALTER TABLE rtn_purchase_return FORCE ROW LEVEL SECURITY;
CREATE POLICY country_isolation ON rtn_purchase_return USING(country_id=jxc_current_country_id()) WITH CHECK(country_id=jxc_current_country_id());
GRANT SELECT,INSERT,UPDATE ON rtn_purchase_return TO "${runtimeRole}";

ALTER TABLE rtn_purchase_return_line ENABLE ROW LEVEL SECURITY;
ALTER TABLE rtn_purchase_return_line FORCE ROW LEVEL SECURITY;
CREATE POLICY country_isolation ON rtn_purchase_return_line USING(country_id=jxc_current_country_id()) WITH CHECK(country_id=jxc_current_country_id());
GRANT SELECT,INSERT,UPDATE ON rtn_purchase_return_line TO "${runtimeRole}";

ALTER TABLE rtn_claim ENABLE ROW LEVEL SECURITY;
ALTER TABLE rtn_claim FORCE ROW LEVEL SECURITY;
CREATE POLICY country_isolation ON rtn_claim USING(country_id=jxc_current_country_id()) WITH CHECK(country_id=jxc_current_country_id());
GRANT SELECT,INSERT,UPDATE ON rtn_claim TO "${runtimeRole}";

ALTER TABLE rtn_sales_inspection ENABLE ROW LEVEL SECURITY;
ALTER TABLE rtn_sales_inspection FORCE ROW LEVEL SECURITY;
CREATE POLICY country_isolation ON rtn_sales_inspection USING(country_id=jxc_current_country_id()) WITH CHECK(country_id=jxc_current_country_id());
GRANT SELECT,INSERT,UPDATE ON rtn_sales_inspection TO "${runtimeRole}";
CREATE TRIGGER rtn_sales_inspection_period_guard BEFORE INSERT OR UPDATE OR DELETE ON rtn_sales_inspection FOR EACH ROW EXECUTE FUNCTION jxc_aprtn_dated_guard('biz_date');
ALTER TABLE rtn_sales_return ADD FOREIGN KEY(country_id,customer_id) REFERENCES md_customer(country_id,id), ADD FOREIGN KEY(country_id,order_id) REFERENCES sal_order(country_id,id), ADD FOREIGN KEY(country_id,outbound_id) REFERENCES sal_outbound(country_id,id);
ALTER TABLE rtn_sales_return_line ADD FOREIGN KEY(country_id,outbound_line_id) REFERENCES sal_outbound_line(country_id,id), ADD FOREIGN KEY(country_id,order_line_id) REFERENCES sal_order_line(country_id,id), ADD FOREIGN KEY(country_id,product_id) REFERENCES md_country_sku(country_id,product_id);
ALTER TABLE rtn_refund ADD FOREIGN KEY(country_id,customer_id) REFERENCES md_customer(country_id,id);
ALTER TABLE rtn_refund_source ADD FOREIGN KEY(country_id,credit_note_id) REFERENCES ar_credit_note(country_id,id);
ALTER TABLE rtn_purchase_return_line ADD FOREIGN KEY(country_id,product_id) REFERENCES md_country_sku(country_id,product_id);
ALTER TABLE ap_bill_line ADD FOREIGN KEY(country_id,product_id) REFERENCES md_country_sku(country_id,product_id);
CREATE FUNCTION jxc_aprtn_child_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE parent_id bigint; b bigint; d date; old_parent bigint; parent_status text;
BEGIN
 IF TG_OP='DELETE' THEN RAISE EXCEPTION 'BUSINESS_FACT_DELETE_FORBIDDEN'; END IF;
 parent_id := (to_jsonb(NEW)->>TG_ARGV[1])::bigint;
 EXECUTE format('SELECT book_id,%I FROM %I WHERE country_id=$1 AND id=$2',TG_ARGV[2],TG_ARGV[0]) INTO b,d USING NEW.country_id,parent_id;
 IF b IS NULL OR d IS NULL THEN RAISE EXCEPTION 'SOURCE_MISSING' USING ERRCODE='23503'; END IF;
 PERFORM jxc_assert_period_open(NEW.country_id,b,d);
 IF TG_OP='UPDATE' THEN
  old_parent := (to_jsonb(OLD)->>TG_ARGV[1])::bigint;
  IF (OLD.country_id,old_parent) IS DISTINCT FROM (NEW.country_id,parent_id) THEN RAISE EXCEPTION 'SOURCE_IDENTITY_IMMUTABLE'; END IF;
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER ap_bill_line_period_guard BEFORE INSERT OR UPDATE OR DELETE ON ap_bill_line FOR EACH ROW EXECUTE FUNCTION jxc_aprtn_child_guard('ap_bill','bill_id','bill_date');
CREATE TRIGGER ap_source_claim_period_guard BEFORE INSERT OR UPDATE OR DELETE ON ap_source_claim FOR EACH ROW EXECUTE FUNCTION jxc_aprtn_child_guard('ap_bill','bill_id','bill_date');
CREATE TRIGGER ap_settlement_line_period_guard BEFORE INSERT OR UPDATE OR DELETE ON ap_settlement_line FOR EACH ROW EXECUTE FUNCTION jxc_aprtn_child_guard('ap_settlement','settlement_id','biz_date');
CREATE TRIGGER rtn_sales_return_line_period_guard BEFORE INSERT OR UPDATE OR DELETE ON rtn_sales_return_line FOR EACH ROW EXECUTE FUNCTION jxc_aprtn_child_guard('rtn_sales_return','return_id','biz_date');
CREATE TRIGGER rtn_purchase_return_line_period_guard BEFORE INSERT OR UPDATE OR DELETE ON rtn_purchase_return_line FOR EACH ROW EXECUTE FUNCTION jxc_aprtn_child_guard('rtn_purchase_return','return_id','biz_date');
CREATE TRIGGER rtn_refund_source_period_guard BEFORE INSERT OR UPDATE OR DELETE ON rtn_refund_source FOR EACH ROW EXECUTE FUNCTION jxc_aprtn_child_guard('rtn_refund','refund_id','biz_date');

ALTER TABLE rtn_sales_return ADD no_origin_flag boolean NOT NULL DEFAULT false;
ALTER TABLE rtn_sales_return ALTER COLUMN order_id DROP NOT NULL, ALTER COLUMN outbound_id DROP NOT NULL;
ALTER TABLE rtn_sales_return ADD CHECK((no_origin_flag AND order_id IS NULL AND outbound_id IS NULL) OR (NOT no_origin_flag AND order_id IS NOT NULL AND outbound_id IS NOT NULL));
ALTER TABLE rtn_sales_return_line ALTER COLUMN outbound_line_id DROP NOT NULL, ALTER COLUMN order_line_id DROP NOT NULL;
ALTER TABLE rtn_sales_return_line ADD cost_source varchar(24), ADD cost_snapshot_id jxc_safe_id;
ALTER TABLE rtn_sales_return_line ADD FOREIGN KEY(country_id,origin_batch_id) REFERENCES inv_batch(country_id,id), ADD FOREIGN KEY(country_id,cost_snapshot_id) REFERENCES cst_inbound_cost(country_id,id);

ALTER TABLE rtn_sales_settlement DROP CONSTRAINT rtn_sales_settlement_country_id_return_id_key;
CREATE UNIQUE INDEX rtn_sales_one_effective_settlement ON rtn_sales_settlement(country_id,return_id) WHERE status='EFFECTIVE';
ALTER TABLE ap_bill ADD adjustment_id jxc_safe_id, ADD UNIQUE(country_id,adjustment_id), ADD FOREIGN KEY(country_id,adjustment_id) REFERENCES ap_adjustment(country_id,id);

-- Historical balances and workflow states are projections; new dated settlement,
-- receipt, inspection and refund facts carry the current command's period gate.
CREATE OR REPLACE FUNCTION jxc_aprtn_dated_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE d date; old_d date; mutable text;
BEGIN
 IF TG_OP='DELETE' THEN RAISE EXCEPTION 'BUSINESS_FACT_DELETE_FORBIDDEN'; END IF;
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
ALTER TABLE ap_bill_line ADD UNIQUE(country_id,bill_id,id);
ALTER TABLE ap_source_claim ADD FOREIGN KEY(country_id,bill_id,bill_line_id) REFERENCES ap_bill_line(country_id,bill_id,id);
ALTER TABLE rtn_sales_return_line ADD UNIQUE(country_id,return_id,id);
ALTER TABLE rtn_sales_receipt ADD FOREIGN KEY(country_id,return_id,return_line_id) REFERENCES rtn_sales_return_line(country_id,return_id,id);
ALTER TABLE rtn_sales_inspection ADD FOREIGN KEY(country_id,return_id,return_line_id) REFERENCES rtn_sales_return_line(country_id,return_id,id);
ALTER TABLE rtn_purchase_return ADD FOREIGN KEY(country_id,po_id) REFERENCES pur_order(country_id,id);
ALTER TABLE rtn_purchase_return_line ADD FOREIGN KEY(country_id,po_line_id) REFERENCES pur_order_line(country_id,id), ADD FOREIGN KEY(country_id,source_line_id) REFERENCES pur_domestic_receipt_line(country_id,id), ADD FOREIGN KEY(country_id,batch_id) REFERENCES inv_batch(country_id,id);
ALTER TABLE ap_bill ADD FOREIGN KEY(country_id,rate_id) REFERENCES md_exchange_rate(country_id,id);
ALTER TABLE ap_payment ADD FOREIGN KEY(country_id,rate_id) REFERENCES md_exchange_rate(country_id,id);
ALTER TABLE ap_prepayment ADD FOREIGN KEY(country_id,rate_id) REFERENCES md_exchange_rate(country_id,id);
ALTER TABLE ap_credit_note ADD FOREIGN KEY(country_id,rate_id) REFERENCES md_exchange_rate(country_id,id);
CREATE FUNCTION jxc_ap_fx_dated_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE b bigint; d date;
BEGIN
 IF TG_OP<>'INSERT' THEN RAISE EXCEPTION 'AP_FX_APPEND_ONLY'; END IF;
 SELECT s.book_id,s.biz_date INTO b,d FROM ap_settlement_line l JOIN ap_settlement s ON s.country_id=l.country_id AND s.id=l.settlement_id WHERE l.country_id=NEW.country_id AND l.id=NEW.settlement_line_id;
 IF b IS NULL THEN RAISE EXCEPTION 'SOURCE_MISSING' USING ERRCODE='23503';END IF;
 PERFORM jxc_assert_period_open(NEW.country_id,b,d);RETURN NEW;
END $$;
CREATE TRIGGER ap_fx_dated_guard BEFORE INSERT OR UPDATE OR DELETE ON ap_fx_diff FOR EACH ROW EXECUTE FUNCTION jxc_ap_fx_dated_guard();
CREATE OR REPLACE FUNCTION jxc_aprtn_child_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE parent_id bigint; b bigint; d date; old_parent bigint; parent_status text;
BEGIN
 IF TG_OP='DELETE' THEN RAISE EXCEPTION 'BUSINESS_FACT_DELETE_FORBIDDEN'; END IF;
 IF TG_OP='UPDATE' AND TG_TABLE_NAME='rtn_sales_return_line' AND (to_jsonb(NEW)-ARRAY['received_qty','inspected_qty','good_qty','frozen_qty','freeze_type','reserved_qty','version']) IS NOT DISTINCT FROM (to_jsonb(OLD)-ARRAY['received_qty','inspected_qty','good_qty','frozen_qty','freeze_type','reserved_qty','version']) THEN RETURN NEW; END IF;
 IF TG_OP='UPDATE' AND TG_TABLE_NAME='rtn_refund_source' AND (to_jsonb(NEW)-ARRAY['status','version']) IS NOT DISTINCT FROM (to_jsonb(OLD)-ARRAY['status','version']) THEN RETURN NEW; END IF;
 parent_id:=(to_jsonb(NEW)->>TG_ARGV[1])::bigint;
 EXECUTE format('SELECT book_id,%I FROM %I WHERE country_id=$1 AND id=$2',TG_ARGV[2],TG_ARGV[0]) INTO b,d USING NEW.country_id,parent_id;
 IF b IS NULL OR d IS NULL THEN RAISE EXCEPTION 'SOURCE_MISSING' USING ERRCODE='23503'; END IF;
 IF TG_TABLE_NAME IN ('ap_bill_line','rtn_sales_return_line','rtn_purchase_return_line') AND TG_OP='UPDATE' THEN
  EXECUTE format('SELECT status FROM %I WHERE country_id=$1 AND id=$2',TG_ARGV[0]) INTO parent_status USING NEW.country_id,parent_id;
  IF parent_status<>'DRAFT' THEN
  RAISE EXCEPTION 'BUSINESS_FACT_IMMUTABLE' USING ERRCODE='23514';
  END IF;
 END IF;
 PERFORM jxc_assert_period_open(NEW.country_id,b,d);
 IF TG_OP='UPDATE' THEN old_parent:=(to_jsonb(OLD)->>TG_ARGV[1])::bigint;IF (OLD.country_id,old_parent) IS DISTINCT FROM (NEW.country_id,parent_id) THEN RAISE EXCEPTION 'SOURCE_IDENTITY_IMMUTABLE';END IF;END IF;
 RETURN NEW;
END $$;
CREATE FUNCTION jxc_refund_payment_period() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.status='PAID' AND OLD.status<>'PAID' THEN PERFORM jxc_assert_period_open(NEW.country_id,NEW.book_id,NEW.paid_at);END IF;RETURN NEW;END $$;
CREATE TRIGGER rtn_refund_payment_period BEFORE UPDATE ON rtn_refund FOR EACH ROW EXECUTE FUNCTION jxc_refund_payment_period();

-- Typed settlement references prevent a polymorphic identifier from escaping
-- country ownership or referring to an unrelated funding kind.
ALTER TABLE ap_settlement_line ADD payment_id jxc_safe_id, ADD prepayment_id jxc_safe_id, ADD credit_note_id jxc_safe_id;
ALTER TABLE ap_settlement_line ADD FOREIGN KEY(country_id,payment_id) REFERENCES ap_payment(country_id,id), ADD FOREIGN KEY(country_id,prepayment_id) REFERENCES ap_prepayment(country_id,id), ADD FOREIGN KEY(country_id,credit_note_id) REFERENCES ap_credit_note(country_id,id);
ALTER TABLE ap_settlement_line ADD CHECK((from_type='PAYMENT' AND payment_id=from_id AND prepayment_id IS NULL AND credit_note_id IS NULL) OR (from_type='PREPAYMENT' AND prepayment_id=from_id AND payment_id IS NULL AND credit_note_id IS NULL) OR (from_type='CREDIT_NOTE' AND credit_note_id=from_id AND payment_id IS NULL AND prepayment_id IS NULL));
CREATE FUNCTION jxc_ap_settlement_source_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE s record; b record; h record; t text;
BEGIN
 IF TG_OP<>'INSERT' THEN RAISE EXCEPTION 'AP_SETTLEMENT_LINE_APPEND_ONLY';END IF;
 t:=CASE NEW.from_type WHEN 'PAYMENT' THEN 'ap_payment' WHEN 'PREPAYMENT' THEN 'ap_prepayment' WHEN 'CREDIT_NOTE' THEN 'ap_credit_note' END;
 IF t IS NULL THEN RAISE EXCEPTION 'AP_SOURCE_KIND_INVALID';END IF;
 EXECUTE format('SELECT book_id,entity_id,partner_type,partner_id,currency FROM %I WHERE country_id=$1 AND id=$2 FOR UPDATE',t) INTO s USING NEW.country_id,NEW.from_id;
 SELECT book_id,entity_id,partner_type,partner_id,currency INTO b FROM ap_bill WHERE country_id=NEW.country_id AND id=NEW.bill_id FOR UPDATE;
 SELECT book_id,entity_id,partner_type,partner_id INTO h FROM ap_settlement WHERE country_id=NEW.country_id AND id=NEW.settlement_id;
 IF s IS NULL OR b IS NULL OR h IS NULL OR (s.book_id,s.entity_id,s.partner_type,s.partner_id) IS DISTINCT FROM (b.book_id,b.entity_id,b.partner_type,b.partner_id) OR (h.book_id,h.entity_id,h.partner_type,h.partner_id) IS DISTINCT FROM (b.book_id,b.entity_id,b.partner_type,b.partner_id) OR s.currency<>NEW.from_currency OR b.currency<>NEW.bill_currency THEN RAISE EXCEPTION 'AP_SETTLEMENT_SOURCE_MISMATCH' USING ERRCODE='23503';END IF;
 IF NEW.from_type='PAYMENT' THEN NEW.payment_id:=NEW.from_id;ELSIF NEW.from_type='PREPAYMENT' THEN NEW.prepayment_id:=NEW.from_id;ELSE NEW.credit_note_id:=NEW.from_id;END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER ap_settlement_typed_source BEFORE INSERT OR UPDATE OR DELETE ON ap_settlement_line FOR EACH ROW EXECUTE FUNCTION jxc_ap_settlement_source_guard();
CREATE FUNCTION jxc_ap_balance_consistency() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE cid bigint; bid bigint; fid bigint; ft text; actual numeric; projection numeric; tab text;
BEGIN
 cid:=NEW.country_id;
 IF TG_TABLE_NAME='ap_settlement_line' THEN bid:=NEW.bill_id;fid:=NEW.from_id;ft:=NEW.from_type;
 ELSIF TG_TABLE_NAME='ap_bill' THEN bid:=NEW.id;
 ELSE fid:=NEW.id;ft:=CASE TG_TABLE_NAME WHEN 'ap_payment' THEN 'PAYMENT' WHEN 'ap_prepayment' THEN 'PREPAYMENT' ELSE 'CREDIT_NOTE' END;END IF;
 IF bid IS NOT NULL THEN
  SELECT coalesce(sum(l.bill_amount*s.direction),0) INTO actual FROM ap_settlement_line l JOIN ap_settlement s ON s.country_id=l.country_id AND s.id=l.settlement_id WHERE l.country_id=cid AND l.bill_id=bid;
  SELECT paid_amount INTO projection FROM ap_bill WHERE country_id=cid AND id=bid;
  IF actual IS DISTINCT FROM projection THEN RAISE EXCEPTION 'AP_BILL_BALANCE_INCONSISTENT' USING ERRCODE='23514';END IF;
 END IF;
 IF fid IS NOT NULL THEN
  tab:=CASE ft WHEN 'PAYMENT' THEN 'ap_payment' WHEN 'PREPAYMENT' THEN 'ap_prepayment' ELSE 'ap_credit_note' END;
  SELECT coalesce(sum(l.from_amount*s.direction),0) INTO actual FROM ap_settlement_line l JOIN ap_settlement s ON s.country_id=l.country_id AND s.id=l.settlement_id WHERE l.country_id=cid AND l.from_type=ft AND l.from_id=fid;
  EXECUTE format('SELECT used_amount FROM %I WHERE country_id=$1 AND id=$2',tab) INTO projection USING cid,fid;
  IF actual IS DISTINCT FROM projection THEN RAISE EXCEPTION 'AP_SOURCE_BALANCE_INCONSISTENT' USING ERRCODE='23514';END IF;
 END IF;RETURN NULL;
END $$;
CREATE CONSTRAINT TRIGGER ap_bill_balanced AFTER INSERT OR UPDATE ON ap_bill DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION jxc_ap_balance_consistency();
CREATE CONSTRAINT TRIGGER ap_payment_balanced AFTER INSERT OR UPDATE ON ap_payment DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION jxc_ap_balance_consistency();
CREATE CONSTRAINT TRIGGER ap_prepayment_balanced AFTER INSERT OR UPDATE ON ap_prepayment DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION jxc_ap_balance_consistency();
CREATE CONSTRAINT TRIGGER ap_credit_balanced AFTER INSERT OR UPDATE ON ap_credit_note DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION jxc_ap_balance_consistency();
CREATE CONSTRAINT TRIGGER ap_settlement_balanced AFTER INSERT ON ap_settlement_line DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION jxc_ap_balance_consistency();
CREATE FUNCTION jxc_return_origin_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE no_origin boolean;
BEGIN
 SELECT no_origin_flag INTO no_origin FROM rtn_sales_return WHERE country_id=NEW.country_id AND id=NEW.return_id;
 IF no_origin AND (NEW.outbound_line_id IS NOT NULL OR NEW.order_line_id IS NOT NULL OR NEW.cost_source NOT IN ('BATCH','LATEST_INBOUND') OR NEW.cost_source IS NULL OR NEW.cost_snapshot_id IS NULL OR NEW.origin_batch_id IS NULL) THEN RAISE EXCEPTION 'RTN_COST_SOURCE_REQUIRED' USING ERRCODE='23514';END IF;
 IF NOT no_origin AND (NEW.outbound_line_id IS NULL OR NEW.order_line_id IS NULL) THEN RAISE EXCEPTION 'RTN_ORIGIN_REQUIRED' USING ERRCODE='23514';END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER rtn_origin_source BEFORE INSERT OR UPDATE ON rtn_sales_return_line FOR EACH ROW EXECUTE FUNCTION jxc_return_origin_guard();

-- A payment account can be shared by an entity, or assigned to one book.
CREATE FUNCTION jxc_aprtn_account_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE account record;
BEGIN
 SELECT entity_id,book_id,currency INTO account FROM md_fund_account WHERE country_id=NEW.country_id AND id=NEW.fund_account_id;
 IF account IS NULL OR account.entity_id<>NEW.entity_id OR (account.book_id IS NOT NULL AND account.book_id<>NEW.book_id) OR account.currency<>NEW.currency THEN RAISE EXCEPTION 'PAYMENT_ACCOUNT_SOURCE_MISMATCH' USING ERRCODE='23503';END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER ap_payment_account_guard BEFORE INSERT OR UPDATE ON ap_payment FOR EACH ROW EXECUTE FUNCTION jxc_aprtn_account_guard();
CREATE TRIGGER ap_prepayment_account_guard BEFORE INSERT OR UPDATE ON ap_prepayment FOR EACH ROW EXECUTE FUNCTION jxc_aprtn_account_guard();
CREATE TRIGGER rtn_refund_account_guard BEFORE INSERT OR UPDATE ON rtn_refund FOR EACH ROW EXECUTE FUNCTION jxc_aprtn_account_guard();
CREATE FUNCTION jxc_ap_capacity_identity() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF (to_jsonb(NEW)-ARRAY['current_max_qty','current_max_amount','claimed_qty','claimed_amount','version']) IS DISTINCT FROM (to_jsonb(OLD)-ARRAY['current_max_qty','current_max_amount','claimed_qty','claimed_amount','version']) THEN RAISE EXCEPTION 'AP_SOURCE_IDENTITY_IMMUTABLE';END IF;RETURN NEW;
END $$;
CREATE TRIGGER ap_source_identity BEFORE UPDATE ON ap_source_capacity FOR EACH ROW EXECUTE FUNCTION jxc_ap_capacity_identity();
REVOKE UPDATE ON ap_statement FROM "${runtimeRole}";

-- Every return fact inherits its actual parent book and receiving warehouse.
ALTER TABLE rtn_sales_return ADD UNIQUE(country_id,book_id,id), ADD UNIQUE(country_id,book_id,id,return_warehouse_id);
ALTER TABLE rtn_sales_receipt ADD FOREIGN KEY(country_id,book_id,return_id,warehouse_id) REFERENCES rtn_sales_return(country_id,book_id,id,return_warehouse_id);
ALTER TABLE rtn_sales_inspection ADD FOREIGN KEY(country_id,book_id,return_id) REFERENCES rtn_sales_return(country_id,book_id,id);
ALTER TABLE rtn_sales_settlement ADD UNIQUE(country_id,book_id,id), ADD FOREIGN KEY(country_id,book_id,return_id) REFERENCES rtn_sales_return(country_id,book_id,id);
ALTER TABLE rtn_sales_return ADD FOREIGN KEY(country_id,book_id,order_id) REFERENCES sal_order(country_id,book_id,id), ADD FOREIGN KEY(country_id,book_id,outbound_id) REFERENCES sal_outbound(country_id,book_id,id);
CREATE FUNCTION jxc_return_source_identity() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE h record; source record;
BEGIN
 SELECT * INTO h FROM rtn_sales_return WHERE country_id=NEW.country_id AND id=NEW.return_id;
 IF NOT h.no_origin_flag THEN
  SELECT o.order_id,o.warehouse_id,l.book_id,l.order_line_id,l.product_id,l.outbound_id INTO source FROM sal_outbound_line l JOIN sal_outbound o ON o.country_id=l.country_id AND o.id=l.outbound_id WHERE l.country_id=NEW.country_id AND l.id=NEW.outbound_line_id;
  IF source IS NULL OR ROW(source.book_id,source.order_id,source.outbound_id,source.order_line_id,source.product_id) IS DISTINCT FROM ROW(h.book_id,h.order_id,h.outbound_id,NEW.order_line_id,NEW.product_id) THEN RAISE EXCEPTION 'RETURN_SOURCE_MISMATCH' USING ERRCODE='23503';END IF;
  IF NEW.origin_batch_id IS NOT NULL AND NOT EXISTS(SELECT 1 FROM sal_outbound_batch WHERE country_id=NEW.country_id AND outbound_line_id=NEW.outbound_line_id AND batch_id=NEW.origin_batch_id) THEN RAISE EXCEPTION 'RETURN_BATCH_SOURCE_MISMATCH' USING ERRCODE='23503';END IF;
 ELSE
  IF NOT EXISTS(SELECT 1 FROM cst_inbound_cost c JOIN inv_batch b ON b.country_id=c.country_id AND b.id=c.batch_id WHERE c.country_id=NEW.country_id AND c.id=NEW.cost_snapshot_id AND c.batch_id=NEW.origin_batch_id AND c.book_id=h.book_id AND c.product_id=NEW.product_id AND c.warehouse_id=h.return_warehouse_id AND b.book_id=h.book_id AND b.product_id=NEW.product_id) THEN RAISE EXCEPTION 'RETURN_COST_SOURCE_MISMATCH' USING ERRCODE='23503';END IF;
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER rtn_line_source_identity BEFORE INSERT OR UPDATE ON rtn_sales_return_line FOR EACH ROW EXECUTE FUNCTION jxc_return_source_identity();
CREATE FUNCTION jxc_return_inspection_batch_source() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF NEW.inventory_batch_id IS NOT NULL AND NOT EXISTS(SELECT 1 FROM rtn_sales_return r JOIN rtn_sales_return_line l ON l.country_id=r.country_id AND l.return_id=r.id JOIN inv_batch b ON b.country_id=l.country_id AND b.id=NEW.inventory_batch_id JOIN inv_batch_balance bb ON bb.country_id=b.country_id AND bb.batch_id=b.id AND bb.product_id=b.product_id WHERE r.country_id=NEW.country_id AND r.id=NEW.return_id AND l.id=NEW.return_line_id AND r.book_id=NEW.book_id AND b.book_id=r.book_id AND b.product_id=l.product_id AND bb.warehouse_id=r.return_warehouse_id) THEN RAISE EXCEPTION 'RETURN_INVENTORY_SOURCE_MISMATCH' USING ERRCODE='23503';END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER rtn_inspection_batch_source BEFORE INSERT OR UPDATE ON rtn_sales_inspection FOR EACH ROW EXECUTE FUNCTION jxc_return_inspection_batch_source();
CREATE TABLE rtn_sales_settlement_line (
 id jxc_safe_id PRIMARY KEY DEFAULT nextval('jxc_id_seq'),country_id jxc_safe_id NOT NULL,book_id jxc_safe_id NOT NULL,settlement_id jxc_safe_id NOT NULL,return_id jxc_safe_id NOT NULL,return_line_id jxc_safe_id NOT NULL,outbound_line_id jxc_safe_id,qty numeric(24,6) NOT NULL CHECK(qty>0),amount numeric(24,6) NOT NULL CHECK(amount>=0),version integer NOT NULL DEFAULT 1 CHECK(version>0),created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 UNIQUE(country_id,id),UNIQUE(country_id,settlement_id,return_line_id),FOREIGN KEY(country_id,book_id,settlement_id) REFERENCES rtn_sales_settlement(country_id,book_id,id),FOREIGN KEY(country_id,return_id,return_line_id) REFERENCES rtn_sales_return_line(country_id,return_id,id),FOREIGN KEY(country_id,book_id,outbound_line_id) REFERENCES sal_outbound_line(country_id,book_id,id)
);
ALTER TABLE rtn_sales_settlement_line ENABLE ROW LEVEL SECURITY;
ALTER TABLE rtn_sales_settlement_line FORCE ROW LEVEL SECURITY;
CREATE POLICY country_isolation ON rtn_sales_settlement_line USING(country_id=jxc_current_country_id()) WITH CHECK(country_id=jxc_current_country_id());
GRANT SELECT,INSERT ON rtn_sales_settlement_line TO "${runtimeRole}";
CREATE TRIGGER rtn_settlement_line_period BEFORE INSERT OR UPDATE OR DELETE ON rtn_sales_settlement_line FOR EACH ROW EXECUTE FUNCTION jxc_aprtn_child_guard('rtn_sales_settlement','settlement_id','biz_date');

ALTER TABLE rtn_sales_settlement ADD UNIQUE(country_id,book_id,return_id,id);
ALTER TABLE rtn_sales_settlement_line ADD FOREIGN KEY(country_id,book_id,return_id,settlement_id) REFERENCES rtn_sales_settlement(country_id,book_id,return_id,id);
CREATE FUNCTION jxc_return_settlement_line_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE l record;
BEGIN
 IF TG_OP<>'INSERT' THEN RAISE EXCEPTION 'BUSINESS_FACT_IMMUTABLE' USING ERRCODE='23514';END IF;
 SELECT inspected_qty,outbound_line_id INTO l FROM rtn_sales_return_line WHERE country_id=NEW.country_id AND id=NEW.return_line_id AND return_id=NEW.return_id;
 IF l IS NULL OR NEW.qty<>l.inspected_qty OR NEW.outbound_line_id IS DISTINCT FROM l.outbound_line_id THEN RAISE EXCEPTION 'RETURN_SETTLEMENT_SOURCE_MISMATCH' USING ERRCODE='23503';END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER rtn_settlement_line_source BEFORE INSERT OR UPDATE OR DELETE ON rtn_sales_settlement_line FOR EACH ROW EXECUTE FUNCTION jxc_return_settlement_line_guard();
CREATE FUNCTION jxc_return_settlement_balanced() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE sid bigint; expected numeric; actual numeric;
BEGIN
 sid:=CASE TG_TABLE_NAME WHEN 'rtn_sales_settlement' THEN (to_jsonb(NEW)->>'id')::bigint ELSE (to_jsonb(NEW)->>'settlement_id')::bigint END;
 SELECT total_amount INTO expected FROM rtn_sales_settlement WHERE country_id=NEW.country_id AND id=sid;
 SELECT coalesce(sum(amount),0) INTO actual FROM rtn_sales_settlement_line WHERE country_id=NEW.country_id AND settlement_id=sid;
 IF expected IS DISTINCT FROM actual THEN RAISE EXCEPTION 'RETURN_SETTLEMENT_AMOUNT_INCONSISTENT' USING ERRCODE='23514';END IF;RETURN NULL;
END $$;
CREATE CONSTRAINT TRIGGER rtn_settlement_balanced AFTER INSERT OR UPDATE ON rtn_sales_settlement DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION jxc_return_settlement_balanced();
CREATE CONSTRAINT TRIGGER rtn_settlement_line_balanced AFTER INSERT ON rtn_sales_settlement_line DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION jxc_return_settlement_balanced();

ALTER TABLE ap_credit_note ADD CHECK(status IN ('CONFIRMED','PARTIAL_SETTLED','SETTLED'));
-- Keep four decimal facts exact. Numeric column coercion must not silently
-- accept extra financial precision from a direct runtime SQL writer.
DO $$ DECLARE c record; BEGIN
 FOR c IN SELECT table_name,column_name FROM information_schema.columns WHERE table_schema=current_schema() AND (table_name LIKE 'ap\_%' ESCAPE '\' OR table_name LIKE 'rtn\_%' ESCAPE '\') AND data_type='numeric' AND column_name NOT IN ('rate','settle_rate','unit_price') LOOP
  EXECUTE format('ALTER TABLE %I ADD CONSTRAINT %I CHECK(%I=round(%I,4) AND abs(%I)<=100000000000)',c.table_name,c.table_name||'_'||c.column_name||'_fact_precision',c.column_name,c.column_name,c.column_name);
 END LOOP;
END $$;

ALTER TABLE rtn_sales_return ADD FOREIGN KEY(country_id,entity_id,return_warehouse_id) REFERENCES org_warehouse(country_id,entity_id,id);
ALTER TABLE rtn_purchase_return ADD FOREIGN KEY(country_id,entity_id,warehouse_id) REFERENCES org_warehouse(country_id,entity_id,id);
