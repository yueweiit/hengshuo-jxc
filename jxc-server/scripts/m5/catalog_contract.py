"""Pinned PostgreSQL catalog predicates shared by audit and recovery. No writes."""
import re

def literal(value):
    return "'" + str(value).replace("'", "''") + "'"


def canonical_constraint(definition):
    # PG16 dump/reparse only changes this literal-only unbounded-varchar ARRAY.
    # Keep constants, bounded casts and every other expression byte-exact.
    item = r"'(?:[^']|'')*'::character varying"
    pattern = r"ARRAY\[(" + item + r"(?:, " + item + r")*)\]::text\[\]"
    result = re.sub(pattern, lambda m: "ARRAY[" + m.group(1).replace("::character varying", "::character varying::text") + "]", definition)
    parenthesized = r"\(ARRAY\[(" + item + r"(?:, " + item + r")*)\]\)::text\[\]"
    return re.sub(parenthesized,lambda m:"ARRAY["+', '.join('('+value+')::text' for value in re.findall(item,m.group(1)))+"]",result)


def equivalent_definitions(definition):
    return sorted({definition,canonical_constraint(definition)})


def catalog_gaps_query(contract, runtime_role='jxc_app'):
    if not re.fullmatch(r'[a-z_][a-z0-9_]{0,62}', str(runtime_role)):
        raise ValueError('Explicit PostgreSQL runtime role identifier required')
    # This catalog contract is pinned to migration facts, so removed legacy constraints
    # cannot turn into skipped checks. Current constraints are coverage evidence only.
    def text_array(columns):
        return 'ARRAY[' + ','.join(map(literal, columns)) + ']::text[]'

    entries = []
    for fk in contract['foreign_keys']:
        entries.append('(' + ','.join((literal(fk['table']), literal(fk['name']), "'f'",
                                      text_array(fk['columns']), literal(fk['target']),
                                      text_array(fk['target_columns']), 'NULL::text')) + ')')
    for key in contract['source_keys']:
        entries.append('(' + ','.join((literal(key['table']), literal(key['name']), "'i'",
                                      text_array(key['columns']), 'NULL::text', 'NULL::text[]',
                                      literal(key['predicate']) if key['predicate'] is not None else 'NULL::text')) + ')')
    missing = ("WITH expected(t,n,k,cols,target,refs,pred) AS (VALUES " + ','.join(entries) + ") "
               "SELECT e.t AS table_name,e.n AS constraint_name FROM expected e WHERE "
               "(e.k='f' AND NOT EXISTS(SELECT 1 FROM pg_catalog.pg_constraint co "
               "JOIN pg_catalog.pg_class c ON c.oid=co.conrelid JOIN pg_catalog.pg_namespace n ON n.oid=c.relnamespace "
               "WHERE n.nspname='public' AND c.relname=e.t AND co.conname=e.n AND co.contype='f' AND co.convalidated "
               "AND co.confrelid=to_regclass('public.'||quote_ident(e.target)) "
               "AND ARRAY(SELECT a.attname::text FROM unnest(co.conkey) WITH ORDINALITY k(num,ord) "
               "JOIN pg_catalog.pg_attribute a ON a.attrelid=co.conrelid AND a.attnum=k.num ORDER BY k.ord)=e.cols "
               "AND ARRAY(SELECT a.attname::text FROM unnest(co.confkey) WITH ORDINALITY k(num,ord) "
               "JOIN pg_catalog.pg_attribute a ON a.attrelid=co.confrelid AND a.attnum=k.num ORDER BY k.ord)=e.refs)) "
               "OR (e.k='i' AND NOT EXISTS(SELECT 1 FROM pg_catalog.pg_index i JOIN pg_catalog.pg_class c ON c.oid=i.indrelid "
               "JOIN pg_catalog.pg_class x ON x.oid=i.indexrelid JOIN pg_catalog.pg_namespace n ON n.oid=c.relnamespace "
               "WHERE n.nspname='public' AND c.relname=e.t AND x.relname=e.n AND i.indisunique AND i.indisvalid "
               "AND i.indexprs IS NULL AND pg_get_expr(i.indpred,i.indrelid) IS NOT DISTINCT FROM e.pred "
               "AND ARRAY(SELECT a.attname::text FROM unnest(i.indkey) WITH ORDINALITY k(num,ord) "
               "JOIN pg_catalog.pg_attribute a ON a.attrelid=i.indrelid AND a.attnum=k.num ORDER BY k.ord)=e.cols))")
    for trigger in contract.get('required_triggers',[]):
        missing += " UNION ALL SELECT "+literal(trigger['table'])+","+literal(trigger['name'])+" WHERE NOT EXISTS(SELECT 1 FROM pg_trigger t WHERE t.tgrelid=to_regclass("+literal('public.'+trigger['table'])+") AND t.tgname="+literal(trigger['name'])+" AND t.tgenabled="+literal(trigger['enabled'])+" AND pg_get_triggerdef(t.oid,true)="+literal(trigger['definition'])+")"
    for function in contract.get('required_functions',[]):
        definition=function['definition']
        if '${runtimeRole}' in definition:
            token="current_user='${runtimeRole}'"
            if function['signature']!='jxc_period_closing_guard()' or definition.count(token)!=1 or definition.count('${runtimeRole}')!=1:
                raise ValueError('Unexpected runtime role placeholder in catalog contract')
            definition=definition.replace(token,'current_user='+literal(runtime_role))
        missing += " UNION ALL SELECT '<function>',"+literal(function['signature'])+" WHERE NOT EXISTS(SELECT 1 FROM pg_proc p WHERE p.oid=to_regprocedure("+literal(function['signature'])+") AND pg_get_functiondef(p.oid)="+literal(definition)+")"
    for table in contract.get('rls_tables',[]):
        missing += " UNION ALL SELECT "+literal(table)+",'FORCE_RLS' WHERE NOT EXISTS(SELECT 1 FROM pg_class c WHERE c.oid=to_regclass("+literal('public.'+table)+") AND c.relrowsecurity AND c.relforcerowsecurity)"
    for policy in contract.get('required_policies',[]):
        missing += " UNION ALL SELECT "+literal(policy['table'])+","+literal(policy['name'])+" WHERE NOT EXISTS(SELECT 1 FROM pg_policies p WHERE p.schemaname='public' AND p.tablename="+literal(policy['table'])+" AND p.policyname="+literal(policy['name'])+" AND p.cmd="+literal(policy['command'])+" AND p.permissive="+literal(policy['permissive'])+" AND p.roles=ARRAY["+','.join(literal(role) for role in policy['roles'])+"]::name[]"+" AND p.qual IS NOT DISTINCT FROM "+('NULL' if policy['qual'] is None else literal(policy['qual']))+" AND p.with_check IS NOT DISTINCT FROM "+('NULL' if policy['with_check'] is None else literal(policy['with_check']))+")"
    properties=contract.get('column_properties',[])
    if properties:
        rows=[]
        for column in properties:
            definitions='NULL::text[]' if column['default_expression'] is None else text_array(equivalent_definitions(column['default_expression']))
            rows.append('('+','.join((literal(column['table']),literal(column['name']),literal(column['type']),str(column['not_null']).lower(),definitions,literal(column['generated']),literal(column['identity'])))+')')
        expected='VALUES '+','.join(rows)
        missing += (" UNION ALL SELECT e.t,'COLUMN_ATTRIBUTE:'||e.n FROM ("+expected+") e(t,n,ty,required,definitions,generated,identity) WHERE NOT EXISTS(SELECT 1 FROM pg_catalog.pg_attribute a JOIN pg_catalog.pg_class c ON c.oid=a.attrelid JOIN pg_catalog.pg_namespace s ON s.oid=c.relnamespace LEFT JOIN pg_catalog.pg_attrdef d ON d.adrelid=a.attrelid AND d.adnum=a.attnum WHERE s.nspname='public' AND c.relkind='r' AND c.relname=e.t AND a.attname=e.n AND a.attnum>0 AND NOT a.attisdropped AND format_type(a.atttypid,a.atttypmod)=e.ty AND a.attnotnull=e.required AND a.attgenerated::text=e.generated AND a.attidentity::text=e.identity AND ((e.definitions IS NULL AND d.oid IS NULL) OR pg_get_expr(d.adbin,d.adrelid)=ANY(e.definitions)))")
    checks=contract.get('required_checks',[])
    if checks:
        expected='VALUES '+','.join('('+','.join((literal(item['table']),literal(item['name']),text_array(equivalent_definitions(item['definition'])),str(item['validated']).lower(),str(item['no_inherit']).lower()))+')' for item in checks)
        missing += (" UNION ALL SELECT e.t,e.n FROM ("+expected+") e(t,n,definitions,validated,no_inherit) WHERE NOT EXISTS(SELECT 1 FROM pg_catalog.pg_constraint co JOIN pg_catalog.pg_class c ON c.oid=co.conrelid JOIN pg_catalog.pg_namespace s ON s.oid=c.relnamespace WHERE s.nspname='public' AND c.relname=e.t AND co.conname=e.n AND co.contype='c' AND co.convalidated=e.validated AND co.connoinherit=e.no_inherit AND pg_get_constraintdef(co.oid,true)=ANY(e.definitions))")
    if contract.get('exact_columns'):
        # Closure pins the complete captured public catalog, including extension functions.
        # In particular, an extra permissive RLS policy can widen the existing policy by OR.
        # Legacy profiles retain their original required-object coverage semantics.
        def expected_pairs(objects):
            values=','.join('('+literal(item['table'])+','+literal(item['name'])+')' for item in objects)
            return 'VALUES '+values if values else 'SELECT NULL::text,NULL::text WHERE false'

        triggers=expected_pairs(contract['required_triggers'])
        policies=expected_pairs(contract['required_policies'])
        functions=text_array([item['signature'] for item in contract['required_functions']])
        if properties:
            columns=expected_pairs([{'table':item['table'],'name':item['name']} for item in properties])
            missing += (" UNION ALL SELECT c.relname,'UNEXPECTED_COLUMN:'||a.attname FROM pg_catalog.pg_attribute a JOIN pg_catalog.pg_class c ON c.oid=a.attrelid JOIN pg_catalog.pg_namespace s ON s.oid=c.relnamespace WHERE s.nspname='public' AND c.relkind='r' AND c.relname<>'flyway_schema_history' AND a.attnum>0 AND NOT a.attisdropped AND NOT EXISTS(SELECT 1 FROM ("+columns+") e(t,n) WHERE e.t=c.relname AND e.n=a.attname)")
        if checks:
            expected_checks=expected_pairs(checks)
            missing += (" UNION ALL SELECT c.relname,'UNEXPECTED_CHECK:'||co.conname FROM pg_catalog.pg_constraint co JOIN pg_catalog.pg_class c ON c.oid=co.conrelid JOIN pg_catalog.pg_namespace s ON s.oid=c.relnamespace WHERE s.nspname='public' AND co.contype='c' AND NOT EXISTS(SELECT 1 FROM ("+expected_checks+") e(t,n) WHERE e.t=c.relname AND e.n=co.conname)")
        missing += (" UNION ALL SELECT c.relname,'UNEXPECTED_TRIGGER:'||t.tgname "
                    "FROM pg_catalog.pg_trigger t JOIN pg_catalog.pg_class c ON c.oid=t.tgrelid "
                    "JOIN pg_catalog.pg_namespace n ON n.oid=c.relnamespace "
                    "WHERE n.nspname='public' AND NOT t.tgisinternal AND NOT EXISTS(SELECT 1 FROM ("
                    +triggers+") e(t,n) WHERE e.t=c.relname AND e.n=t.tgname)")
        missing += (" UNION ALL SELECT p.tablename,'UNEXPECTED_POLICY:'||p.policyname FROM pg_catalog.pg_policies p "
                    "WHERE p.schemaname='public' AND NOT EXISTS(SELECT 1 FROM ("
                    +policies+") e(t,n) WHERE e.t=p.tablename AND e.n=p.policyname)")
        missing += (" UNION ALL SELECT '<function>','UNEXPECTED_FUNCTION:'||p.oid::regprocedure::text "
                    "FROM pg_catalog.pg_proc p JOIN pg_catalog.pg_namespace n ON n.oid=p.pronamespace "
                    "WHERE n.nspname='public' AND NOT EXISTS(SELECT 1 FROM unnest("
                    +functions+") e(signature) WHERE p.oid=to_regprocedure(e.signature))")
    return missing
