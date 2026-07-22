package local.grader;

import com.healthmarketscience.jackcess.Column;
import com.healthmarketscience.jackcess.Database;
import com.healthmarketscience.jackcess.DatabaseBuilder;
import com.healthmarketscience.jackcess.Index;
import com.healthmarketscience.jackcess.Table;
import com.healthmarketscience.jackcess.query.Query;

import java.io.IOException;
import java.nio.file.Path;
import java.text.Normalizer;
import java.util.ArrayList;
import java.util.Comparator;
import java.util.HashMap;
import java.util.List;
import java.util.Locale;
import java.util.Map;

/** Reads Jackcess metadata only; this class never opens a JDBC connection or executes a query. */
public final class JackcessCatalog {
    private static final Comparator<String> NAME_ORDER = Comparator.comparing(JackcessCatalog::key).thenComparing(Comparator.naturalOrder());

    public record Field(String name, String type, boolean required, boolean autoNumber) { }
    public record IndexDefinition(String name, boolean primaryKey, boolean unique, boolean required, List<String> columns) {
        public IndexDefinition { columns = List.copyOf(columns); }
    }
    public record TableDefinition(String name, boolean linked, List<Field> fields, List<String> primaryKey, List<IndexDefinition> indexes) {
        public TableDefinition { fields = List.copyOf(fields); primaryKey = List.copyOf(primaryKey); indexes = List.copyOf(indexes); }
    }
    public record QueryDefinition(String name, String type, String sql, boolean passThrough, boolean parameters, List<ClosureClassifier.Dependency> dependencies) {
        public QueryDefinition { dependencies = List.copyOf(dependencies); }
    }
    public record Snapshot(List<TableDefinition> tables, List<QueryDefinition> queries) {
        public Snapshot { tables = List.copyOf(tables); queries = List.copyOf(queries); }

        public ClosureClassifier.Catalog closureCatalog() {
            List<ClosureClassifier.TableDefinition> closureTables = tables.stream()
                    .map(table -> new ClosureClassifier.TableDefinition(table.name(), table.linked(), false)).toList();
            List<ClosureClassifier.QueryDefinition> closureQueries = queries.stream()
                    .map(query -> new ClosureClassifier.QueryDefinition(query.name(), query.type(), query.sql(), query.passThrough(), query.parameters(), false, false, query.dependencies())).toList();
            return new ClosureClassifier.Catalog(closureTables, closureQueries);
        }
    }

    private JackcessCatalog() { }

    public static Snapshot observe(Path file) throws IOException {
        try (Database database = DatabaseBuilder.open(file.toFile())) {
            return observe(database);
        }
    }

    static Snapshot observe(Database database) throws IOException {
        List<String> tableNames = new ArrayList<>(database.getTableNames());
        tableNames.sort(NAME_ORDER);
        Map<String, String> tableIds = ids(tableNames);
        List<TableDefinition> tables = new ArrayList<>();
        for (String tableName : tableNames) tables.add(table(database, tableName));

        List<Query> sourceQueries = new ArrayList<>(database.getQueries());
        sourceQueries.sort(Comparator.comparing(Query::getName, NAME_ORDER));
        Map<String, String> queryIds = ids(sourceQueries.stream().map(Query::getName).toList());
        List<QueryDefinition> queries = new ArrayList<>();
        for (Query query : sourceQueries) queries.add(query(query, tableIds, queryIds));
        return new Snapshot(tables, queries);
    }

    private static TableDefinition table(Database database, String name) throws IOException {
        Table table = database.getTable(name);
        List<Field> fields = new ArrayList<>();
        for (Column column : table.getColumns()) fields.add(field(column));
        fields.sort(Comparator.comparing(Field::name, NAME_ORDER));
        List<IndexDefinition> indexes = table.getIndexes().stream().map(JackcessCatalog::index).sorted(Comparator.comparing(IndexDefinition::name, NAME_ORDER)).toList();
        List<String> primaryKey = indexes.stream().filter(IndexDefinition::primaryKey).findFirst().map(IndexDefinition::columns).orElse(List.of());
        return new TableDefinition(name, database.isLinkedTable(table), fields, primaryKey, indexes);
    }

    private static Field field(Column column) throws IOException {
        return new Field(column.getName(), column.getType().name(),
                Boolean.TRUE.equals(column.getProperties().getValue("Required")), column.isAutoNumber());
    }

    private static IndexDefinition index(Index index) {
        List<String> columns = index.getColumns().stream().map(Index.Column::getName).toList();
        return new IndexDefinition(index.getName(), index.isPrimaryKey(), index.isUnique(), index.isRequired(), columns);
    }

    private static QueryDefinition query(Query query, Map<String, String> tableIds, Map<String, String> queryIds) {
        String sql = query.toSQLString();
        return new QueryDefinition(query.getName(), query.getType().name(), sql, query.getType() == Query.Type.PASSTHROUGH,
                !query.getParameters().isEmpty(), dependencies(sql, tableIds, queryIds));
    }

