-- Preserve legacy EXPENSE rows while accepting the canonical period-expense type.
ALTER TABLE lgs_fee DROP CONSTRAINT lgs_fee_cost_treatment_check;
ALTER TABLE lgs_fee ADD CONSTRAINT lgs_fee_cost_treatment_check
    CHECK (cost_treatment IN ('CAPITALIZE', 'EXPENSE', 'PERIOD_EXPENSE'));
