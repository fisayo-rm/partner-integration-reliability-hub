export class FixedClock {
  public constructor(private readonly instant: Date) {}
  public now(): Date {
    return new Date(this.instant);
  }
}
export class SequenceRandom {
  private index = 0;
  public constructor(private readonly values: readonly number[]) {}
  public next(): number {
    const value = this.values[this.index++];
    if (value === undefined || value < 0 || value >= 1)
      throw new Error("SequenceRandom requires values in [0, 1).");
    return value;
  }
}
export class SequenceIdGenerator {
  private index = 0;
  public constructor(private readonly ulids: readonly string[]) {}
  public next(prefix: string): string {
    const ulid = this.ulids[this.index++];
    if (ulid === undefined) throw new Error("No deterministic IDs remain.");
    return `${prefix}_${ulid}`;
  }
}

import type { TenantContext } from "@pirh/domain";

/** Reuses one assertion shape for tenant-bound repository and API security tests. */
export async function expectTenantIsolation<T>(input: {
  readonly owner: TenantContext;
  readonly intruder: TenantContext;
  readonly operation: (context: TenantContext) => Promise<T | undefined>;
}): Promise<void> {
  const owner = await input.operation(input.owner);
  const intruder = await input.operation(input.intruder);
  if (owner === undefined)
    throw new Error("The owner context must resolve its own resource.");
  if (intruder !== undefined)
    throw new Error("Cross-tenant operation leaked a resource.");
}
