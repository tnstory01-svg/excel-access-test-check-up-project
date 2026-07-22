package local.grader;

import java.text.Normalizer;
import java.util.ArrayList;
import java.util.HashMap;
import java.util.HashSet;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.Set;

/** Fail-closed policy for Access query definitions.  It never executes SQL. */
public final class ClosureClassifier {
    private static final Set<String> VOLATILE = Set.of("NOW", "DATE", "TIME", "TIMER", "RND", "RANDOMIZE", "ENVIRON", "CURRENTUSER");
    private static final Set<String> SAFE_FUNCTIONS = Set.of("ABS", "AVG", "COUNT", "MAX", "MIN", "SUM");
    private static final Set<String> DISALLOWED_STATEMENT_KEYWORDS = Set.of("ALTER", "CREATE", "DELETE", "DROP", "EXEC", "INSERT", "UPDATE");

    public enum State { SUPPORTED, UNSUPPORTED }

    public record Result(State state, String reason) { }
    public record Dependency(String kind, String id) { }
    public record QueryDefinition(String id, String type, String sql, boolean passThrough, boolean parameters,
                                  boolean udf, boolean volatileFunction, List<Dependency> dependencies) {
        public QueryDefinition {
            dependencies = List.copyOf(dependencies);
        }
    }
    public record TableDefinition(String id, boolean linked, boolean external) { }
    public record Catalog(List<TableDefinition> tables, List<QueryDefinition> queries) {
        public Catalog {
            tables = List.copyOf(tables);
            queries = List.copyOf(queries);
        }
    }
    public record OrderColumn(String name, boolean nullable, boolean unique) { }

    private ClosureClassifier() { }

    public static Result classify(Catalog catalog, String queryId) {
        return classify(catalog, queryId, false, List.of());
    }

    public static Result classify(Catalog catalog, String queryId, boolean queryResult, List<OrderColumn> orderBy) {
        Map<String, QueryDefinition> queries = uniqueQueries(catalog.queries());
        if (queries == null) return unsupported("AMBIGUOUS_QUERY_IDENTIFIER");
        Map<String, TableDefinition> tables = uniqueTables(catalog.tables());
        if (tables == null) return unsupported("AMBIGUOUS_TABLE_IDENTIFIER");
        if (queryResult) {
            String orderFailure = validateOrder(orderBy);
            if (orderFailure != null) return unsupported(orderFailure);
        }
        return new Walker(queries, tables).walk(queryId);
    }

    private static final class Walker {
        private final Map<String, QueryDefinition> queries;
        private final Map<String, TableDefinition> tables;
        private final Set<String> visiting = new HashSet<>();
        private final Set<String> visited = new HashSet<>();

        private Walker(Map<String, QueryDefinition> queries, Map<String, TableDefinition> tables) {
            this.queries = queries;
            this.tables = tables;
        }

        private Result walk(String id) {
            String key = key(id);
            if (visiting.contains(key)) return unsupported("DEPENDENCY_CYCLE");
            if (visited.contains(key)) return supported();
            QueryDefinition query = queries.get(key);
            if (query == null) return unsupported("UNRESOLVED_REFERENCE");
            if (!("SELECT".equals(query.type()) || "UNION".equals(query.type()))) return unsupported("UNSUPPORTED_QUERY_TYPE");
            if (query.passThrough()) return unsupported("PASS_THROUGH_QUERY");
            if (query.parameters()) return unsupported("PARAMETER_QUERY");
            if (query.udf()) return unsupported("UDF_OR_UNAPPROVED_FUNCTION");
            if (query.volatileFunction()) return unsupported("VOLATILE_FUNCTION");
            String sqlFailure = rejectSql(query.sql(), queries, tables);
            if (sqlFailure != null) return unsupported(sqlFailure);
            visiting.add(key);
            for (Dependency dependency : query.dependencies()) {
                if ("table".equals(dependency.kind())) {
                    TableDefinition table = tables.get(key(dependency.id()));
                    if (table == null) return unsupported("UNRESOLVED_REFERENCE");
                    if (table.linked() || table.external()) return unsupported("EXTERNAL_OR_LINKED_REFERENCE");
                } else if ("query".equals(dependency.kind())) {
                    Result result = walk(dependency.id());
                    if (result.state() == State.UNSUPPORTED) return result;
                } else if ("external".equals(dependency.kind())) {
                    return unsupported("EXTERNAL_OR_LINKED_REFERENCE");
                } else {
                    return unsupported("UNRESOLVED_REFERENCE");
                }
            }
            visiting.remove(key);
            visited.add(key);
            return supported();
        }
    }

    private static Map<String, QueryDefinition> uniqueQueries(List<QueryDefinition> definitions) {
        Map<String, QueryDefinition> result = new HashMap<>();
        for (QueryDefinition definition : definitions) if (result.putIfAbsent(key(definition.id()), definition) != null) return null;
        return result;
    }

    private static Map<String, TableDefinition> uniqueTables(List<TableDefinition> definitions) {
        Map<String, TableDefinition> result = new HashMap<>();
        for (TableDefinition definition : definitions) if (result.putIfAbsent(key(definition.id()), definition) != null) return null;
        return result;
    }

