import { describe, expect, it } from "vitest";
import { checkText } from "./word-filter";

describe("checkText", () => {
  it.each([
    "Happy birthday Tolu! 🎉",
    "Table 7 don scatter the place",
    "Big ups to the class of 2016",
    "Greetings from Scunthorpe",
    "Assessment week done!",
    "Cocktail o'clock",
    "Shout out to Dickson and Hassan",
    "Omo Lagos! Ojuelegba vibes",
    "Peacock in the building",
  ])("allows %s", (text) => {
    expect(checkText(text)).toEqual({ ok: true });
  });

  it.each([
    "fuck this",
    "FUUUCK",
    "f u c k",
    "f.u.c.k",
    "fuk off",
    "you cunt",
    "motherfuckers",
    "you bitch",
    "sh1t",
    "$hit",
    "s h i t",
    "ashawo",
    "you be ashewo",
    "omo ale",
    "OmoAle",
    "nyamiri",
  ])("blocks %s", (text) => {
    expect(checkText(text)).toEqual({ ok: false, reason: "language" });
  });

  it.each([
    "call me 08012345678",
    "0801 234 5678",
    "+234-801-234-5678",
    "follow @tolu_vibes",
    "www.mysite.com",
    "https://example.com",
    "check tolu.ng",
  ])("blocks contact details: %s", (text) => {
    expect(checkText(text)).toEqual({ ok: false, reason: "contact" });
  });

  it("allows short numbers like tables, ages and years", () => {
    expect(checkText("Table 12 says happy 30th! Class of 2016")).toEqual({ ok: true });
  });
});
