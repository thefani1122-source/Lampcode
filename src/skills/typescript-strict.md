# TypeScript Strict Mode Patterns

## Never Use `any`
- Replace `any` with `unknown` and add a type guard before use
- Use generics (`<T>`) for functions that work across multiple types
- Use `Record<string, unknown>` for truly arbitrary objects, then narrow with `instanceof` or `in`

## Prefer `interface` for Objects, `type` for Unions
```ts
// Object shapes → interface
interface User { id: string; email: string; }

// Unions, mapped types, template literals → type
type Status = "idle" | "loading" | "error";
type EventMap = { [K in Status]: () => void };
```

## Discriminated Unions for Variants
```ts
type Result<T> =
  | { success: true; data: T }
  | { success: false; error: string };

function handle<T>(result: Result<T>) {
  if (result.success) {
    console.log(result.data); // T — narrowed correctly
  } else {
    console.error(result.error);
  }
}
```

## Avoid Type Assertions
```ts
// Bad
const value = someMap.get(key) as string;

// Good
const value = someMap.get(key);
if (value === undefined) throw new Error(`Missing key: ${key}`);
```

## Use `satisfies` for Checked Literals
```ts
const config = {
  port: 3000,
  env: "production",
} satisfies Partial<Config>; // error if fields don't match Config
```

## Zod-Derived Types
```ts
import { z } from "zod";

const userSchema = z.object({ id: z.string(), email: z.string().email() });
type User = z.infer<typeof userSchema>; // never write this type manually
```

## Readonly for Immutable Data
```ts
function processItems(items: readonly string[]): void { ... }
type Config = Readonly<{ host: string; port: number }>;
```

## Explicit Return Types on Exports
```ts
// Always annotate exported functions
export function createUser(input: CreateUserInput): Promise<User> { ... }
```

## Strict Null Checks
- Never access properties on values that could be `undefined` without a guard
- Use optional chaining (`?.`) and nullish coalescing (`??`) rather than `||` (which coerces falsy)
- Prefer early returns over deeply nested conditionals for null checks
