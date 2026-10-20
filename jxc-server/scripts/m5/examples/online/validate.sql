-- ISOLATED REHEARSAL ONLY. Separate step, after source reconciliation.
ALTER TABLE m5_online_example VALIDATE CONSTRAINT m5_online_example_qty_ck;
-- Attach the already-built unique index without rebuilding it in a long tx.
ALTER TABLE m5_online_example ADD CONSTRAINT m5_online_example_source_uq
    UNIQUE USING INDEX m5_online_example_source_uq;
