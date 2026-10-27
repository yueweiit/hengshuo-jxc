package com.hs.jxc.it;

import static org.assertj.core.api.Assertions.*;
import com.hs.jxc.common.api.ApiExceptionAdvice;
import java.sql.SQLException;
import org.junit.jupiter.api.Test;
import org.postgresql.util.PSQLException;
import org.postgresql.util.ServerErrorMessage;
import org.springframework.dao.DataIntegrityViolationException;

class ApiExceptionAdviceTest {
    final ApiExceptionAdvice advice=new ApiExceptionAdvice();
    @Test void logisticsTreatmentConstraintIsActionableAndDoesNotLeakTheDatabaseRow() {
        var pg=new PSQLException(new ServerErrorMessage("SERROR\0C23514\0nlgs_fee_cost_treatment_check\0Mprivate SQL and row\0\0"));
        var response=advice.database(new DataIntegrityViolationException("private SQL",pg));
        assertThat(response.getBody().code()).isEqualTo("LGS_FEE_TREATMENT_INVALID");
        assertThat(response.getBody().message()).contains("物流费用","处理类型","错误编号").doesNotContain("private","lgs_fee");
        assertThat(response.getBody().traceId()).isNotBlank();
        assertThat(response.getBody().message()).contains(response.getBody().traceId());
    }
    @Test void foreignKeyMissingFieldAndBusinessCheckHaveDistinctAccurateFallbacks() {
        var fk=message("23503");var required=message("23502");var check=message("23514");
        assertThat(fk).contains("关联资料");assertThat(required).contains("必要数据");assertThat(check).contains("业务校验");
        assertThat(fk).isNotEqualTo(required).isNotEqualTo(check);
        assertThat(fk+required+check).doesNotContain("数据归属","private SQL");
    }
    @Test void existingDuplicatePermissionsAndPeriodResponsesStayCompatible() {
        assertThat(advice.database(failure("23505")).getBody().code()).isEqualTo("MD_DUPLICATE");
        assertThat(advice.database(failure("42501")).getBody().code()).isEqualTo("SYS_FORBIDDEN");
        assertThat(advice.database(new DataIntegrityViolationException("SQL",new SQLException("FIN_PERIOD_CLOSED","P0001"))).getBody().code()).isEqualTo("FIN_PERIOD_CLOSED");
    }
    DataIntegrityViolationException failure(String state){return new DataIntegrityViolationException("private SQL",new SQLException("private row",state));}
    String message(String state){return advice.database(failure(state)).getBody().message();}
}
