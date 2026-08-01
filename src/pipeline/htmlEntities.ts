/** Decodes the small, predictable entity set used by the direct-careers and JobServe markup. */
export function decodeHtmlEntities(value: string): string {
  return (
    value
      .replace(/&nbsp;/gi, " ")
      .replace(/&quot;/gi, '"')
      .replace(/&#39;/g, "'")
      .replace(/&pound;/gi, "£")
      .replace(/&euro;/gi, "€")
      .replace(/&lt;/gi, "<")
      .replace(/&gt;/gi, ">")
      .replace(/&#(\d+);/g, (_match, code) => String.fromCharCode(Number.parseInt(code, 10)))
      // Decode ampersands last so entities in normal markup are not decoded twice.
      .replace(/&amp;/gi, "&")
  );
}
