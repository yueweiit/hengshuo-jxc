package com.hs.jxc.sys.api;

import com.hs.jxc.common.api.ApiException;
import java.time.Instant;
import java.util.Map;
import java.util.Set;

/** Immutable decision obtained under the transaction's authorization gates. */
public record Access(long userId, Long countryId, boolean platformAdmin, Set<String> permissions,
                     Map<String,String> fieldGroups, DataScope scope, Instant validUntil) {
    public Access { permissions=Set.copyOf(permissions); fieldGroups=Map.copyOf(fieldGroups); }
    public boolean has(String permission) {
        return permissions.stream().anyMatch(p -> p.equals("*") || p.equals(permission)
                || p.endsWith(":*") && permission.startsWith(p.substring(0,p.length()-1)));
    }
    /** Existing array contracts mean any of these alternative permissions. */
    public void require(String... permissions) {
        for (String permission:permissions) if (has(permission)) return;
        throw new ApiException(403,"SYS_FORBIDDEN","没有此操作的权限");
    }
    public long requireCountry() {
        if(countryId==null) throw new ApiException(400,"SYS_COUNTRY_REQUIRED","请先选择国家");
        return countryId;
    }
    public boolean canRow(Map<String,Object> row) {
        if(countryId==null || !same(row.get("countryId"),countryId)) return false;
        if(scope.all()) return true;
        boolean hasRef=false;
        for(String key:new String[]{"entityId","storeId","warehouseId","bookId"}) {
            Long id=number(row.get(key));
            if(id==null) continue;
            hasRef=true;
            Set<Long> allowed=switch(key) {case "entityId"->scope.entities();case "storeId"->scope.stores();case "warehouseId"->scope.warehouses();default->scope.books();};
            if(allowed.contains(id)) return true;
        }
        if(row.get("lines") instanceof Iterable<?> lines) {
            for(Object value:lines) if(value instanceof Map<?,?> line && line.get("allocs") instanceof Iterable<?> allocs)
                for(Object allocation:allocs) if(allocation instanceof Map<?,?> alloc && scope.warehouses().contains(number(alloc.get("warehouseId")))) return true;
        }
        return !hasRef && (!scope.entities().isEmpty() || !scope.stores().isEmpty() || !scope.warehouses().isEmpty() || !scope.books().isEmpty());
    }
    public void requireRow(Map<String,Object> row) {
        if(!canRow(row)) throw new ApiException(404,"NOT_FOUND","记录不存在或不在你的数据范围内");
    }
    public boolean canBook(long bookId) { return countryId!=null && (scope.all() || scope.books().contains(bookId)); }
    private static boolean same(Object a,long b) { Long n=number(a);return n!=null&&n==b; }
    private static Long number(Object value) { return value instanceof Number n?n.longValue():null; }
}
