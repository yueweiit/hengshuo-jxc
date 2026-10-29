package com.hs.jxc.pur.service.impl;

import com.hs.jxc.common.api.ApiException;
import com.hs.jxc.attachment.AttachmentObjectStore;
import java.io.*;
import java.math.*;
import java.nio.file.Path;
import java.util.*;
import java.util.regex.Pattern;
import java.util.zip.*;
import javax.xml.XMLConstants;
import javax.xml.parsers.DocumentBuilderFactory;
import org.w3c.dom.*;

/** 按工作簿内容读取系统模板。只有合法的非模板返回 empty；损坏、精度和来源错误直接报错。 */
public final class PurchaseXlsxTemplateParser {
    private static final String MAIN="http://schemas.openxmlformats.org/spreadsheetml/2006/main";
    private static final String REL="http://schemas.openxmlformats.org/officeDocument/2006/relationships";
    private static final String DRAW="http://schemas.openxmlformats.org/drawingml/2006/spreadsheetDrawing";
    private static final String ART="http://schemas.openxmlformats.org/drawingml/2006/main";
    private static final List<String> HEADERS=List.of("采购单号","商品照片","商品规格","采购数量","单件售价","售价合计","供应商单价（采购单价）","运费","到货单位成本","美元单位成本","美元成本合计");
    private record Sheet(String name,String part,Document xml,LinkedHashMap<Integer,Map<String,Element>> rows,Integer header) {}
    private static ApiException bad(String message){return new ApiException(422,"SOURCE_XLSX_INVALID",message);}
    public Optional<Map<String,Object>> parse(byte[] bytes,String name,String selection){
        if(bytes.length==0||bytes.length>100L*1024*1024)throw bad("采购文件须非空且不超过100MiB");
        try {
            var archive=archive(bytes);var strings=new ArrayList<String>();
            if(archive.containsKey("xl/sharedStrings.xml"))for(var item:elements(xml(archive,"xl/sharedStrings.xml"),MAIN,"si"))strings.add(text(item,MAIN,"t"));
            var links=relations(archive,"xl/workbook.xml");var sheets=new ArrayList<Sheet>();
            for(var sheet:elements(xml(archive,"xl/workbook.xml"),MAIN,"sheet")){
                String part=links.get(sheet.getAttributeNS(REL,"id"));var doc=xml(archive,part);var rows=new LinkedHashMap<Integer,Map<String,Element>>();Integer header=null;
                for(var row:elements(doc,MAIN,"row")){
                    int number=Integer.parseInt(row.getAttribute("r"));var cells=new LinkedHashMap<String,Element>();
                    for(var cell:elements(row,MAIN,"c"))cells.put(cell.getAttribute("r").replaceAll("[0-9]",""),cell);
                    rows.put(number,cells);boolean match=true;
                    for(int i=0;i<HEADERS.size();i++)if(!HEADERS.get(i).equals(value(cells.get(Character.toString('A'+i)),strings))){match=false;break;}
                    if(match&&header==null)header=number;
                }
                sheets.add(new Sheet(sheet.getAttribute("name"),part,doc,rows,header));
            }
            var matching=sheets.stream().filter(s->s.header!=null).toList();if(matching.isEmpty())return Optional.empty();
            if(selection==null&&matching.size()>1)throw new ApiException(422,"SHEET_SELECTION_REQUIRED","多个工作表符合模板，请选择采购工作表",Map.of("sheets",matching.stream().map(Sheet::name).toList()));
            var selected=matching.stream().filter(s->selection==null||s.name.equals(selection)).findFirst().orElseThrow(()->bad("所选工作表不符合模板"));
            var out=new LinkedHashMap<String,Object>();out.put("format","SourceDocumentV1");var sourceInfo=new LinkedHashMap<String,Object>(Map.of("fileSha256",AttachmentObjectStore.sha256(bytes),"fileName",name,"bytes",bytes.length,"parserVersion","java-template-v1"));out.put("source",sourceInfo);
            var rows=new ArrayList<Map<String,Object>>();var warnings=new ArrayList<Map<String,Object>>();var images=new ArrayList<Map<String,Object>>();var associations=new ArrayList<Map<String,Object>>();var sheetInfo=new ArrayList<Map<String,Object>>();
            for(var sheet:sheets){
                var sourceRows=new ArrayList<Map<String,Object>>();
                for(var entry:sheet.rows.entrySet()){var values=new LinkedHashMap<String,Object>();entry.getValue().forEach((col,cell)->values.put(col,value(cell,strings)));sourceRows.add(Map.of("sourceRow",entry.getKey(),"values",values));}
                sheetInfo.add(Map.of("name",sheet.name,"role",sheet==selected?"PURCHASE":sheet.header!=null?"UNSELECTED":"PARAMETERS","sourceRows",sourceRows));
            }
            var shared=new HashMap<String,Element>();
            for(var cells:selected.rows.values())for(var cell:cells.values()){var f=first(cell,MAIN,"f");if(f!=null&&"shared".equals(f.getAttribute("t"))&&!f.getTextContent().isBlank())shared.put(f.getAttribute("si"),cell);}
            for(var entry:selected.rows.entrySet()){
                int number=entry.getKey();if(number<=selected.header)continue;var cells=entry.getValue();var original=new LinkedHashMap<String,Object>();cells.forEach((col,cell)->original.put(col,value(cell,strings)));
                if(original.values().stream().allMatch(v->v==null||v.toString().isBlank()))continue;
                if(Set.of("合计","总计","total","TOTAL","subtotal").contains(Objects.toString(original.get("A"),"")))continue;
                var normalized=new LinkedHashMap<String,Object>();var numeric=new LinkedHashMap<String,Object>();var formulas=new LinkedHashMap<String,Object>();var cached=new LinkedHashMap<String,Object>();
                for(var item:cells.entrySet()){
                    var cell=item.getValue();String raw=value(cell,strings);if((!cell.hasAttribute("t")||"n".equals(cell.getAttribute("t")))&&raw!=null)numeric.put(item.getKey(),raw);
                    var f=first(cell,MAIN,"f");if(f!=null){String formula=f.getTextContent();
                        if(formula.isBlank()){
                            var origin=shared.get(f.getAttribute("si"));if(origin==null)throw bad("共享公式缺少来源，无法保存完整溯源");
                            formula=translate(first(origin,MAIN,"f").getTextContent(),origin.getAttribute("r"),cell.getAttribute("r"));
                        }
                        formulas.put(item.getKey(),"="+formula);cached.put(item.getKey(),raw);
                    }
                }
                for(int i=0;i<HEADERS.size();i++){
                    String col=Character.toString('A'+i),field=PurchaseImportServiceImpl.FIELDS.get(i),raw=(String)original.get(col);Object normalizedValue=null;
                    if(raw!=null&&!raw.isBlank()){
                        if(i<3)normalizedValue=raw.trim();else{
                            var v=new BigDecimal(raw);if(v.signum()<0||v.precision()-v.scale()>(i==3?16:20)||i==3&&(v.signum()==0||v.stripTrailingZeros().scale()>4))throw bad("原第"+number+"行"+col+"列数值或数量精度无效");
                            normalizedValue=v.setScale(i==3?4:10,RoundingMode.HALF_UP).toPlainString();
                        }
                    }else if(formulas.containsKey(col))warnings.add(Map.of("code","FORMULA_CACHE_MISSING","sourceRow",number,"field",field,"message","公式无缓存值，待核实"));
                    normalized.put(field,normalizedValue);
                }
                if(normalized.get("sourceOrderNo")==null||normalized.get("purchaseQty")==null)throw bad("原第"+number+"行缺少采购单号或数量");
                var row=new LinkedHashMap<String,Object>();row.put("sourceSheet",selected.name);row.put("sourceRow",number);row.put("sourceItemKey","D"+number);row.put("sourceCells",Map.of("purchaseQty","D"+number));row.put("originalValues",original);row.put("rawNumericTexts",numeric);row.put("formulas",formulas);row.put("cachedValues",cached);row.put("normalizedValues",normalized);rows.add(row);
                if(rows.size()>10000)throw bad("采购明细超过10000行");
            }
            if(rows.isEmpty())throw bad("采购工作表没有明细");
            var known=new HashSet<String>();
            for(var drawing:elements(selected.xml,MAIN,"drawing")){
                String part=relations(archive,selected.part).get(drawing.getAttributeNS(REL,"id"));var imageLinks=relations(archive,part);
                for(var anchor:children(xml(archive,part).getDocumentElement()))for(var blip:elements(anchor,ART,"blip")){
                    String media=imageLinks.get(blip.getAttributeNS(REL,"embed"));byte[] content=archive.get(media);if(content==null||content.length==0||content.length>10*1024*1024)throw bad("原图缺失或超过10MiB");String sha=AttachmentObjectStore.sha256(content);
                    if(known.add(sha)){
                        try(var input=javax.imageio.ImageIO.createImageInputStream(new ByteArrayInputStream(content))){var readers=javax.imageio.ImageIO.getImageReaders(input);if(!readers.hasNext())throw bad("原图格式无法读取");var reader=readers.next();try{reader.setInput(input);String format=reader.getFormatName().toLowerCase(Locale.ROOT);String mime=switch(format){case "jpg","jpeg"->"image/jpeg";case "png"->"image/png";case "gif"->"image/gif";case "webp"->"image/webp";default->throw bad("原图格式不支持");};var image=new LinkedHashMap<String,Object>();image.put("imageId",sha);image.put("sha256",sha);image.put("mimeType",mime);image.put("bytes",content.length);image.put("width",reader.getWidth(0));image.put("height",reader.getHeight(0));image.put("mediaPart",media);image.put("contentBase64",Base64.getEncoder().encodeToString(content));images.add(image);}finally{reader.dispose();}}
                    }
                    var from=first(anchor,DRAW,"from");Integer sourceRow=from==null?null:Integer.parseInt(text(from,DRAW,"row"))+1;var association=new LinkedHashMap<String,Object>();association.put("imageId",sha);association.put("sourceSheet",selected.name);association.put("sourceRow",sourceRow);association.put("anchor",Map.of("type",anchor.getLocalName(),"xml",serialize(anchor)));association.put("status","UNCONFIRMED");associations.add(association);
                }
            }
            sourceInfo.put("fileRows",rows.size());out.put("rows",rows);out.put("sheets",sheetInfo);out.put("images",images);out.put("associations",associations);out.put("warnings",warnings);out.put("errors",List.of());return Optional.of(out);
        }catch(ApiException e){throw e;}catch(Exception e){throw bad("工作簿损坏或包含无法校验的内容，请核对原文件");}
    }
    private static Map<String,byte[]> archive(byte[] bytes)throws IOException{
        // ZipInputStream只验证本地条目，另核对中央目录结束记录，避免截断文件被误报完整。
        int end=-1;
        for(int i=bytes.length-22;i>=Math.max(0,bytes.length-65557);i--)if(bytes[i]==0x50&&bytes[i+1]==0x4b&&bytes[i+2]==0x05&&bytes[i+3]==0x06){end=i;break;}
        if(end<0)throw bad("工作簿压缩目录缺失或文件被截断");
        var directory=java.nio.ByteBuffer.wrap(bytes).order(java.nio.ByteOrder.LITTLE_ENDIAN);
        int comment=Short.toUnsignedInt(directory.getShort(end+20));
        long centralSize=Integer.toUnsignedLong(directory.getInt(end+12)),centralOffset=Integer.toUnsignedLong(directory.getInt(end+16));
        if(end+22+comment!=bytes.length||centralOffset+centralSize!=end||directory.getShort(end+4)!=0||directory.getShort(end+6)!=0)throw bad("工作簿压缩目录不完整或不支持分卷文件");
        var result=new LinkedHashMap<String,byte[]>();long total=0;
        try(var zip=new ZipInputStream(new ByteArrayInputStream(bytes))){for(ZipEntry e;(e=zip.getNextEntry())!=null;){String p=e.getName();if(p.startsWith("/")||p.contains("\\")||Arrays.asList(p.split("/")).contains("..")||result.containsKey(p))throw bad("工作簿含重复或非法路径");var buffer=new ByteArrayOutputStream();byte[] chunk=new byte[8192];for(int n;(n=zip.read(chunk))!=-1;){total+=n;if(total>512L*1024*1024)throw bad("工作簿展开超过512MiB");buffer.write(chunk,0,n);}result.put(p,buffer.toByteArray());if(result.size()>20000)throw bad("工作簿部件过多");}}
        if(!result.containsKey("xl/workbook.xml")||result.size()!=Short.toUnsignedInt(directory.getShort(end+10)))throw bad("工作簿损坏，部件清单不完整");return result;
    }
    private static Document xml(Map<String,byte[]> archive,String part)throws Exception{
        byte[] data=archive.get(part);if(data==null)throw bad("工作簿部件或关系缺失");var factory=DocumentBuilderFactory.newInstance();factory.setNamespaceAware(true);factory.setFeature("http://apache.org/xml/features/disallow-doctype-decl",true);factory.setAttribute(XMLConstants.ACCESS_EXTERNAL_DTD,"");factory.setAttribute(XMLConstants.ACCESS_EXTERNAL_SCHEMA,"");return factory.newDocumentBuilder().parse(new ByteArrayInputStream(data));
    }
    private static Map<String,String> relations(Map<String,byte[]> archive,String part)throws Exception{
        if(part==null)throw bad("工作簿关系缺失");int slash=part.lastIndexOf('/');String directory=part.substring(0,slash+1),name=directory+"_rels/"+part.substring(slash+1)+".rels";var result=new HashMap<String,String>();if(!archive.containsKey(name))return result;
        for(var r:children(xml(archive,name).getDocumentElement())){if("External".equals(r.getAttribute("TargetMode")))continue;String target=r.getAttribute("Target");String resolved=Path.of(target.startsWith("/")?target.substring(1):directory+target).normalize().toString().replace('\\','/');if(!resolved.startsWith("xl/"))throw bad("工作簿关系路径越界");result.put(r.getAttribute("Id"),resolved);}return result;
    }
    private static List<Element> children(Element parent){var out=new ArrayList<Element>();for(Node n=parent.getFirstChild();n!=null;n=n.getNextSibling())if(n instanceof Element e)out.add(e);return out;}
    private static List<Element> elements(Node node,String namespace,String name){NodeList nodes=node instanceof Document d?d.getElementsByTagNameNS(namespace,name):((Element)node).getElementsByTagNameNS(namespace,name);var out=new ArrayList<Element>();for(int i=0;i<nodes.getLength();i++)out.add((Element)nodes.item(i));return out;}
    private static Element first(Element node,String namespace,String name){var nodes=elements(node,namespace,name);return nodes.isEmpty()?null:nodes.getFirst();}
    private static String text(Element node,String namespace,String name){return elements(node,namespace,name).stream().map(Element::getTextContent).reduce("",String::concat);}
    private static String value(Element cell,List<String> strings){if(cell==null)return null;if("inlineStr".equals(cell.getAttribute("t")))return text(cell,MAIN,"t");var v=first(cell,MAIN,"v");if(v==null)return null;String raw=v.getTextContent();return "s".equals(cell.getAttribute("t"))?strings.get(Integer.parseInt(raw)):raw;}
    private static String serialize(Element node)throws Exception{var factory=javax.xml.transform.TransformerFactory.newInstance();factory.setAttribute(XMLConstants.ACCESS_EXTERNAL_DTD,"");factory.setAttribute(XMLConstants.ACCESS_EXTERNAL_STYLESHEET,"");var out=new StringWriter();factory.newTransformer().transform(new javax.xml.transform.dom.DOMSource(node),new javax.xml.transform.stream.StreamResult(out));return out.toString();}
    private static String translate(String formula,String origin,String target){
        // 共享公式仅移动明确的A1引用；字符串和复杂引用留待核实，避免保存错误的展开式。
        if(formula.contains("\"")||formula.contains("[")||formula.contains("!"))throw bad("共享公式含复杂引用，需要核实");
        int deltaRow=Integer.parseInt(target.replaceAll("[A-Z]",""))-Integer.parseInt(origin.replaceAll("[A-Z]",""));int deltaCol=column(target)-column(origin);
        var matcher=Pattern.compile("(?<![A-Za-z0-9_])([\\$]?)([A-Z]{1,3})([\\$]?)([1-9][0-9]*)(?![A-Za-z0-9_(])").matcher(formula);var out=new StringBuilder();
        while(matcher.find()){int col=column(matcher.group(2))+(matcher.group(1).isEmpty()?deltaCol:0),row=Integer.parseInt(matcher.group(4))+(matcher.group(3).isEmpty()?deltaRow:0);if(col<1||row<1)throw bad("共享公式引用越界");String letters="";while(col>0){col--;letters=(char)('A'+col%26)+letters;col/=26;}matcher.appendReplacement(out,java.util.regex.Matcher.quoteReplacement(matcher.group(1)+letters+matcher.group(3)+row));}return matcher.appendTail(out).toString();
    }
    private static int column(String ref){int result=0;for(char c:ref.toCharArray()){if(c<'A'||c>'Z')break;result=result*26+c-'A'+1;}return result;}
}
