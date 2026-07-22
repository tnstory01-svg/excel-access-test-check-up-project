package local.grader;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertTrue;
import org.apache.poi.ss.usermodel.BorderStyle;
import org.apache.poi.ss.usermodel.FillPatternType;
import org.apache.poi.xssf.usermodel.XSSFWorkbook;
import org.junit.jupiter.api.Test;

final class ExcelExtractorTest {
    @Test
    void emitsFormulaAndNonDefaultStyleInCellOrder() throws Exception {
        try (XSSFWorkbook workbook = new XSSFWorkbook()) {
            var sheet = workbook.createSheet("Evidence");
            var cell = sheet.createRow(0).createCell(0);
            cell.setCellFormula("sum(B1:C1)");
            cell.setCellValue(0.0);
            var style = workbook.createCellStyle();
            style.setWrapText(true);
            cell.setCellStyle(style);

            ExcelExtractor.Extraction extraction = ExcelExtractor.extract(workbook);
            assertEquals("value", extraction.evidence().get(0).kind());
            assertEquals("number:0", extraction.evidence().get(0).value());
            assertEquals("formula", extraction.evidence().get(1).kind());
            assertEquals("=SUM(B1:C1)", extraction.evidence().get(1).value());
            assertEquals("alignment", extraction.evidence().get(2).kind());
        }
    }

    @Test
    void reportsDeterministicCaps() throws Exception {
        try (XSSFWorkbook workbook = new XSSFWorkbook()) {
            var sheet = workbook.createSheet("Cap");
            sheet.createRow(0).createCell(0).setCellValue("first");
            sheet.createRow(1).createCell(0).setCellValue("second");
            ExcelExtractor.Extraction extraction = ExcelExtractor.extract(workbook, 1, 1);
            assertEquals(1, extraction.evidence().size());
            assertEquals(0, extraction.evidence().getFirst().row());
            assertEquals(2, extraction.diagnostics().size());
            assertEquals(-1, extraction.diagnostics().get(1).sheetIndex());
            assertEquals(2, extraction.diagnostics().get(1).candidates());
            assertTrue(extraction.diagnostics().getFirst().omitted() > 0);
        }
    }
    @Test
    void normalizesTextAndUsesCachedFormulaValueKinds() throws Exception {
        try (XSSFWorkbook workbook = new XSSFWorkbook()) {
            var sheet = workbook.createSheet("Evidence");
            sheet.createRow(0).createCell(0).setCellValue("e\u0301\r\nline");
            var formula = sheet.createRow(1).createCell(0);
            formula.setCellFormula("\"cached\"");
            formula.setCellValue("cached");

            var evidence = ExcelExtractor.extract(workbook).evidence();
            assertEquals("string:é\nline", evidence.get(0).value());
            assertEquals("string:cached", evidence.get(1).value());
            assertEquals("formula", evidence.get(2).kind());
        }
    }

    @Test
    void canonicalizesDateWindowingAndLeapDaySentinel() throws Exception {
        try (XSSFWorkbook workbook = new XSSFWorkbook()) {
            var sheet = workbook.createSheet("Dates");
            var style = workbook.createCellStyle();
            style.setDataFormat((short) 14);
            var beforeSentinel = sheet.createRow(0).createCell(0);
            beforeSentinel.setCellValue(59.5);
            beforeSentinel.setCellStyle(style);
            var sentinel = sheet.createRow(1).createCell(0);
            sentinel.setCellValue(60.0);
            sentinel.setCellStyle(style);
            var fractionalSentinel = sheet.createRow(2).createCell(0);
            fractionalSentinel.setCellValue(60.5);
            fractionalSentinel.setCellStyle(style);
            var afterSentinel = sheet.createRow(3).createCell(0);
            afterSentinel.setCellValue(61.0);
            afterSentinel.setCellStyle(style);
            var evidence = ExcelExtractor.extract(workbook).evidence();
            assertEquals("date:1900-02-28T12:00", evidence.get(0).value());
            assertEquals("date:1900-02-29", evidence.get(2).value());
            assertEquals("date:1900-02-29T12:00", evidence.get(4).value());
            assertEquals("date:1900-03-01T00:00", evidence.get(6).value());
        }
        try (XSSFWorkbook workbook = new XSSFWorkbook()) {
            workbook.getCTWorkbook().getWorkbookPr().setDate1904(true);
            var sheet = workbook.createSheet("Dates");
            var style = workbook.createCellStyle();
            style.setDataFormat((short) 14);
            var cell = sheet.createRow(0).createCell(0);
            cell.setCellValue(0.0);
            cell.setCellStyle(style);
            assertEquals("date:1904-01-01T00:00", ExcelExtractor.extract(workbook).evidence().getFirst().value());
        }
    }
    @Test
    void canonicalizesNumberFormatsAndRejectsUnresolvedCodes() throws Exception {
        try (XSSFWorkbook workbook = new XSSFWorkbook()) {
            var sheet = workbook.createSheet("Formats");
            var canonical = workbook.createCellStyle();
            canonical.setDataFormat(workbook.createDataFormat().getFormat("\"e\u0301\""));
            var canonicalCell = sheet.createRow(0).createCell(0);
            canonicalCell.setCellValue(1.0);
            canonicalCell.setCellStyle(canonical);
            var unresolved = workbook.createCellStyle();
            unresolved.setDataFormat((short) 32767);
            var unresolvedCell = sheet.createRow(1).createCell(0);
            unresolvedCell.setCellValue(2.0);
            unresolvedCell.setCellStyle(unresolved);

            var evidence = ExcelExtractor.extract(workbook).evidence();
            assertEquals("\"é\"", evidence.get(1).value());
            assertEquals(null, evidence.get(3).value());
            assertEquals("CAPABILITY_UNSUPPORTED:number format is unresolved", evidence.get(3).diagnostic());
        }
    }

    @Test
    void rejectsUnsupportedColorAndDiagonalBorderEvidence() throws Exception {
        try (XSSFWorkbook workbook = new XSSFWorkbook()) {
            var sheet = workbook.createSheet("Styles");
            var fill = workbook.createCellStyle();
            fill.setFillPattern(FillPatternType.SOLID_FOREGROUND);
            fill.setFillForegroundColor((short) 1);
            var fillCell = sheet.createRow(0).createCell(0);
            fillCell.setCellValue("fill");
            fillCell.setCellStyle(fill);
            var border = workbook.createCellStyle();
            border.setBorderTop(BorderStyle.THIN);
            var borderCell = sheet.createRow(1).createCell(0);
            borderCell.setCellValue("border");
            borderCell.setCellStyle(border);

            var evidence = ExcelExtractor.extract(workbook).evidence();
            assertEquals("fill", evidence.get(1).kind());
            assertEquals(null, evidence.get(1).value());
            assertTrue(evidence.get(1).diagnostic().startsWith("CAPABILITY_UNSUPPORTED:"));
            assertEquals("border", evidence.get(3).kind());
            assertEquals(null, evidence.get(3).value());
            assertTrue(evidence.get(3).diagnostic().startsWith("CAPABILITY_UNSUPPORTED:"));
        }
    }
}