    static List<ClosureClassifier.Dependency> dependencies(String sql, Map<String, String> tableIds, Map<String, String> queryIds) {
        List<ClosureClassifier.Dependency> dependencies = new ArrayList<>();
        List<SqlToken> tokens = sqlTokens(sql);
        boolean inFromList = false;
        boolean sourceExpected = false;
        for (int index = 0; index < tokens.size(); index++) {
            SqlToken token = tokens.get(index);
            String keyword = token.keyword();
            if ("FROM".equals(keyword)) {
                inFromList = true;
                sourceExpected = true;
                continue;
            }
            if ("JOIN".equals(keyword)) {
                inFromList = false;
                sourceExpected = true;
                continue;
            }
            if (sourceExpected) {
                if (!token.sourceName()) {
                    dependencies.add(new ClosureClassifier.Dependency("unresolved", "<unknown source>"));
                } else if (index + 2 < tokens.size() && "IN".equals(tokens.get(index + 1).keyword())
                        && tokens.get(index + 2).sourceLocation()) {
                    dependencies.add(new ClosureClassifier.Dependency("external", token.value()));
                    index += 2;
                } else {
                    addDependency(dependencies, token.value(), tableIds, queryIds);
                }
                sourceExpected = false;
                continue;
            }
            if (inFromList && ",".equals(token.value())) {
                sourceExpected = true;
            } else if (inFromList && endsFromList(keyword)) {
                inFromList = false;
            }
        }
        if (sourceExpected) dependencies.add(new ClosureClassifier.Dependency("unresolved", "<unknown source>"));
        return List.copyOf(dependencies);
    }

    private static void addDependency(List<ClosureClassifier.Dependency> dependencies, String id,
                                      Map<String, String> tableIds, Map<String, String> queryIds) {
        String normalized = key(id);
        if (tableIds.containsKey(normalized)) dependencies.add(new ClosureClassifier.Dependency("table", tableIds.get(normalized)));
        else if (queryIds.containsKey(normalized)) dependencies.add(new ClosureClassifier.Dependency("query", queryIds.get(normalized)));
        else dependencies.add(new ClosureClassifier.Dependency("unresolved", id));
    }

    private static boolean endsFromList(String keyword) {
        return "ON".equals(keyword) || "WHERE".equals(keyword) || "HAVING".equals(keyword)
                || "GROUP".equals(keyword) || "ORDER".equals(keyword) || "UNION".equals(keyword)
                || "EXCEPT".equals(keyword) || "INTERSECT".equals(keyword) || "PIVOT".equals(keyword);
    }

    private static List<SqlToken> sqlTokens(String sql) {
        List<SqlToken> tokens = new ArrayList<>();
        if (sql == null) return tokens;
        for (int index = 0; index < sql.length();) {
            char character = sql.charAt(index);
            if (Character.isWhitespace(character)) {
                index++;
            } else if (character == '[') {
                int end = sql.indexOf(']', index + 1);
                if (end < 0) {
                    tokens.add(new SqlToken("?", false, false));
                    break;
                }
                tokens.add(new SqlToken(sql.substring(index + 1, end), true, false));
                index = end + 1;
            } else if (character == '\'' || character == '"') {
                char quote = character;
                int end = index + 1;
                while (end < sql.length()) {
                    if (sql.charAt(end) == quote) {
                        if (end + 1 < sql.length() && sql.charAt(end + 1) == quote) end += 2;
                        else {
                            end++;
                            break;
                        }
                    } else end++;
                }
                tokens.add(new SqlToken(sql.substring(index, end), false, true));
                index = end;
            } else if (Character.isLetter(character) || character == '_') {
                int end = index + 1;
                while (end < sql.length() && (Character.isLetterOrDigit(sql.charAt(end))
                        || sql.charAt(end) == '_' || sql.charAt(end) == '$' || sql.charAt(end) == '.')) end++;
                tokens.add(new SqlToken(sql.substring(index, end), true, false));
                index = end;
            } else {
                tokens.add(new SqlToken(String.valueOf(character), false, false));
                index++;
            }
        }
        return tokens;
    }

    private record SqlToken(String value, boolean identifier, boolean location) {
        String keyword() { return identifier ? value.toUpperCase(Locale.ROOT) : ""; }
        boolean sourceName() { return identifier; }
        boolean sourceLocation() { return identifier || location; }
    }

    private static Map<String, String> ids(List<String> names) {
        Map<String, String> result = new HashMap<>();
        for (String name : names) result.putIfAbsent(key(name), name);
        return result;
    }

    private static String key(String value) { return Normalizer.normalize(value, Normalizer.Form.NFC).toLowerCase(Locale.ROOT); }
}
