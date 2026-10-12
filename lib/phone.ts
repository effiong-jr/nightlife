// Nigerian mobile numbers for staff sign-in. Accepts what people type
// ("0803 123 4567", "803-123-4567", "+234 803 123 4567", "2348031234567") and
// returns E.164 ("+2348031234567"), or null if it isn't a Nigerian mobile.
// Nigerian mobile numbers are 10 digits after the country code, starting 7, 8 or 9.
export function normalizeNigerianPhone(input: string): string | null {
  const digits = input.replace(/[\s().-]/g, "");
  const match = /^(?:\+?234|0)?([789][01]\d{8})$/.exec(digits);
  return match ? `+234${match[1]}` : null;
}

// "+2348031234567" -> "0803 123 4567"
export function formatNigerianPhone(e164: string): string {
  const local = `0${e164.replace(/^\+?234/, "")}`;
  return local.length === 11 ? `${local.slice(0, 4)} ${local.slice(4, 7)} ${local.slice(7)}` : e164;
}
