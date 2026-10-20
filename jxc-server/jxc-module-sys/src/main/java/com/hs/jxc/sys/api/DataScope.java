package com.hs.jxc.sys.api;

import java.util.Set;

/** Positive expansion only: warehouse grants never imply their parent entity or book. */
public record DataScope(boolean all, Set<Long> entities, Set<Long> stores, Set<Long> warehouses, Set<Long> books) {
    public DataScope {
        entities=Set.copyOf(entities); stores=Set.copyOf(stores); warehouses=Set.copyOf(warehouses); books=Set.copyOf(books);
    }
    public static DataScope none() { return new DataScope(false,Set.of(),Set.of(),Set.of(),Set.of()); }
}
