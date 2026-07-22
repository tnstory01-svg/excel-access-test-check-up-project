package local.grader;

import java.math.BigDecimal;
import java.text.Normalizer;
import java.util.ArrayList;
import java.util.List;
import java.util.Locale;
import java.util.Objects;
import org.apache.poi.ss.usermodel.BorderStyle;
import org.apache.poi.ss.usermodel.Cell;
import org.apache.poi.ss.usermodel.CellStyle;
import org.apache.poi.ss.usermodel.CellType;
import org.apache.poi.ss.usermodel.Color;
import org.apache.poi.ss.usermodel.DateUtil;
import org.apache.poi.ss.usermodel.ExtendedColor;
import org.apache.poi.ss.usermodel.FillPatternType;
import org.apache.poi.ss.usermodel.Font;
import org.apache.poi.ss.usermodel.HorizontalAlignment;
import org.apache.poi.ss.usermodel.Row;
import org.apache.poi.ss.usermodel.Sheet;
import org.apache.poi.ss.usermodel.VerticalAlignment;
import org.apache.poi.ss.usermodel.Workbook;

/** Deterministic, non-evaluating POI evidence extraction. */
public final class ExcelExtractor {
    public static final int MAX_CHECKS_PER_WORKBOOK = 50_000;
    public static final int MAX_CHECKS_PER_SHEET = 10_000;

    private ExcelExtractor() {
    }

    public static Extraction extract(Workbook workbook) {
        return extract(workbook, MAX_CHECKS_PER_WORKBOOK, MAX_CHECKS_PER_SHEET);
    }

    public static Extraction extract(Workbook workbook, int workbookCap, int sheetCap) {
        if (workbookCap < 0 || sheetCap < 0) throw new IllegalArgumentException("caps must be non-negative");
        List<CellEvidence> evidence = new ArrayList<>();
        List<Diagnostic> diagnostics = new ArrayList<>();
        int global = 0;
        int workbookCandidates = 0;
        for (int sheetIndex = 0; sheetIndex < workbook.getNumberOfSheets(); sheetIndex++) {
            Sheet sheet = workbook.getSheetAt(sheetIndex);
            int sheetEmitted = 0;
            int sheetCandidates = 0;
            for (Row row : sheet) {
                for (Cell cell : row) {
                    if (isMergedNonTopLeft(sheet, cell)) continue;
                    List<CellEvidence> candidates = evidenceFor(workbook, sheetIndex, sheet.getSheetName(), cell);
                    sheetCandidates += candidates.size();
                    workbookCandidates += candidates.size();
                    for (CellEvidence candidate : candidates) {
                        if (sheetEmitted >= sheetCap || global >= workbookCap) continue;
                        evidence.add(candidate);
                        sheetEmitted++;
                        global++;
                    }
                }
            }
            if (sheetCandidates > sheetEmitted) {
                diagnostics.add(new Diagnostic("DRAFT_CANDIDATE_CAP_REACHED", sheetIndex, sheetCandidates, sheetEmitted,
                        sheetCandidates - sheetEmitted));
            }
        }
        if (workbookCandidates > global) {
            diagnostics.add(new Diagnostic("DRAFT_CANDIDATE_CAP_REACHED", -1, workbookCandidates, global,
                    workbookCandidates - global));
        }
        return new Extraction(List.copyOf(evidence), List.copyOf(diagnostics));
    }

