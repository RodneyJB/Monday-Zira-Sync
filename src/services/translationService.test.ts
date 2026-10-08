import assert from "node:assert/strict";
import test from "node:test";
import { translateText } from "./translationService.js";

for (const primary of ["http-error", "invalid-response", "empty-response"]) {
  test(`short German title uses German-English fallback after ${primary}`, async (t) => {
    const requests: string[] = [];
    t.mock.method(globalThis, "fetch", async (url: string) => {
      requests.push(String(url));
      if (requests.length === 1) {
        if (primary === "http-error") return new Response("", { status: 429 });
        return Response.json(primary === "invalid-response" ? {} : [[]]);
      }
      assert.equal(new URL(String(url)).searchParams.get("langpair"), "de|en");
      return Response.json({ responseData: { translatedText: "Replace upholstery" } });
    });
    assert.equal(await translateText({ text: "Polster tauschen", targetLanguage: "en" }), "Replace upholstery");
    assert.equal(requests.length, 2);
  });
}

test("disabled translation does not call a provider", async (t) => {
  t.mock.method(globalThis, "fetch", () => { assert.fail("Unexpected translation request"); });
  assert.equal(await translateText({ text: "Polster tauschen", targetLanguage: "none" }), "Polster tauschen");
});