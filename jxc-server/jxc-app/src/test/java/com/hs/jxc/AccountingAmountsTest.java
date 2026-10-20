package com.hs.jxc;
import com.hs.jxc.fin.accounting.AccountingAmounts;
import com.hs.jxc.common.api.ApiException;
import java.math.BigDecimal;
import java.util.List;
import org.junit.jupiter.api.Test;
import static org.assertj.core.api.Assertions.*;
class AccountingAmountsTest {
    List<BigDecimal> parts(String... values){return java.util.Arrays.stream(values).map(BigDecimal::new).toList();}
    @Test void frozenPartsRoundCumulativelyWithoutLosingSourceCents(){
        assertThat(AccountingAmounts.split(new BigDecimal("1"),parts("0.3333","0.3333","0.3334"),2)).containsExactlyElementsOf(parts("0.33","0.34","0.33"));
        assertThat(AccountingAmounts.split(new BigDecimal("-1"),parts("-0.3333","-0.3333","-0.3334"),2)).containsExactlyElementsOf(parts("-0.33","-0.34","-0.33"));
        assertThat(AccountingAmounts.split(new BigDecimal("0.005"),parts("0.005"),2)).containsExactly(new BigDecimal("0.01"));
    }
    @Test void mismatchedSourcePartsFailRatherThanBeingPaddedWithInventedMoney(){
        assertThatThrownBy(()->AccountingAmounts.split(new BigDecimal("1"),parts("0.8","0.1"),2)).isInstanceOf(ApiException.class).extracting("code").isEqualTo("FIN_SOURCE_INCOMPLETE");
        assertThatThrownBy(()->AccountingAmounts.split(BigDecimal.ZERO,List.of(),2)).isInstanceOf(ApiException.class);
    }
}
