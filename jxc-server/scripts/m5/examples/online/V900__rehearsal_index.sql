-- ISOLATED REHEARSAL ONLY. Not on the application's Flyway classpath.
-- prerequisite: examples/online/prepare.sql, in an empty isolated database.
-- This statement MUST execute outside a transaction; the adjacent .sql.conf
-- is read by Flyway when this directory alone is its explicit location.
CREATE UNIQUE INDEX CONCURRENTLY m5_online_example_source_uq
    ON m5_online_example(source_system, source_id);
