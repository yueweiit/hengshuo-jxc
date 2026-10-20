package com.hs.jxc.it;
import com.hs.jxc.common.api.*;
import static org.assertj.core.api.Assertions.*;
import org.junit.jupiter.api.Test;
import java.math.BigDecimal;
import java.util.*;

class InputBoundaryIT {
    final JsonCodec json=new JsonCodec();
    @Test void idsAreExactSafeIntegersAndVersionsAreMandatory() {
        assertThat(Inputs.id(new BigDecimal("9007199254740991"))).isEqualTo(9007199254740991L);
        for(Object v:List.of(0,-1,new BigDecimal("1.5"),new BigDecimal("9007199254740992"),"123"))
            assertThatThrownBy(()->Inputs.id(v)).isInstanceOf(ApiException.class);
        assertThatThrownBy(()->Inputs.version(Map.of())).isInstanceOf(ApiException.class).extracting("code").isEqualTo("SYS_VERSION_REQUIRED");
        assertThat(Inputs.version(Map.of("version",2))).isEqualTo(2);
    }
    @Test void decimalJsonNeverPassesThroughDoubleAndRejectsSilentRounding() {
        var parsed=json.readMap("{\"amount\":100000000000.0000,\"rate\":0.12345678,\"qty\":0.0001}");
        assertThat(parsed.get("amount")).isInstanceOf(BigDecimal.class);
        assertThat(Inputs.decimal(parsed.get("rate"),8,new BigDecimal("1000000"))).isEqualByComparingTo("0.12345678");
        assertThat(Inputs.decimal(parsed.get("amount"),4,new BigDecimal("100000000000"))).isEqualByComparingTo("100000000000");
        assertThatThrownBy(()->Inputs.decimal(new BigDecimal("0.00001"),4,new BigDecimal("100000000000"))).isInstanceOf(ApiException.class);
        assertThatThrownBy(()->Inputs.decimal(new BigDecimal("100000000000.0001"),4,new BigDecimal("100000000000"))).isInstanceOf(ApiException.class);
    }
}
