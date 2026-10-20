-- Isolated legacy anomalies: current M4 shapes, constraints/triggers removed by test harness.
INSERT INTO sys_country(id,code,name) VALUES(1,'CN','Audit CN'),(2,'MX','Audit MX');
INSERT INTO fin_book(id,country_id,entity_id,code,name,base_currency) VALUES
(11,1,101,'CN1','Audit CN1','CNY'),(12,1,102,'CN2','Audit CN2','CNY'),(22,2,202,'MX','Audit MX','MXN');
INSERT INTO org_warehouse(id,country_id,entity_id,code,name) VALUES(201,1,101,'W1','Audit W1');
INSERT INTO md_product(id,product_code,name) VALUES(1001,'P1','Audit P1');
INSERT INTO md_country_sku(id,country_id,product_id) VALUES(1101,1,1001);
INSERT INTO inv_batch(id,country_id,book_id,product_id,batch_no,source_type,source_id,source_line_id,first_inbound_date,cost_snapshot_id) VALUES
(301,1,11,1001,'B1','LGS_RECEIPT',4001,5001,'2026-01-01',701),
(302,1,11,1001,'B2','LGS_RECEIPT',4001,5001,'2026-01-01',701),
(303,1,22,1001,'B3','LGS_RECEIPT',4002,5002,'2026-01-01',701),
(304,1,11,1001,'B4','LGS_RECEIPT',4003,5003,'2026-01-01',NULL);
INSERT INTO inv_stock_summary(id,country_id,warehouse_id,product_id,on_hand_qty,reserved_qty,frozen_qty) VALUES
(401,1,201,1001,-1,0,0),(402,1,201,1001,3,-1,0),(403,1,201,1001,3,4,0);
INSERT INTO ap_payment(id,country_id,entity_id,book_id,partner_type,partner_id,doc_no,currency,amount,used_amount,fund_account_id,pay_date,status,confirmed_by,proof_attachment_id) VALUES
(501,1,101,11,'SUPPLIER',6001,'PAY1','CNY',10,12,7001,'2026-01-01','CONFIRMED',8001,NULL);
INSERT INTO fin_account(id,country_id,book_id,code,name,category,direction) VALUES(610,1,12,'A1','Audit A1','ASSET','DEBIT');
INSERT INTO fin_voucher_line(id,country_id,book_id,voucher_id,seq,account_id,currency,orig_amount,rate,debit,credit) VALUES
(601,1,11,620,1,610,'CNY',10,1,10,0);
INSERT INTO cst_inbound_cost(id,country_id,book_id,warehouse_id,product_id,batch_id,source_type,source_line_id,qty,src_currency,base_currency,status,biz_date,method,method_version) VALUES
(701,1,11,201,1001,301,'LGS_RECEIPT',5001,5,'USD','CNY','PENDING_RATE','2026-01-01','FIFO',1);
INSERT INTO sys_biz_event(id,country_id,book_id,event_type,source_type,source_id,event_seq,payload,biz_date,status) VALUES
(801,1,11,'SALE_OUTBOUND','SAL_OUTBOUND',810,1,'{}','2026-01-01','NEW'),
(802,1,11,'INVENTORY_NOTE','INV_NOTE',820,1,'{}','2026-01-01','DONE'),
(803,1,11,'TECHNICAL_TEST','SYS_TEST',830,1,'{}','2026-01-01','NEW');
INSERT INTO fin_mapping_template(id,country_id,book_id,event_type,version_no,status,accounting_mode,no_voucher_reason,reviewed_by,reviewed_at,created_by) VALUES
(850,1,11,'INVENTORY_NOTE',1,'ACTIVE','NO_VOUCHER','approved no-voucher policy',8001,now(),8001);
INSERT INTO fin_event_result(id,country_id,book_id,event_id,source_event_version,mapping_template_id,mapping_version,status,reason,fact_hash,prepared_by) VALUES
(860,1,11,802,1,850,1,'NO_VOUCHER','approved no-voucher policy',repeat('a',64),8001);
INSERT INTO sys_attachment_link(id,country_id,attachment_id,biz_type,biz_id,version_no,linked_by) VALUES
(901,1,999,'AP_PAYMENT',501,1,8001);
