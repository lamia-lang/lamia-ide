const TURN_CONTEXT_RE = /<turn_context_json>[\s\S]*?<\/turn_context_json>/gi;
const EXEC_SUMMARY_RE = /\[execution_summary\][\s\S]*?\[\/execution_summary\]/gi;

export function sanitizeAssistantResponseText(text: string): string {
  let safe = text
    .replace(TURN_CONTEXT_RE, "")
    .replace(EXEC_SUMMARY_RE, "")
    .trim();

  // Unclosed tags — cut from the opening tag onward.
  for (const tag of ["<turn_context_json>", "[execution_summary]"]) {
    const idx = safe.toLowerCase().indexOf(tag);
    if (idx >= 0) {
      safe = safe.slice(0, idx).trimEnd();
    }
  }

  // Leaked JSON keys from internal context objects.
  for (const marker of ["\"toolCalls\"", "\"fileWrites\"", "\"responseTs\""]) {
    const idx = safe.indexOf(marker);
    if (idx >= 0) {
      safe = safe.slice(0, idx).trim();
    }
  }

  return safe;
}
