package com.hs.jxc.sys.integrations;

import com.hs.jxc.common.api.ApiException;
import java.nio.ByteBuffer;
import java.nio.charset.StandardCharsets;
import java.security.SecureRandom;
import java.util.Base64;
import javax.crypto.Cipher;
import javax.crypto.spec.GCMParameterSpec;
import javax.crypto.spec.SecretKeySpec;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.stereotype.Component;

/** 主密钥只来自运行环境；服务名和字段名参与认证，防止交换密文。 */
@Component
public class ExternalServiceSecrets {
    private final byte[] key;
    public ExternalServiceSecrets(@Value("${jxc.integrations.master-key:}") String encoded) {
        byte[] decoded;
        try { decoded=Base64.getDecoder().decode(encoded); } catch(IllegalArgumentException invalid) { decoded=new byte[0]; }
        key=decoded.length==32?decoded:null;
    }
    public boolean ready(){return key!=null;}
    public String seal(String context,String value){
        requireKey();
        try {
            byte[] iv=new byte[12];new SecureRandom().nextBytes(iv);
            var cipher=Cipher.getInstance("AES/GCM/NoPadding");
            cipher.init(Cipher.ENCRYPT_MODE,new SecretKeySpec(key,"AES"),new GCMParameterSpec(128,iv));
            cipher.updateAAD(context.getBytes(StandardCharsets.UTF_8));
            byte[] encrypted=cipher.doFinal(value.getBytes(StandardCharsets.UTF_8));
            return "v1:"+Base64.getEncoder().encodeToString(ByteBuffer.allocate(iv.length+encrypted.length).put(iv).put(encrypted).array());
        }catch(Exception error){throw new ApiException(503,"INTEGRATION_ENCRYPTION_FAILED","服务密钥加密失败，配置未保存");}
    }
    public String open(String context,String value){
        requireKey();
        try {
            if(!value.startsWith("v1:"))throw new IllegalArgumentException();
            byte[] data=Base64.getDecoder().decode(value.substring(3));
            if(data.length<28)throw new IllegalArgumentException();
            var cipher=Cipher.getInstance("AES/GCM/NoPadding");
            cipher.init(Cipher.DECRYPT_MODE,new SecretKeySpec(key,"AES"),new GCMParameterSpec(128,data,0,12));
            cipher.updateAAD(context.getBytes(StandardCharsets.UTF_8));
            return new String(cipher.doFinal(data,12,data.length-12),StandardCharsets.UTF_8);
        }catch(Exception error){throw new ApiException(503,"INTEGRATION_DECRYPTION_FAILED","服务密钥无法解密，请核对运行环境主密钥，未回退旧配置");}
    }
    private void requireKey(){if(!ready())throw new ApiException(503,"INTEGRATION_MASTER_KEY_REQUIRED","请先在运行环境配置32字节Base64格式的服务加密主密钥");}
}