    private static List<CellEvidence> evidenceFor(Workbook workbook, int sheetIndex, String sheetName, Cell cell) {
        List<CellEvidence> result = new ArrayList<>();
        CellType type = cell.getCellType();
        boolean nonEmpty = type != CellType.BLANK;
        if (nonEmpty) {
            ValueEvidence value = value(workbook, cell);
            result.add(new CellEvidence(sheetIndex, sheetName, cell.getRowIndex(), cell.getColumnIndex(), "value",
                    value.value(), value.diagnostic()));
        }
        if (type == CellType.FORMULA) {
            try {
                result.add(new CellEvidence(sheetIndex, sheetName, cell.getRowIndex(), cell.getColumnIndex(), "formula",
                        FormulaCanonicalizer.canonicalize("=" + cell.getCellFormula()), null));
            } catch (FormulaCanonicalizer.UnsupportedFormulaException exception) {
                result.add(new CellEvidence(sheetIndex, sheetName, cell.getRowIndex(), cell.getColumnIndex(), "formula", null,
                        "CAPABILITY_UNSUPPORTED:" + exception.getMessage()));
            }
        }
        CellStyle style = cell.getCellStyle();
        if (style == null) return result;
        if (style.getDataFormat() != 0) result.add(numberFormatEvidence(sheetIndex, sheetName, cell, style.getDataFormatString()));
        Font font = workbook.getFontAt(style.getFontIndex());
        if (style.getFontIndex() != 0) result.add(fontEvidence(sheetIndex, sheetName, cell, font));
        if (style.getFillPattern() != FillPatternType.NO_FILL) result.add(fillEvidence(sheetIndex, sheetName, cell, style));
        if (hasBorder(style)) result.add(unsupportedStyleEvidence(sheetIndex, sheetName, cell, "border",
                "diagonal border details are not supported"));
        if (hasAlignment(style)) result.add(styleEvidence(sheetIndex, sheetName, cell, "alignment", alignmentEvidence(style)));
        return result;
    }
    private static CellEvidence numberFormatEvidence(int sheetIndex, String sheetName, Cell cell, String formatCode) {
        if (formatCode == null || formatCode.isEmpty()) {
            return unsupportedStyleEvidence(sheetIndex, sheetName, cell, "number-format", "number format is unresolved");
        }
        return styleEvidence(sheetIndex, sheetName, cell, "number-format", text(formatCode));
    }


    private static CellEvidence styleEvidence(int sheetIndex, String sheetName, Cell cell, String kind, String value) {
        return new CellEvidence(sheetIndex, sheetName, cell.getRowIndex(), cell.getColumnIndex(), kind, value, null);
    }

    private static ValueEvidence value(Workbook workbook, Cell cell) {
        CellType type = cell.getCellType() == CellType.FORMULA ? cell.getCachedFormulaResultType() : cell.getCellType();
        return switch (type) {
            case STRING -> new ValueEvidence("string:" + text(cell.getStringCellValue()), null);
            case BOOLEAN -> new ValueEvidence("boolean:" + cell.getBooleanCellValue(), null);
            case ERROR -> new ValueEvidence("error:" + cell.getErrorCellValue(), null);
            case NUMERIC -> numericValue(workbook, cell);
            case BLANK, FORMULA, _NONE -> new ValueEvidence("blank", null);
        };
    }

    private static ValueEvidence numericValue(Workbook workbook, Cell cell) {
        double numeric = cell.getNumericCellValue();
        if (!Double.isFinite(numeric)) return new ValueEvidence(null, "CAPABILITY_UNSUPPORTED:non-finite numeric value");
        if (!DateUtil.isCellDateFormatted(cell)) {
            return new ValueEvidence("number:" + BigDecimal.valueOf(numeric).stripTrailingZeros().toPlainString(), null);
        }
        boolean date1904 = uses1904DateWindowing(workbook);
        if (!date1904 && numeric >= 60.0d && numeric < 61.0d) {
            String time = DateUtil.getLocalDateTime(numeric, false).toLocalTime().toString();
            return new ValueEvidence("date:1900-02-29" + (numeric == 60.0d ? "" : "T" + time), null);
        }
        return new ValueEvidence("date:" + DateUtil.getLocalDateTime(numeric, date1904), null);
    }

    private static boolean uses1904DateWindowing(Workbook workbook) {
        if (workbook instanceof org.apache.poi.xssf.usermodel.XSSFWorkbook xssfWorkbook) return xssfWorkbook.isDate1904();
        if (workbook instanceof org.apache.poi.hssf.usermodel.HSSFWorkbook hssfWorkbook) {
            return hssfWorkbook.getWorkbook().isUsing1904DateWindowing();
        }
        return false;
    }

