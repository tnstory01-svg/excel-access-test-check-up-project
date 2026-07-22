package local.grader;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertThrows;
import org.junit.jupiter.api.Test;

final class FormulaCanonicalizerTest {
    @Test
    void preservesCollisionOracleTokenBoundaries() throws Exception {
        assertEquals("=SUM(B7:D7 C6:C8)", FormulaCanonicalizer.canonicalize("= sum( B7:D7   C6:C8 )"));
        assertEquals("=SUM(B7:D7,C6:C8)", FormulaCanonicalizer.canonicalize("=sum(B7:D7, C6:C8)"));
        assertThrows(FormulaCanonicalizer.UnsupportedFormulaException.class,
                () -> FormulaCanonicalizer.canonicalize("=SUM(B7:D7C6:C8)"));
    }
    @Test
    void preservesDefinedNameReferenceIntersectionBoundaries() throws Exception {
        assertEquals("=NamedRange A1", FormulaCanonicalizer.canonicalize("=NamedRange   A1"));
        assertEquals("=SUM(NamedRange A1)", FormulaCanonicalizer.canonicalize("=sum(NamedRange A1)"));
    }

    @Test
    void preservesQuotedAndLiteralSpacesAndStructuredReferences() throws Exception {
        assertEquals("='Q1 Data'!A1+'O''Brien'!A1", FormulaCanonicalizer.canonicalize("= 'Q1 Data'!A1 + 'O''Brien'!A1"));
        assertEquals("=SUM(Table1[North West])", FormulaCanonicalizer.canonicalize("=sum(Table1[North West])"));
        assertEquals("=IF(A1=\"North West\",\"keep this space\",\"\")",
                FormulaCanonicalizer.canonicalize("=if(A1 = \"North West\", \"keep this space\", \"\")"));
    }
    @Test
    void preservesWholeRowAndColumnIntersectionsAndUnions() throws Exception {
        assertEquals("=SUM(1:3 2:4,A:C B:D)", FormulaCanonicalizer.canonicalize(
                "=sum(1:3   2:4, A:C   B:D)"));
    }
    @Test
    void preservesOrRejectsParenthesizedReferenceIntersectionsWithoutStrippingThem() throws Exception {
        assertEquals("=SUM((A1) B1)", FormulaCanonicalizer.canonicalize("=sum((A1)   B1)"));
        assertThrows(FormulaCanonicalizer.UnsupportedFormulaException.class,
                () -> FormulaCanonicalizer.canonicalize("=SUM(A1   (B1))"));
    }

    @Test
    void rejectsCompleteUnicodeWhitespaceSetOutsideStringLiteralsAndPreservesItInside() throws Exception {
        int[] unicodeWhitespace = {
                0x0009, 0x000A, 0x000B, 0x000C, 0x000D, 0x0020, 0x0085, 0x00A0, 0x1680,
                0x2000, 0x2001, 0x2002, 0x2003, 0x2004, 0x2005, 0x2006, 0x2007, 0x2008,
                0x2009, 0x200A, 0x2028, 0x2029, 0x202F, 0x205F, 0x3000
        };
        for (int codePoint : unicodeWhitespace) {
            String whitespace = String.valueOf((char) codePoint);
            if (codePoint == 0x0020) {
                assertEquals("=A1 B1", FormulaCanonicalizer.canonicalize("=A1" + whitespace + "B1"));
            } else {
                assertThrows(FormulaCanonicalizer.UnsupportedFormulaException.class,
                        () -> FormulaCanonicalizer.canonicalize("=SUM(A1" + whitespace + "B1)"),
                        String.format("U+%04X must be rejected outside literals", codePoint));
            }
            assertEquals("=\"before" + whitespace + "after\"",
                    FormulaCanonicalizer.canonicalize("=\"before" + whitespace + "after\""));
        }
    }

    @Test
    void uppercasesOnlyAsciiBuiltinFunctionNames() throws Exception {
        assertEquals("=SUM(A1)", FormulaCanonicalizer.canonicalize("=sum(A1)"));
        assertEquals("=mýFunc(A1)", FormulaCanonicalizer.canonicalize("=mýFunc(A1)"));
    }

    @Test
    void preservesExternalWorkbookReferenceForms() throws Exception {
        assertEquals("=[Budget.xlsx]Sheet1!A1+[Budget.xlsx]Sheet1!A:A",
                FormulaCanonicalizer.canonicalize("= [Budget.xlsx]Sheet1!A1 + [Budget.xlsx]Sheet1!A:A"));
        assertEquals("='C:\\Reports\\[Budget.xlsx]Q1 Data'!1:3",
                FormulaCanonicalizer.canonicalize("= 'C:\\Reports\\[Budget.xlsx]Q1 Data'!1:3"));
    }

    @Test
    void rejectsUnprovableReferenceCollisions() {
        assertThrows(FormulaCanonicalizer.UnsupportedFormulaException.class,
                () -> FormulaCanonicalizer.canonicalize("=SUM(B7:D7C6:C8)"));
        assertThrows(FormulaCanonicalizer.UnsupportedFormulaException.class,
                () -> FormulaCanonicalizer.canonicalize("=[Budget.xlsx] Q1!A1"));
    }
}
