-- ISOLATED REHEARSAL ONLY. Run manually in the explicitly approved empty DB.
-- This is a synthetic operations fixture, never a business-data import.
CREATE TABLE m5_online_example (
    id bigint PRIMARY KEY,
    source_system text NOT NULL,
    source_id text NOT NULL,
    qty numeric(18,4) NOT NULL
);
INSERT INTO m5_online_example(id,source_system,source_id,qty)
    SELECT n,'isolated-synthetic',n::text,1 FROM generate_series(1,10000) AS n;
-- New writes are checked immediately. Existing rows are validated separately.
ALTER TABLE m5_online_example ADD CONSTRAINT m5_online_example_qty_ck CHECK(qty>=0) NOT VALID;
