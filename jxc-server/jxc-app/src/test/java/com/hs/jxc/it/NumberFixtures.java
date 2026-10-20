package com.hs.jxc.it;

/** Explicit synthetic configuration only; never called by migrations or application bootstrap. */
final class NumberFixtures {
    private NumberFixtures(){}
    static void seed(long country,String...types){for(String type:types)PgDatabase.ownerJdbc().update("INSERT INTO sys_doc_number_rule(country_id,doc_type,prefix,date_pattern,sequence_width,reset_period) VALUES(?,?,?,'yyyyMMdd',6,'NONE') ON CONFLICT(country_id,doc_type) DO NOTHING",country,type,type.replace("_","").substring(0,Math.min(20,type.replace("_","").length())));}
}
