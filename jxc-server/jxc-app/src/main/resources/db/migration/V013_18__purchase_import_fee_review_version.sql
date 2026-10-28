ALTER TABLE pur_order_import_group ADD COLUMN fee_todos_version integer NOT NULL DEFAULT 1 CHECK(fee_todos_version>0);
