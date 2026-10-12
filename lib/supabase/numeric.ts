// Generated types call numeric columns `number`, but PostgREST accepts exact
// decimal strings and we never let money become a float. Wrap money strings
// with this when writing; when reading, select money as text (`amount::text`).
export function numeric(amount: string): number {
  return amount as unknown as number;
}
