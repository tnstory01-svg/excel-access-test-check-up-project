export const CAPABILITY_IDS = [
  "excel.cell.value.v1",
  "excel.cell.formula.stored.v1",
  "excel.style.number-format.v1",
  "excel.style.font.v1",
  "excel.style.fill.v1",
  "excel.style.border.v1",
  "excel.style.alignment.v1",
  "access.table.schema.v1",
  "access.field.property.v1",
  "access.primary-key.v1",
  "access.index.v1",
  "access.relationship.v1",
  "access.query.definition.v1",
  "access.query.result.v1",
] as const;

export type CapabilityId = (typeof CAPABILITY_IDS)[number];

const capabilityIds = new Set<string>(CAPABILITY_IDS);

export function isCapabilityId(value: unknown): value is CapabilityId {
  return typeof value === "string" && capabilityIds.has(value);
}

export function assertCapabilityId(value: unknown): asserts value is CapabilityId {
  if (!isCapabilityId(value)) {
    throw new Error(`Unknown capability ID: ${String(value)}`);
  }
}

export function capabilityFamily(capabilityId: CapabilityId): "excel" | "access" {
  return capabilityId.startsWith("excel.") ? "excel" : "access";
}
