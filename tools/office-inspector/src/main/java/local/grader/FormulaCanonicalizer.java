package local.grader;


/** Canonicalizes only formulas whose lexical meaning can be established without evaluation. */
public final class FormulaCanonicalizer {
    private FormulaCanonicalizer() {
    }

    public static String canonicalize(String formula) throws UnsupportedFormulaException {
        if (formula == null || formula.isEmpty() || formula.charAt(0) != '=') {
            throw new UnsupportedFormulaException("formula must begin with '='");
        }
        StringBuilder result = new StringBuilder("=");
        int index = 1;
        boolean previousCanIntersect = false;
        while (index < formula.length()) {
            char character = formula.charAt(index);
            if (isWhitespace(character)) {
                if (character != ' ') {
                    throw new UnsupportedFormulaException("only ASCII spaces are supported outside string literals");
                }
                int end = skipAsciiSpaces(formula, index);
                if (previousCanIntersect && startsIntersectionOperand(formula, end)) {
                    result.append(' ');
                } else if (previousCanIntersect && end < formula.length() && formula.charAt(end) == '(') {
                    throw new UnsupportedFormulaException("parenthesized reference intersection is unsupported");
                }
                index = end;
                continue;
            }
            if (character == '"') {
                int end = consumeString(formula, index);
                result.append(formula, index, end);
                index = end;
                previousCanIntersect = false;
                continue;
            }

            Token token = consumeToken(formula, index);
            if (token != null) {
                int next = skipAsciiSpaces(formula, token.end);
                String value = formula.substring(index, token.end);
                boolean isFunction = token.category == TokenCategory.NAME && next < formula.length()
                        && formula.charAt(next) == '(';
                result.append(isFunction ? uppercaseAsciiFunction(value) : value);
                previousCanIntersect = token.category.canIntersect() && !isFunction;
                index = token.end;
                continue;
            }
            if (character == '[') {
                throw new UnsupportedFormulaException("unqualified external workbook reference");
            }
            result.append(character);
            previousCanIntersect = character == ')';
            index++;
        }
        return result.toString();
    }

    private enum TokenCategory {
        REFERENCE,
        NAME;

        boolean canIntersect() {
            return true;
        }
    }

    private record Token(int end, TokenCategory category) {
    }

    private enum ReferenceUnit {
        CELL,
        COLUMN,
        ROW
    }

    private static int consumeString(String value, int start) throws UnsupportedFormulaException {
        for (int index = start + 1; index < value.length(); index++) {
            if (value.charAt(index) == '"') {
                if (index + 1 < value.length() && value.charAt(index + 1) == '"') {
                    index++;
                } else {
                    return index + 1;
                }
            }
        }
        throw new UnsupportedFormulaException("unterminated string literal");
    }

    private static Token consumeToken(String value, int start) throws UnsupportedFormulaException {
        char character = value.charAt(start);
        if (character == '\'') {
            return new Token(consumeQuotedReference(value, start), TokenCategory.REFERENCE);
        }
        if (character == '[') {
            return new Token(consumeExternalReference(value, start), TokenCategory.REFERENCE);
        }
        if (Character.isDigit(character) || character == '$' || isIdentifierStart(character)) {
            Token reference = consumeReference(value, start);
            if (reference != null) return reference;
            if (!isIdentifierStart(character)) return null;

            int end = start + 1;
            while (end < value.length() && isIdentifierPart(value.charAt(end))) end++;
            while (end < value.length() && value.charAt(end) == '[') end = consumeBracket(value, end);
            if (end < value.length() && value.charAt(end) == '!') {
                return new Token(consumeReferenceTail(value, end + 1), TokenCategory.REFERENCE);
            }
            return new Token(end, TokenCategory.NAME);
        }
        return null;
    }

    private static int consumeQuotedReference(String value, int start) throws UnsupportedFormulaException {
        int index = start + 1;
        while (index < value.length()) {
            if (value.charAt(index) == '\'') {
                if (index + 1 < value.length() && value.charAt(index + 1) == '\'') {
                    index += 2;
                    continue;
                }
                index++;
                if (index >= value.length() || value.charAt(index) != '!') {
                    throw new UnsupportedFormulaException("quoted token is not a sheet reference");
                }
                return consumeReferenceTail(value, index + 1);
            }
            index++;
        }
        throw new UnsupportedFormulaException("unterminated quoted sheet reference");
    }

