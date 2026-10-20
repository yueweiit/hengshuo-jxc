package com.hs.jxc.sys.jobs;
import java.util.*;
/** CSV escaping shared by authorized module-owned export handlers. */
public final class CsvFiles {
 private CsvFiles(){}
 public static String cell(Object value){if(value==null)return "";String text=value.toString();if(!(value instanceof Number)){String check=text.stripLeading();if(!check.isEmpty()&&"=+-@".indexOf(check.charAt(0))>=0)text="'"+text;}return '"'+text.replace("\"","\"\"")+'"';}
 public static Map<String,Object> file(String filename,Map<String,Object> metadata,List<Map<String,Object>> rows){var csv=new StringBuilder("\uFEFF");for(var entry:metadata.entrySet())csv.append(cell(entry.getKey())).append(',').append(cell(entry.getValue())).append("\r\n");var columns=new LinkedHashSet<String>();rows.forEach(r->columns.addAll(r.keySet()));csv.append(String.join(",",columns.stream().map(CsvFiles::cell).toList())).append("\r\n");for(var row:rows)csv.append(String.join(",",columns.stream().map(k->cell(row.get(k))).toList())).append("\r\n");return Map.of("filename",filename,"content",csv.toString(),"contentType","text/csv; charset=UTF-8");}
}
