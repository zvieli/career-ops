// @ts-check
/** Only return a GPA scale when the same scale is explicit in source text. */
export function extractExplicitGpaScale(text, expectedValue) {
  const value = Number(expectedValue);
  if (!Number.isFinite(value)) return null;
  const pattern = /\bGPA\b[^\n]{0,100}?\b(\d+(?:\.\d+)?)\s*(?:\/|out of)\s*(100|4(?:\.0)?|5(?:\.0)?)/i;
  const match = String(text || '').match(pattern);
  if (!match || Math.abs(Number(match[1]) - value) > 0.0001) return null;
  return Number(match[2]) === 100 ? '100-point' : `${Number(match[2]).toFixed(1)}-point`;
}
