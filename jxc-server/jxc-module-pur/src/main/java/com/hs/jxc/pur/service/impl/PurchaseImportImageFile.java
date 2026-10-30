package com.hs.jxc.pur.service.impl;

import com.hs.jxc.attachment.AttachmentAssetService;
import com.hs.jxc.common.api.*;
import java.io.*;
import java.util.*;
import javax.imageio.ImageIO;

/** 手工上传须真正可解码，不能只信任扩展名或浏览器声明。 */
final class PurchaseImportImageFile {
    record Image(String mime,int width,int height) {}
    static Image inspect(String name,String mime,byte[] bytes) {
        if(bytes==null||bytes.length==0||bytes.length>AttachmentAssetService.Policy.PURCHASE_IMAGE.maxBytes)
            throw new ApiException(413,"PUR_IMPORT_ASSET_LIMIT","照片不能为空且不能超过10MiB");
        if(name==null||!name.toLowerCase(Locale.ROOT).matches(".+\\.(png|jpe?g|gif)")||!Set.of("image/png","image/jpeg","image/gif").contains(Objects.toString(mime,"")))
            throw Inputs.bad("请选择PNG、JPG或GIF照片");
        try(var stream=ImageIO.createImageInputStream(new ByteArrayInputStream(bytes))) {
            var readers=ImageIO.getImageReaders(stream);
            if(!readers.hasNext())throw Inputs.bad("文件不是可读取的照片");
            var reader=readers.next();
            try {
                reader.setInput(stream,true,true);
                String format=reader.getFormatName().toLowerCase(Locale.ROOT);
                String actual=switch(format){case "png"->"image/png";case "jpeg","jpg"->"image/jpeg";case "gif"->"image/gif";default->throw Inputs.bad("照片格式不受支持");};
                String suffix=name.substring(name.lastIndexOf('.')+1).toLowerCase(Locale.ROOT);
                if(!actual.equals(mime)||!(suffix.equals(format)||actual.equals("image/jpeg")&&Set.of("jpg","jpeg").contains(suffix)))throw Inputs.bad("照片真实格式与文件类型或扩展名不一致");
                int width=reader.getWidth(0),height=reader.getHeight(0);
                if(width<=0||height<=0||(long)width*height>40_000_000)throw Inputs.bad("照片尺寸无效或超过4000万像素，请缩小后上传");
                if(reader.read(0)==null)throw Inputs.bad("照片内容不完整，请重新选择");
                return new Image(actual,width,height);
            } finally { reader.dispose(); }
        } catch(IOException|IllegalArgumentException error) { throw Inputs.bad("照片内容无法解码，请重新选择有效照片"); }
    }
    private PurchaseImportImageFile() {}
}
