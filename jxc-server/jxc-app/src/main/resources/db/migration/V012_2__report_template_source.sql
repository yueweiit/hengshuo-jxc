-- Configuration provenance only. Source is a frozen cross-country template item, never a copied fact.
ALTER TABLE fin_report_template ADD COLUMN source_template_item_id jxc_safe_id REFERENCES sys_country_template_item(id);