    private static String text(String value) {
        return Normalizer.normalize(value.replace("\r\n", "\n").replace('\r', '\n'), Normalizer.Form.NFC);
    }

    private static boolean hasBorder(CellStyle style) {
        return style.getBorderTop() != BorderStyle.NONE || style.getBorderRight() != BorderStyle.NONE
                || style.getBorderBottom() != BorderStyle.NONE || style.getBorderLeft() != BorderStyle.NONE;
    }

    private static boolean hasAlignment(CellStyle style) {
        return style.getAlignment() != HorizontalAlignment.GENERAL || style.getVerticalAlignment() != VerticalAlignment.BOTTOM
                || style.getWrapText() || style.getRotation() != 0 || style.getIndention() != 0 || style.getShrinkToFit();
    }

    private static CellEvidence fontEvidence(int sheetIndex, String sheetName, Cell cell, Font font) {
        String color = fontColor(font);
        if (color == null) return unsupportedStyleEvidence(sheetIndex, sheetName, cell, "font",
                "font color is indexed, themed, or unresolved");
        return styleEvidence(sheetIndex, sheetName, cell, "font",
                "name=" + text(font.getFontName()) + ";sizePt=" + font.getFontHeightInPoints() + ";bold=" + font.getBold()
                        + ";italic=" + font.getItalic() + ";underline=" + font.getUnderline() + ";strikeout=" + font.getStrikeout()
                        + ";colorArgb=" + color);
    }

    private static CellEvidence fillEvidence(int sheetIndex, String sheetName, Cell cell, CellStyle style) {
        String foreground = color(style.getFillForegroundColorColor());
        String background = color(style.getFillBackgroundColorColor());
        if (foreground == null || background == null) return unsupportedStyleEvidence(sheetIndex, sheetName, cell, "fill",
                "fill color is indexed, themed, or unresolved");
        return styleEvidence(sheetIndex, sheetName, cell, "fill", "patternType=" + style.getFillPattern().name()
                + ";foregroundColorArgb=" + foreground + ";backgroundColorArgb=" + background);
    }

    private static CellEvidence unsupportedStyleEvidence(int sheetIndex, String sheetName, Cell cell, String kind, String reason) {
        return new CellEvidence(sheetIndex, sheetName, cell.getRowIndex(), cell.getColumnIndex(), kind, null,
                "CAPABILITY_UNSUPPORTED:" + reason);
    }
    private static String alignmentEvidence(CellStyle style) {
        return "horizontal=" + style.getAlignment().name() + ";vertical=" + style.getVerticalAlignment().name()
                + ";wrapText=" + style.getWrapText() + ";textRotation=" + style.getRotation()
                + ";indent=" + style.getIndention() + ";shrinkToFit=" + style.getShrinkToFit();
    }
    private static String fontColor(Font font) {
        if (font instanceof org.apache.poi.xssf.usermodel.XSSFFont xssfFont) return color(xssfFont.getXSSFColor());
        return null;
    }

    private static String color(Color color) {
        if (!(color instanceof ExtendedColor extended) || extended.isIndexed() || extended.isThemed()) return null;
        String argb = extended.getARGBHex();
        return argb == null ? null : argb.toUpperCase(Locale.ROOT);
    }

    private static boolean isMergedNonTopLeft(Sheet sheet, Cell cell) {
        return sheet.getMergedRegions().stream().anyMatch(region -> region.isInRange(cell.getRowIndex(), cell.getColumnIndex())
                && (region.getFirstRow() != cell.getRowIndex() || region.getFirstColumn() != cell.getColumnIndex()));
    }

    public record Extraction(List<CellEvidence> evidence, List<Diagnostic> diagnostics) { }
    public record CellEvidence(int sheetIndex, String sheetName, int row, int column, String kind, String value, String diagnostic) {
        public CellEvidence { Objects.requireNonNull(sheetName); Objects.requireNonNull(kind); }
    }
    private record ValueEvidence(String value, String diagnostic) { }

    public record Diagnostic(String code, int sheetIndex, int candidates, int emitted, int omitted) { }
}
