package com.hs.jxc.org.mapper;
import com.baomidou.mybatisplus.annotation.*;
import com.baomidou.mybatisplus.core.mapper.BaseMapper;
import org.apache.ibatis.annotations.Mapper;
@Mapper
public interface CurrencyMapper extends BaseMapper<CurrencyMapper.Currency> {
    @TableName("md_currency")
    class Currency {
        @TableId public Long id;
        public String code;
        public String name;
        public Integer decimals;
        public String status;
        public Integer version;
    }
}
