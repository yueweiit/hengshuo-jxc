package com.hs.jxc.it;
import static org.assertj.core.api.Assertions.*;
import com.hs.jxc.common.api.ApiException;
import com.hs.jxc.sys.integrations.ExternalServiceSecrets;
import java.util.Base64;
import org.junit.jupiter.api.Test;

class ExternalServiceSecretsTest {
    @Test void missingOrMalformedMasterKeyNeverFallsBackToPlaintext(){
        for(String key:new String[]{"","not-base64",Base64.getEncoder().encodeToString(new byte[16])}){
            var secrets=new ExternalServiceSecrets(key);assertThat(secrets.ready()).isFalse();
            assertThatThrownBy(()->secrets.seal("deepseek.key","private-value")).isInstanceOf(ApiException.class).hasMessageNotContaining("private-value");
        }
    }
    @Test void ciphertextCannotBeSwappedBetweenServicesOrOpenedWithAnotherMasterKey(){
        var secrets=new ExternalServiceSecrets(Base64.getEncoder().encodeToString(new byte[32]));
        String first=secrets.seal("deepseek.key","private-value"),second=secrets.seal("deepseek.key","private-value");
        assertThat(first).isNotEqualTo(second).doesNotContain("private-value");
        assertThat(secrets.open("deepseek.key",first)).isEqualTo("private-value");
        assertThatThrownBy(()->secrets.open("n8n.fieldsKey",first)).isInstanceOf(ApiException.class).hasMessageNotContaining("private-value");
        byte[] other=new byte[32];other[0]=1;
        assertThatThrownBy(()->new ExternalServiceSecrets(Base64.getEncoder().encodeToString(other)).open("deepseek.key",first)).isInstanceOf(ApiException.class);
    }
}
