package com.hs.jxc.pur.mapper;

import java.sql.*;
import java.util.UUID;
import org.apache.ibatis.type.*;

/** PostgreSQL原生UUID绑定，避免把任务/批次ID当成字符串比较。 */
public final class PurchaseUuidTypeHandler extends BaseTypeHandler<UUID> {
    @Override public void setNonNullParameter(PreparedStatement statement, int index, UUID value, JdbcType type) throws SQLException {
        statement.setObject(index, value, Types.OTHER);
    }
    @Override public UUID getNullableResult(ResultSet result, String column) throws SQLException { return result.getObject(column, UUID.class); }
    @Override public UUID getNullableResult(ResultSet result, int column) throws SQLException { return result.getObject(column, UUID.class); }
    @Override public UUID getNullableResult(CallableStatement statement, int column) throws SQLException { return statement.getObject(column, UUID.class); }
}
