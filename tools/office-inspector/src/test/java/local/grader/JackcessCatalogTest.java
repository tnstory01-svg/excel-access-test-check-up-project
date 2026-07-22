package local.grader;

import com.healthmarketscience.jackcess.ColumnBuilder;
import com.healthmarketscience.jackcess.DataType;
import com.healthmarketscience.jackcess.Database;
import com.healthmarketscience.jackcess.DatabaseBuilder;
import com.healthmarketscience.jackcess.IndexBuilder;
import com.healthmarketscience.jackcess.TableBuilder;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;

import java.nio.file.Path;
import java.util.List;
import java.util.Map;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;

import static org.junit.jupiter.api.Assertions.assertTrue;
class JackcessCatalogTest {
    @TempDir
    Path temporaryDirectory;

    @Test
    void observesTableFieldPrimaryKeyAndIndexMetadataInStableOrder() throws Exception {
        Path file = temporaryDirectory.resolve("catalog.accdb");
        try (Database database = DatabaseBuilder.create(Database.FileFormat.V2010, file.toFile())) {
            new TableBuilder("Zeta")
                    .addColumn(new ColumnBuilder("name", DataType.TEXT))
                    .addColumn(new ColumnBuilder("id", DataType.LONG).putProperty("Required", true))
                    .addIndex(new IndexBuilder("zName").addColumns("name"))
                    .addIndex(new IndexBuilder("primary").addColumns("id").setPrimaryKey())
                    .toTable(database);
            new TableBuilder("Alpha").addColumn(new ColumnBuilder("value", DataType.TEXT)).toTable(database);
        }

        JackcessCatalog.Snapshot snapshot = JackcessCatalog.observe(file);

        assertEquals(List.of("Alpha", "Zeta"), snapshot.tables().stream().map(JackcessCatalog.TableDefinition::name).toList());
        JackcessCatalog.TableDefinition zeta = snapshot.tables().get(1);
        assertEquals(List.of("id", "name"), zeta.fields().stream().map(JackcessCatalog.Field::name).toList());
        assertEquals(List.of("id"), zeta.primaryKey());
        assertEquals(List.of("primary", "zName"), zeta.indexes().stream().map(JackcessCatalog.IndexDefinition::name).toList());
        assertFalse(zeta.linked());
    }
    @Test
    void discoversEveryCommaSeparatedFromSourceAndFailsClosedForUnknownRoles() {
        Map<String, String> tables = Map.of("local", "Local", "linked", "Linked");
        List<ClosureClassifier.Dependency> dependencies = JackcessCatalog.dependencies(
                "SELECT * FROM [Local] AS l, Linked AS x, [Missing] AS m", tables, Map.of());

        assertEquals(List.of(
                new ClosureClassifier.Dependency("table", "Local"),
                new ClosureClassifier.Dependency("table", "Linked"),
                new ClosureClassifier.Dependency("unresolved", "Missing")), dependencies);

        JackcessCatalog.Snapshot snapshot = new JackcessCatalog.Snapshot(
                List.of(
                        new JackcessCatalog.TableDefinition("Local", false, List.of(), List.of(), List.of()),
                        new JackcessCatalog.TableDefinition("Linked", true, List.of(), List.of(), List.of())),
                List.of(new JackcessCatalog.QueryDefinition("Q", "SELECT", "SELECT * FROM Local, Linked",
                        false, false, dependencies.subList(0, 2))));
        assertEquals(new ClosureClassifier.Result(ClosureClassifier.State.UNSUPPORTED, "EXTERNAL_OR_LINKED_REFERENCE"),
                ClosureClassifier.classify(snapshot.closureCatalog(), "Q"));
        assertTrue(dependencies.stream().anyMatch(dependency -> "unresolved".equals(dependency.kind())));
    }

    @Test
    void marksUnprovableAndExternalFromRolesAsUnsupportedDependencies() {
        List<ClosureClassifier.Dependency> dependencies = JackcessCatalog.dependencies(
                "SELECT * FROM (SELECT * FROM Local) AS derived, Remote IN 'C:\\\\remote.accdb'", Map.of("local", "Local"), Map.of());

        assertEquals(List.of(
                new ClosureClassifier.Dependency("unresolved", "<unknown source>"),
                new ClosureClassifier.Dependency("table", "Local"),
                new ClosureClassifier.Dependency("external", "Remote")), dependencies);
    }
}
