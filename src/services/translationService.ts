const supportedLanguages = new Set([
  "none",
  "en",
  "de",
  "fr",
  "es",
  "it",
  "nl",
  "pl",
  "pt",
  "sv",
  "da",
  "no",
  "fi",
  "cs",
  "sk",
  "sl",
  "hr",
  "hu",
  "ro",
  "bg",
  "el",
  "tr"
]);

function normalizeLanguage(language: string | undefined): string {
  const code = (language ?? "none").trim().toLowerCase();
  if (supportedLanguages.has(code)) {
    return code;
  }

  return "none";
}

export async function translateText(input: {
  text: string;
  targetLanguage?: string;
}): Promise<string> {
  const normalizedLanguage = normalizeLanguage(input.targetLanguage);
  if (normalizedLanguage === "none") {
    return input.text;
  }

  const query = new URL("https://translate.googleapis.com/translate_a/single");
  query.searchParams.set("client", "gtx");
  query.searchParams.set("sl", "auto");
  query.searchParams.set("tl", normalizedLanguage);
  query.searchParams.set("dt", "t");
  query.searchParams.set("q", input.text);

  try {
    const response = await fetch(query.toString(), { method: "GET" });
    if (!response.ok) {
      return input.text;
    }

    const data = (await response.json()) as unknown;
    if (!Array.isArray(data) || !Array.isArray(data[0])) {
      return input.text;
    }

    const translated = data[0]
      .map((part: unknown) => {
        if (!Array.isArray(part) || typeof part[0] !== "string") {
          return "";
        }

        return part[0];
      })
      .join("")
      .trim();

    return translated || input.text;
  } catch {
    return input.text;
  }
}
