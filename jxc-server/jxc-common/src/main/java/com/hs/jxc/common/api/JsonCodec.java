package com.hs.jxc.common.api;

import java.util.Map;
import org.springframework.stereotype.Component;
import tools.jackson.databind.DeserializationFeature;
import tools.jackson.databind.json.JsonMapper;

@Component
public class JsonCodec {
    private final JsonMapper mapper = JsonMapper.builder().enable(DeserializationFeature.USE_BIG_DECIMAL_FOR_FLOATS).build();
    public String write(Object value) { return mapper.writeValueAsString(value); }
    public <T> T read(String value, Class<T> type) { return mapper.readValue(value, type); }
    @SuppressWarnings("unchecked")
    public Map<String, Object> readMap(String value) { return read(value, Map.class); }
}
