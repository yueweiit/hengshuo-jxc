package com.hs.jxc.common.db;
import java.util.*;
import java.sql.*;
import org.postgresql.util.PGobject;

/** Explicit JDBC query results keep public camelCase and stable ISO dates. */
public final class DbRows {
    private DbRows(){}
    public static Map<String,Object> camel(Map<String,Object> row){
        var out=new LinkedHashMap<String,Object>();
        row.forEach((k,v)->out.put(camelKey(k),value(v)));return out;
    }
    private static Object value(Object v){
        if(v instanceof Timestamp t)return t.toInstant().toString();
        if(v instanceof java.sql.Date d)return d.toLocalDate().toString();
        if(v instanceof java.time.temporal.TemporalAccessor)return v.toString();
        if(v instanceof PGobject p)return p.getValue();
        return v;
    }
    public static String camelKey(String key){StringBuilder b=new StringBuilder();boolean upper=false;for(char c:key.toCharArray()){if(c=='_')upper=true;else{b.append(upper?Character.toUpperCase(c):c);upper=false;}}return b.toString();}
}
