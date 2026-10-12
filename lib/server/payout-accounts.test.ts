import { describe, expect, it } from "vitest";
import { describeRequirement } from "./payout-accounts";

describe("describeRequirement", () => {
  it("turns provider requirement keys into plain words", () => {
    expect(describeRequirement("persons.per_3a91c0d7.id_document")).toBe("Photo of your ID");
    expect(describeRequirement("persons.per_1.id_number")).toBe("NIN (National Identification Number)");
    expect(describeRequirement("persons.bvn")).toBe("BVN");
    expect(describeRequirement("payout_destination")).toBe("Bank account");
    expect(describeRequirement("company.registration_number")).toBe("registration number");
  });
});
