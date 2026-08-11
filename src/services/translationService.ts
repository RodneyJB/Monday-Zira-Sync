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

  const googleQuery = new URL("https://translate.googleapis.com/translate_a/single");
  googleQuery.searchParams.set("client", "gtx");
  googleQuery.searchParams.set("sl", "auto");
  googleQuery.searchParams.set("tl", normalizedLanguage);
  googleQuery.searchParams.set("dt", "t");
  googleQuery.searchParams.set("q", input.text);

  try {
    const response = await fetch(googleQuery.toString(), { method: "GET" });
    if (!response.ok) {
      throw new Error(`Google translation endpoint returned ${response.status}`);
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

    if (translated) {
      return translated;
    }
  } catch {
    // Try a second provider when Google endpoint fails or returns empty text.
    try {
      const mmQuery = new URL("https://api.mymemory.translated.net/get");
      mmQuery.searchParams.set("q", input.text);
      mmQuery.searchParams.set("langpair", `auto|${normalizedLanguage}`);

      const mmResponse = await fetch(mmQuery.toString(), { method: "GET" });
      if (!mmResponse.ok) {
        return input.text;
      }

      const mmData = (await mmResponse.json()) as {
        responseData?: {
          translatedText?: string;
        };
      };

      const translated = mmData.responseData?.translatedText?.trim();
      return translated || input.text;
    } catch {
      return input.text;
    }
  }

  return input.text;
}
