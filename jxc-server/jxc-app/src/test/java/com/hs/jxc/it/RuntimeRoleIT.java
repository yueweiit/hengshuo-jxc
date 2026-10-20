package com.hs.jxc.it;
import com.hs.jxc.RuntimeRoleVerifier;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import static org.assertj.core.api.Assertions.*;
class RuntimeRoleIT extends BasePgIT {
    @Autowired RuntimeRoleVerifier verifier;
    @Test void startupRejectsOwnerSuperuserAndInheritedOwnerEvenWhenFlywayWasDisabled(){
        verifier.verify(jdbc);
        assertThatThrownBy(()->verifier.verify(owner)).isInstanceOf(IllegalStateException.class);
        seed("GRANT jxc_owner TO jxc_app");
        try{assertThatThrownBy(()->verifier.verify(jdbc)).isInstanceOf(IllegalStateException.class);}finally{seed("REVOKE jxc_owner FROM jxc_app");}
    }
    @Test void startupRejectsDatabaseAndAlternateSchemaCreationPrivileges(){
        seed("GRANT CREATE ON DATABASE jxc_m01_test TO jxc_app");
        try{assertThatThrownBy(()->verifier.verify(jdbc)).isInstanceOf(IllegalStateException.class);}finally{seed("REVOKE CREATE ON DATABASE jxc_m01_test FROM jxc_app");}
        seed("CREATE SCHEMA unsafe_test_schema");seed("GRANT USAGE,CREATE ON SCHEMA unsafe_test_schema TO jxc_app");
        try{assertThatThrownBy(()->verifier.verify(jdbc)).isInstanceOf(IllegalStateException.class);}finally{seed("DROP SCHEMA unsafe_test_schema");}
    }
    @Test void startupRejectsPgUnderscoreLookalikeSchemasAndNonTableRelationOwners(){
        seed("CREATE SCHEMA pgx_runtime_it");seed("GRANT USAGE,CREATE ON SCHEMA pgx_runtime_it TO jxc_app");
        try{assertThatThrownBy(()->verifier.verify(jdbc)).isInstanceOf(IllegalStateException.class);}finally{seed("DROP SCHEMA pgx_runtime_it");}
        seed("CREATE SEQUENCE runtime_owned_sequence_it");seed("ALTER SEQUENCE runtime_owned_sequence_it OWNER TO jxc_app");
        try{assertThatThrownBy(()->verifier.verify(jdbc)).isInstanceOf(IllegalStateException.class);}finally{seed("DROP SEQUENCE runtime_owned_sequence_it");}
    }
    @Test void startupRejectsEffectiveHighPrivilegeMembershipWithoutOwnedRelations(){
        seed("CREATE ROLE runtime_high_privilege_it CREATEROLE");seed("GRANT runtime_high_privilege_it TO jxc_app");
        try{assertThatThrownBy(()->verifier.verify(jdbc)).isInstanceOf(IllegalStateException.class);}finally{seed("REVOKE runtime_high_privilege_it FROM jxc_app");seed("DROP ROLE runtime_high_privilege_it");}
    }
}