    private static int consumeExternalReference(String value, int start) throws UnsupportedFormulaException {
        int bookEnd = value.indexOf(']', start + 1);
        if (bookEnd == start + 1) throw new UnsupportedFormulaException("empty external workbook reference");
        if (bookEnd < 0) throw new UnsupportedFormulaException("unterminated external workbook reference");
        int sheetStart = bookEnd + 1;
        if (sheetStart >= value.length() || !isIdentifierStart(value.charAt(sheetStart))) {
            throw new UnsupportedFormulaException("external workbook reference requires an unquoted sheet name");
        }
        int index = sheetStart + 1;
        while (index < value.length() && isIdentifierPart(value.charAt(index))) index++;
        if (index >= value.length() || value.charAt(index) != '!') {
            throw new UnsupportedFormulaException("external workbook reference requires a sheet reference");
        }
        return consumeReferenceTail(value, index + 1);
    }

    private static int consumeReferenceTail(String value, int index) throws UnsupportedFormulaException {
        Token reference = consumeReference(value, index);
        if (reference == null) throw new UnsupportedFormulaException("sheet reference requires a cell or range");
        return reference.end;
    }

    private static Token consumeReference(String value, int start) throws UnsupportedFormulaException {
        Unit first = consumeReferenceUnit(value, start);
        if (first == null) return null;
        int end = first.end;
        if (end < value.length() && value.charAt(end) == ':') {
            Unit second = consumeReferenceUnit(value, end + 1);
            if (second == null || second.type != first.type) {
                throw new UnsupportedFormulaException("invalid reference range");
            }
            end = second.end;
        } else if (first.type != ReferenceUnit.CELL) {
            return null;
        }
        if (end < value.length() && (Character.isLetterOrDigit(value.charAt(end)) || value.charAt(end) == '$')) {
            throw new UnsupportedFormulaException("ambiguous adjacent reference");
        }
        return new Token(end, TokenCategory.REFERENCE);
    }

    private record Unit(int end, ReferenceUnit type) {
    }

    private static Unit consumeReferenceUnit(String value, int start) {
        int index = start;
        if (index < value.length() && value.charAt(index) == '$') index++;
        int letters = index;
        while (index < value.length() && Character.isLetter(value.charAt(index)) && index - letters < 3) index++;
        if (index < value.length() && Character.isLetter(value.charAt(index))) return null;
        if (index > letters) {
            if (index < value.length() && value.charAt(index) == '$') index++;
            int digits = index;
            while (index < value.length() && Character.isDigit(value.charAt(index))) index++;
            return new Unit(index, digits == index ? ReferenceUnit.COLUMN : ReferenceUnit.CELL);
        }
        index = start;
        if (index < value.length() && value.charAt(index) == '$') index++;
        int digits = index;
        while (index < value.length() && Character.isDigit(value.charAt(index))) index++;
        return digits == index ? null : new Unit(index, ReferenceUnit.ROW);
    }

    private static int consumeBracket(String value, int start) throws UnsupportedFormulaException {
        int depth = 1;
        for (int index = start + 1; index < value.length(); index++) {
            if (value.charAt(index) == '[') depth++;
            if (value.charAt(index) == ']' && --depth == 0) return index + 1;
        }
        throw new UnsupportedFormulaException("unterminated structured reference");
    }

    private static boolean startsIntersectionOperand(String value, int index) {
        if (index >= value.length()) return false;
        char character = value.charAt(index);
        return character == '\'' || character == '[' || character == '$'
                || Character.isDigit(character) || isIdentifierStart(character);
    }

    private static int skipAsciiSpaces(String value, int index) {
        while (index < value.length() && value.charAt(index) == ' ') index++;
        return index;
    }

    private static boolean isWhitespace(char value) {
        return (value >= 0x0009 && value <= 0x000D) || value == 0x0020 || value == 0x0085
                || value == 0x00A0 || value == 0x1680 || (value >= 0x2000 && value <= 0x200A)
                || value == 0x2028 || value == 0x2029 || value == 0x202F || value == 0x205F
                || value == 0x3000;
    }

    private static String uppercaseAsciiFunction(String value) {
        for (int index = 0; index < value.length(); index++) {
            if (value.charAt(index) > 0x7f) return value;
        }
        StringBuilder normalized = new StringBuilder(value.length());
        for (int index = 0; index < value.length(); index++) {
            char character = value.charAt(index);
            normalized.append(character >= 'a' && character <= 'z'
                    ? (char) (character - ('a' - 'A')) : character);
        }
        return normalized.toString();
    }

    private static boolean isIdentifierStart(char value) {
        return Character.isLetter(value) || value == '_';
    }

    private static boolean isIdentifierPart(char value) {
        return Character.isLetterOrDigit(value) || value == '_' || value == '.';
    }

    public static final class UnsupportedFormulaException extends Exception {
        public UnsupportedFormulaException(String message) {
            super(message);
        }
    }
}
