package local.grader;

import org.junit.jupiter.api.Test;

import java.util.List;

import static org.junit.jupiter.api.Assertions.assertEquals;

class ClosureClassifierTest {
    @Test
    void supportsLocalSelectUnionClosure() {
        ClosureClassifier.Catalog catalog = catalog(List.of(new ClosureClassifier.TableDefinition("Students", false, false)), List.of(
                query("qBase", "SELECT", "SELECT id FROM Students", dependency("table", "Students")),
                query("qTop", "UNION", "SELECT id FROM qBase UNION SELECT id FROM qBase", dependency("query", "qBase"))));
        assertResult(catalog, "qTop", ClosureClassifier.State.SUPPORTED, "STATIC_LOCAL_SELECT_UNION_CLOSURE");
    }

    @Test
    void rejectsOracleNegativeClasses() {
        assertResult(catalog(List.of(), List.of(query("q", "UPDATE", "UPDATE T SET x=1"))), "q", ClosureClassifier.State.UNSUPPORTED, "UNSUPPORTED_QUERY_TYPE");
        assertResult(catalog(List.of(), List.of(query("q", "SELECT", "SELECT x INTO NewTable FROM T"))), "q", ClosureClassifier.State.UNSUPPORTED, "SELECT_INTO_QUERY");
        assertResult(catalog(List.of(), List.of(new ClosureClassifier.QueryDefinition("q", "SELECT", "SELECT x FROM T", true, false, false, false, List.of()))), "q", ClosureClassifier.State.UNSUPPORTED, "PASS_THROUGH_QUERY");
        assertResult(catalog(List.of(), List.of(query("q", "SELECT", "SELECT x FROM T WHERE x = ?"))), "q", ClosureClassifier.State.UNSUPPORTED, "PARAMETER_QUERY");
        assertResult(catalog(List.of(new ClosureClassifier.TableDefinition("RemoteT", true, false)), List.of(query("q", "SELECT", "SELECT x FROM RemoteT", dependency("table", "RemoteT")))), "q", ClosureClassifier.State.UNSUPPORTED, "EXTERNAL_OR_LINKED_REFERENCE");
        assertResult(catalog(List.of(), List.of(query("q", "SELECT", "SELECT MyFunction(x) FROM T"))), "q", ClosureClassifier.State.UNSUPPORTED, "UDF_OR_UNAPPROVED_FUNCTION");
        assertResult(catalog(List.of(), List.of(query("q", "SELECT", "SELECT Now()"))), "q", ClosureClassifier.State.UNSUPPORTED, "VOLATILE_FUNCTION");
        assertResult(catalog(List.of(), List.of(query("q", "SELECT", "TRANSFORM SUM(x) SELECT y FROM T"))), "q", ClosureClassifier.State.UNSUPPORTED, "TRANSFORM_QUERY");
    }
    @Test
    void rejectsTrailingStatementsAndUnresolvedBracketedParameters() {
        assertResult(catalog(List.of(), List.of(query("q", "SELECT", "SELECT 1; SELECT 2"))), "q", ClosureClassifier.State.UNSUPPORTED, "UNSUPPORTED_QUERY_SHAPE");
        assertResult(catalog(List.of(), List.of(query("q", "SELECT", "SELECT 1; DELETE FROM T"))), "q", ClosureClassifier.State.UNSUPPORTED, "UNSUPPORTED_QUERY_SHAPE");
        assertResult(catalog(List.of(), List.of(query("q", "SELECT", "SELECT 1; CREATE TABLE T (id INT)"))), "q", ClosureClassifier.State.UNSUPPORTED, "UNSUPPORTED_QUERY_SHAPE");
        assertResult(catalog(List.of(), List.of(query("q", "SELECT", "SELECT 1; UPDATE T SET x = 1"))), "q", ClosureClassifier.State.UNSUPPORTED, "UNSUPPORTED_QUERY_SHAPE");
        assertResult(catalog(List.of(new ClosureClassifier.TableDefinition("Students", false, false)), List.of(query("q", "SELECT", "SELECT id FROM [Students];", dependency("table", "Students")))), "q", ClosureClassifier.State.SUPPORTED, "STATIC_LOCAL_SELECT_UNION_CLOSURE");
        assertResult(catalog(List.of(new ClosureClassifier.TableDefinition("Students", false, false)), List.of(query("q", "SELECT", "SELECT id FROM [Students] WHERE id = [Enter student id]", dependency("table", "Students")))), "q", ClosureClassifier.State.UNSUPPORTED, "PARAMETER_QUERY");
    }
    @Test
    void rejectsCatalogNamedBracketOperandsAndPrompts() {
        ClosureClassifier.Catalog catalog = catalog(List.of(new ClosureClassifier.TableDefinition("Students", false, false)), List.of(
                query("qOperand", "SELECT", "SELECT [Students] FROM Students", dependency("table", "Students")),
                query("qPrompt", "SELECT", "SELECT id FROM Students WHERE id = [Students]", dependency("table", "Students")),
                query("qSelectComma", "SELECT", "SELECT id, [Students] FROM Students", dependency("table", "Students")),
                query("qWhereComma", "SELECT", "SELECT id FROM Students WHERE id IN ([Students], 2)", dependency("table", "Students"))));
        assertResult(catalog, "qOperand", ClosureClassifier.State.UNSUPPORTED, "PARAMETER_QUERY");
        assertResult(catalog, "qPrompt", ClosureClassifier.State.UNSUPPORTED, "PARAMETER_QUERY");
        assertResult(catalog, "qSelectComma", ClosureClassifier.State.UNSUPPORTED, "PARAMETER_QUERY");
        assertResult(catalog, "qWhereComma", ClosureClassifier.State.UNSUPPORTED, "PARAMETER_QUERY");
    }
    @Test
    void supportsBracketedLocalCommaSourceListsAndRejectsExternalSources() {
        ClosureClassifier.Catalog local = catalog(List.of(
                new ClosureClassifier.TableDefinition("Students", false, false),
                new ClosureClassifier.TableDefinition("Classes", false, false)), List.of(
                query("q", "SELECT", "SELECT id FROM [Students], [Classes]",
                        dependency("table", "Students"), dependency("table", "Classes"))));
        assertResult(local, "q", ClosureClassifier.State.SUPPORTED, "STATIC_LOCAL_SELECT_UNION_CLOSURE");

        ClosureClassifier.Catalog external = catalog(List.of(
                new ClosureClassifier.TableDefinition("Students", false, false),
                new ClosureClassifier.TableDefinition("RemoteClasses", true, false)), List.of(
                query("q", "SELECT", "SELECT id FROM [Students], [RemoteClasses]",
                        dependency("table", "Students"), dependency("table", "RemoteClasses"))));
        assertResult(external, "q", ClosureClassifier.State.UNSUPPORTED, "EXTERNAL_OR_LINKED_REFERENCE");
    }

