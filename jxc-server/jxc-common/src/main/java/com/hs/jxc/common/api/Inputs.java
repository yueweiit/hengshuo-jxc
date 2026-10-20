package com.hs.jxc.common.api;
import java.math.BigDecimal;
import java.util.Map;
public final class Inputs {
    /** Frozen JSON-number boundary; individual domains may choose a tighter bound. */
    public static final BigDecimal PUBLIC_DECIMAL_MAX=new BigDecimal("100000000000");
    private Inputs(){}
    public static long id(Object value){
        if(!(value instanceof Number))throw bad("ID必须是安全整数");
        try{BigDecimal n=new BigDecimal(value.toString());long id=n.longValueExact();if(id<1||id>9007199254740991L)throw bad("ID超出安全整数范围");return id;}
        catch(ArithmeticException|NumberFormatException e){throw bad("ID必须是安全整数");}
    }
    public static long version(Map<String,Object> body){
        if(body.get("version")==null)throw new ApiException(400,"SYS_VERSION_REQUIRED","修改时必须提供version");
        long version=id(body.get("version"));if(version>Integer.MAX_VALUE)throw bad("版本不合法");return version;
    }
    public static BigDecimal decimal(Object value,int scale,BigDecimal max){
        if(!(value instanceof Number)||value instanceof Double||value instanceof Float)throw bad("请使用十进制数值");
        try{BigDecimal n=new BigDecimal(value.toString());if(n.stripTrailingZeros().scale()>scale||n.abs().compareTo(max.min(PUBLIC_DECIMAL_MAX))>0)throw bad("数值精度或大小超出接口范围");return n;}
        catch(NumberFormatException e){throw bad("数值不合法");}
    }
    public static String required(Map<String,Object> b,String key){String v=text(b,key,null);if(v==null||v.isBlank())throw bad("请填写"+key);return v.trim();}
    public static String text(Map<String,Object> b,String key,String fallback){Object v=b.get(key);if(v==null)return fallback;if(!(v instanceof String))throw bad(key+"必须是文本");return (String)v;}
    public static ApiException bad(String message){return new ApiException(400,"SYS_BAD_REQUEST",message);}
    public static ApiException conflict(){return new ApiException(409,"SYS_VERSION_CONFLICT","记录已被他人修改，请刷新后重试");}
}
