package com.hs.jxc.common.context;

public record RequestContext(long userId, Long countryId, String traceId, String tokenHash) {}
