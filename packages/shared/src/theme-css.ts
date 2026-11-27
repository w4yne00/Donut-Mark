export const maxThemeCssBytes = 1024 * 1024;

export function isThemeCssFileName(name: unknown): name is string {
  return typeof name === "string" && name.length > 4 && name.toLowerCase().endsWith(".css") && !/[\\/:\p{Cc}]/u.test(name);
}