    private static String validateOrder(List<OrderColumn> orderBy) {
        if (orderBy == null || orderBy.isEmpty()) return "ORDER_REQUIRED";
        Set<String> seen = new HashSet<>();
        for (OrderColumn column : orderBy) {
            if (column == null || column.name() == null || column.name().isEmpty() || column.nullable() || !column.unique() || !seen.add(key(column.name()))) {
                return "AMBIGUOUS_ORDER_KEY";
            }
        }
        return null;
    }

    private static String rejectSql(String sql, Map<String, QueryDefinition> queries, Map<String, TableDefinition> tables) {
        List<String> tokens = tokens(sql);
        if (tokens == null || tokens.isEmpty()) return "UNSUPPORTED_QUERY_SHAPE";
        if (tokens.contains("TRANSFORM")) return "TRANSFORM_QUERY";
        if (!"SELECT".equals(tokens.getFirst())) return "UNSUPPORTED_QUERY_SHAPE";
        boolean inSourceList = false;
        boolean expectingSource = false;
        for (int index = 0; index < tokens.size(); index++) {
            String token = tokens.get(index);
            if (";".equals(token) && index != tokens.size() - 1) return "UNSUPPORTED_QUERY_SHAPE";
            if (DISALLOWED_STATEMENT_KEYWORDS.contains(token)) {
                return "UNSUPPORTED_QUERY_SHAPE";
            }
            if ("FROM".equals(token) || "JOIN".equals(token)) {
                inSourceList = true;
                expectingSource = true;
            } else if (endsSourceList(token)) {
                inSourceList = false;
                expectingSource = false;
            } else if ("ON".equals(token)) {
                inSourceList = false;
                expectingSource = false;
            } else if (inSourceList && ",".equals(token)) {
                expectingSource = true;
            }
            if (token.startsWith("BRACKET:") && (!inSourceList || !expectingSource
                    || (!queries.containsKey(key(token.substring("BRACKET:".length())))
                    && !tables.containsKey(key(token.substring("BRACKET:".length())))))) {
                return "PARAMETER_QUERY";
            }
            if (inSourceList && expectingSource && !"FROM".equals(token) && !"JOIN".equals(token) && !",".equals(token)) expectingSource = false;
        }
        if (tokens.contains("PARAMETERS") || tokens.contains("?")) return "PARAMETER_QUERY";
        if (tokens.contains("INTO")) return "SELECT_INTO_QUERY";
        for (int index = 0; index + 1 < tokens.size(); index++) {
            String token = tokens.get(index);
            if ("(".equals(tokens.get(index + 1)) && token.matches("[A-Z_][A-Z0-9_$]*")) {
                if (VOLATILE.contains(token)) return "VOLATILE_FUNCTION";
                if (!SAFE_FUNCTIONS.contains(token)) return "UDF_OR_UNAPPROVED_FUNCTION";
            }
        }
        return null;
    }
    private static boolean endsSourceList(String token) {
        return "WHERE".equals(token) || "GROUP".equals(token) || "ORDER".equals(token)
                || "HAVING".equals(token) || "UNION".equals(token);
    }


    private static List<String> tokens(String sql) {
        if (sql == null) return null;
        List<String> tokens = new ArrayList<>();
        for (int i = 0; i < sql.length();) {
            if (sql.startsWith("--", i)) { int end = sql.indexOf('\n', i + 2); if (end < 0) break; i = end; continue; }
            if (sql.startsWith("/*", i)) { int end = sql.indexOf("*/", i + 2); if (end < 0) return null; i = end + 2; continue; }
            if (sql.charAt(i) == '\'') {
                i++;
                while (i < sql.length()) { if (sql.charAt(i) == '\'' && i + 1 < sql.length() && sql.charAt(i + 1) == '\'') { i += 2; continue; } if (sql.charAt(i++) == '\'') break; }
                if (i == 0 || sql.charAt(i - 1) != '\'') return null;
                tokens.add("LITERAL"); continue;
            }
            if (sql.charAt(i) == '[') { int end = sql.indexOf(']', i + 1); if (end < 0) return null; tokens.add("BRACKET:" + sql.substring(i + 1, end)); i = end + 1; continue; }
            if (Character.isLetter(sql.charAt(i)) || sql.charAt(i) == '_') { int start = i++; while (i < sql.length() && (Character.isLetterOrDigit(sql.charAt(i)) || sql.charAt(i) == '_' || sql.charAt(i) == '$')) i++; tokens.add(sql.substring(start, i).toUpperCase(Locale.ROOT)); continue; }
            if (!Character.isWhitespace(sql.charAt(i))) tokens.add(String.valueOf(sql.charAt(i)));
            i++;
        }
        return tokens;
    }

    private static String key(String value) {
        return Normalizer.normalize(String.valueOf(value), Normalizer.Form.NFKC)
                .toUpperCase(Locale.ROOT).toLowerCase(Locale.ROOT);
    }
    private static Result supported() { return new Result(State.SUPPORTED, "STATIC_LOCAL_SELECT_UNION_CLOSURE"); }
    private static Result unsupported(String reason) { return new Result(State.UNSUPPORTED, reason); }
}