    @Test
    void rejectsUnicodeCaseFoldIdentifierCollisions() {
        ClosureClassifier.Catalog tableCollision = catalog(List.of(
                new ClosureClassifier.TableDefinition("straße", false, false),
                new ClosureClassifier.TableDefinition("STRASSE", false, false)), List.of());
        assertResult(tableCollision, "q", ClosureClassifier.State.UNSUPPORTED, "AMBIGUOUS_TABLE_IDENTIFIER");

        ClosureClassifier.Catalog queryCollision = catalog(List.of(), List.of(
                query("straße", "SELECT", "SELECT 1"),
                query("STRASSE", "SELECT", "SELECT 1")));
        assertResult(queryCollision, "straße", ClosureClassifier.State.UNSUPPORTED, "AMBIGUOUS_QUERY_IDENTIFIER");
    }

    @Test
    void rejectsCyclesAndAmbiguousResultOrdering() {
        ClosureClassifier.Catalog cycle = catalog(List.of(), List.of(
                query("a", "SELECT", "SELECT x FROM b", dependency("query", "b")),
                query("b", "SELECT", "SELECT x FROM a", dependency("query", "a"))));
        assertResult(cycle, "a", ClosureClassifier.State.UNSUPPORTED, "DEPENDENCY_CYCLE");
        ClosureClassifier.Catalog simple = catalog(List.of(), List.of(query("q", "SELECT", "SELECT 1")));
        ClosureClassifier.Result result = ClosureClassifier.classify(simple, "q", true, List.of(new ClosureClassifier.OrderColumn("id", true, true)));
        assertEquals(new ClosureClassifier.Result(ClosureClassifier.State.UNSUPPORTED, "AMBIGUOUS_ORDER_KEY"), result);
    }

    private static ClosureClassifier.Catalog catalog(List<ClosureClassifier.TableDefinition> tables, List<ClosureClassifier.QueryDefinition> queries) { return new ClosureClassifier.Catalog(tables, queries); }
    private static ClosureClassifier.Dependency dependency(String kind, String id) { return new ClosureClassifier.Dependency(kind, id); }
    private static ClosureClassifier.QueryDefinition query(String id, String type, String sql, ClosureClassifier.Dependency... dependencies) { return new ClosureClassifier.QueryDefinition(id, type, sql, false, false, false, false, List.of(dependencies)); }
    private static void assertResult(ClosureClassifier.Catalog catalog, String id, ClosureClassifier.State state, String reason) { assertEquals(new ClosureClassifier.Result(state, reason), ClosureClassifier.classify(catalog, id)); }
}
