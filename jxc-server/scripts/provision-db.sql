-- Run explicitly as the administrator against a NEW, operator-named database.
-- psql -v expected_database=the_exact_new_database -f scripts/provision-db.sql
\set ON_ERROR_STOP on
SELECT current_database() = :'expected_database' AS jxc_expected_target \gset
\if :jxc_expected_target
\else
  \echo 'Refusing unexpected database target.'
  \quit 1
\endif
BEGIN;
CREATE ROLE jxc_owner LOGIN NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE;
CREATE ROLE jxc_app LOGIN NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE;
REVOKE CREATE ON SCHEMA public FROM PUBLIC;
GRANT USAGE, CREATE ON SCHEMA public TO jxc_owner;
GRANT USAGE ON SCHEMA public TO jxc_app;
CREATE EXTENSION IF NOT EXISTS btree_gist;
COMMIT;
-- Set each password interactively in psql using \password jxc_owner and \password jxc_app.
-- Passwords are not embedded in this file or command-line arguments.
