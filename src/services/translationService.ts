const supportedLanguages = new Set(["none", "en", "de", "fr", "es"]);
const languageAliases: Record<string, string> = {
  english: "en",
  german: "de",
  french: "fr",
  spanish: "es",
  spain: "es",
  en: "en",
  de: "de",
  fr: "fr",
  es: "es"
};

export function normalizeLanguage(language: string | undefined): string {
  const raw = (language ?? "none").trim();
  const key = raw.toLowerCase();

  if (supportedLanguages.has(key)) {
    return key;
  }

  if (languageAliases[key]) {
    return languageAliases[key];
  }

  return "none";
}

function detectLikelySourceLanguage(text: string): string {
  const lower = text.toLowerCase();

  if (/[\u00e4\u00f6\u00fc\u00df]/i.test(text)) {
    return "de";
  }

  if (
    /\b(und|nicht|der|die|das|mit|von|fuer|für|noch|keine|kein|kabine|arbeiten|garantie)\b/i.test(
      lower
    )
  ) {
    return "de";
  }

  return "en";
}

function isProviderErrorText(value: string): boolean {
  const lower = value.toLowerCase();
  return (
    lower.includes("invalid source language") ||
    lower.includes("please select two distinct languages") ||
    lower.includes("example: langpair") ||
    lower.includes("response status") ||
    lower.includes("exception")
  );
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
    const response = await fetch(googleQuery.toString(), { method: "GET", signal: AbortSignal.timeout(10000) });
    if (!response.ok) {
      throw new Error(`Google translation endpoint returned ${response.status}`);
    }

    const data = (await response.json()) as unknown;
    if (!Array.isArray(data) || !Array.isArray(data[0])) {
      throw new Error("Translation provider returned no usable text");
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
    throw new Error("Translation provider returned empty text");
  } catch {
    // Try a second provider when Google endpoint fails or returns empty text.
    try {
      const mmQuery = new URL("https://api.mymemory.translated.net/get");
      mmQuery.searchParams.set("q", input.text);
      // Short German work titles often lack the words used by our heuristic.
      // For English output, attempt German-to-English rather than skipping them.
      const sourceLanguage = normalizedLanguage === "en"
        ? "de"
        : detectLikelySourceLanguage(input.text);
      if (sourceLanguage === normalizedLanguage) {
        return input.text;
      }

      mmQuery.searchParams.set("langpair", `${sourceLanguage}|${normalizedLanguage}`);

      const mmResponse = await fetch(mmQuery.toString(), { method: "GET", signal: AbortSignal.timeout(10000) });
      if (!mmResponse.ok) {
        throw new Error(`Fallback translation returned ${mmResponse.status}`);
      }

      const mmData = (await mmResponse.json()) as {
        responseData?: {
          translatedText?: string;
        };
      };

      const translated = mmData.responseData?.translatedText?.trim() || "";
      if (!translated || isProviderErrorText(translated)) {
        throw new Error("Fallback translation returned no usable text");
      }

      return translated;
    } catch (error) {
      console.warn("Title translation failed; retaining original Monday title", {
        targetLanguage: normalizedLanguage, error: error instanceof Error ? error.message : String(error)
      });
      return input.text;
    }
  }

  return input.text;
}
