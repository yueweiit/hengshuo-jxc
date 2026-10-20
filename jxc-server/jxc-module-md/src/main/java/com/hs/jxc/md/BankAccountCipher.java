package com.hs.jxc.md;
import com.hs.jxc.common.api.ApiException;
import java.nio.charset.StandardCharsets;
import java.security.SecureRandom;
import java.util.Base64;
import javax.crypto.Cipher;
import javax.crypto.spec.GCMParameterSpec;
import javax.crypto.spec.SecretKeySpec;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.stereotype.Component;
/** Shared MD bank protection; ciphertext and secrets never enter DTOs or audit snapshots. */
@Component
public class BankAccountCipher {
 private final String encodedKey;private final SecureRandom random=new SecureRandom();
 public BankAccountCipher(@Value("${jxc.bank-encryption-key:${JXC_BANK_ENCRYPTION_KEY:}}") String key){this.encodedKey=key;}
 public boolean configured(){try{key();return true;}catch(Exception e){return false;}}
 private byte[] key(){if(encodedKey==null||encodedKey.isBlank())throw missing();try{byte[] value=Base64.getDecoder().decode(encodedKey);if(value.length!=32)throw missing();return value;}catch(IllegalArgumentException e){throw missing();}}
 public String encrypt(String account){try{byte[] key=key();byte[] nonce=new byte[12];random.nextBytes(nonce);Cipher cipher=Cipher.getInstance("AES/GCM/NoPadding");cipher.init(Cipher.ENCRYPT_MODE,new SecretKeySpec(key,"AES"),new GCMParameterSpec(128,nonce));byte[] ciphertext=cipher.doFinal(account.getBytes(StandardCharsets.UTF_8));return "v1:"+Base64.getEncoder().encodeToString(nonce)+":"+Base64.getEncoder().encodeToString(ciphertext);}catch(ApiException e){throw e;}catch(Exception e){throw missing();}}
 private ApiException missing(){return new ApiException(503,"MD_BANK_ENCRYPTION_REQUIRED","请配置有效的银行账户加密密钥后保存原始账号");}
}
